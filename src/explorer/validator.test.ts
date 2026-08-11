import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext } from '@playwright/test';
import { launchBrowser, createContext } from './browser.js';
import { crawl } from './crawler.js';
import { validateModel, formatValidation } from './validator.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';

/**
 * Validator tests crawl a mutable fixture site, then mutate it and re-validate,
 * so the break-rate metric is measured against real drift rather than mocks.
 */

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;

/** Flipped between requests to simulate the app changing under the model. */
let variant: 'original' | 'renamed-testid' | 'duplicated' | 'removed' | 'client-rendered' =
  'original';

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    res.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/framed') {
      res.end(
        `<html lang="en"><body><h1>Host</h1>
         <iframe name="widget" src="/frame-inner"></iframe></body></html>`,
      );
      return;
    }
    if (path === '/frame-inner') {
      res.end('<html lang="en"><body><button data-testid="inner-cta">Inner</button></body></html>');
      return;
    }
    if (path !== '/') {
      res.end('<html lang="en"><body><h1>Other</h1></body></html>');
      return;
    }
    if (variant === 'client-rendered') {
      // Paints nothing on first byte, then fills in — the shape that makes a
      // naive validator report every selector on the page as broken.
      res.end(`<html lang="en"><body><div id="root"></div><script>
        setTimeout(function () {
          document.getElementById('root').innerHTML =
            '<h1>Home</h1><button data-testid="cta">Start</button>';
        }, 150);
      </script></body></html>`);
      return;
    }
    const button =
      variant === 'renamed-testid'
        ? '<button data-testid="cta-v2">Start</button>'
        : variant === 'duplicated'
          ? '<button data-testid="cta">Start</button><button data-testid="cta">Start</button>'
          : variant === 'removed'
            ? ''
            : '<button data-testid="cta">Start</button>';
    res.end(`<html lang="en"><body><h1>Home</h1>${button}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser({ proxyServer: '' });
  context = await createContext(browser);
}, 120_000);

afterAll(async () => {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
});

function config(): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
    explorer: { maxPages: 1 },
  });
}

async function captureModel() {
  variant = 'original';
  const result = await crawl(context, { config: config() });
  return result.model;
}

describe('validateModel', () => {
  it('reports a 100% resolve rate against an unchanged app', async () => {
    const model = await captureModel();
    const report = await validateModel(context, model);
    expect(report.pagesChecked).toBe(1);
    expect(report.selectorsChecked).toBeGreaterThan(0);
    expect(report.resolveRate).toBe(1);
    expect(report.broken).toHaveLength(0);
    expect(formatValidation(report)).toMatch(/100\.0%/);
  }, 90_000);

  it('detects a renamed test id as a broken selector with 0 matches', async () => {
    const model = await captureModel();
    variant = 'renamed-testid';
    const report = await validateModel(context, model);
    expect(report.resolveRate).toBeLessThan(1);
    const broken = report.broken.find((b) => b.strategy === 'testid');
    expect(broken?.matched).toBe(0);
    expect(formatValidation(report)).toMatch(/no match/);
  }, 90_000);

  it('detects a now-ambiguous selector as broken with >1 matches', async () => {
    const model = await captureModel();
    variant = 'duplicated';
    const report = await validateModel(context, model);
    const broken = report.broken.find((b) => b.strategy === 'testid');
    expect(broken?.matched).toBeGreaterThan(1);
    expect(formatValidation(report)).toMatch(/2 matches/);
  }, 90_000);

  it('detects a removed element', async () => {
    const model = await captureModel();
    variant = 'removed';
    const report = await validateModel(context, model);
    expect(report.resolveRate).toBeLessThan(1);
    expect(report.broken.length).toBeGreaterThan(0);
  }, 90_000);

  it('records an unreachable page instead of throwing', async () => {
    const model = await captureModel();
    const unreachable = {
      ...model,
      pages: model.pages.map((p) => ({ ...p, url: 'http://127.0.0.1:1/gone' })),
    };
    const report = await validateModel(context, unreachable, { timeoutMs: 2000 });
    expect(report.pagesUnreachable).toHaveLength(1);
    expect(report.pagesChecked).toBe(0);
    expect(formatValidation(report)).toMatch(/Unreachable pages/);
  }, 90_000);

  it('counts elements that never had a usable selector separately from drift', async () => {
    const model = await captureModel();
    const stripped = {
      ...model,
      pages: model.pages.map((p) => ({
        ...p,
        elements: p.elements.map((e) => ({
          ...e,
          // Nothing verified+unique => not drift, just never usable.
          selectorCandidates: e.selectorCandidates.map((c) => ({ ...c, unique: false })),
        })),
      })),
    };
    const report = await validateModel(context, stripped);
    expect(report.elementsWithoutUsableSelector).toBeGreaterThan(0);
    expect(report.selectorsChecked).toBe(0);
    // Rate stays 1 because nothing checkable drifted.
    expect(report.resolveRate).toBe(1);
  }, 90_000);

  it('waits for client-rendered content instead of reporting it as drift', async () => {
    variant = 'client-rendered';
    const model = (await crawl(context, { config: config() })).model;
    const button = model.pages[0]!.elements.find((e) => e.testId === 'cta');
    expect(button).toBeDefined();

    // Same app, unchanged — the only way this can fail is the validator
    // reading the page before the client has painted it.
    const report = await validateModel(context, model);
    expect(report.resolveRate).toBe(1);
    expect(report.broken).toHaveLength(0);
  }, 90_000);

  it('resolves elements inside same-origin iframes in their own frame', async () => {
    variant = 'original';
    const result = await crawl(context, {
      config: config(),
      startUrl: `${baseUrl}/framed`,
      interactionPass: false,
    });
    const framed = result.model.pages.find((p) => p.urlPattern === '/framed')!;
    const inner = framed.elements.find((e) => e.testId === 'inner-cta');
    // Captured with its frame recorded...
    expect(inner?.framePath).toEqual(['widget']);

    // ...and the validator must look for it there, not in the main frame,
    // where it would count as broken on every run.
    const report = await validateModel(context, result.model);
    expect(report.resolveRate).toBe(1);
    expect(report.broken).toHaveLength(0);
  }, 90_000);

  it('does not count a flow-captured element as drift', async () => {
    // Mirrors the saucedemo case exactly: the cart's Remove button was captured
    // by a flow that added an item, and genuinely does not exist on an empty
    // cart. Before provenance this reported 96.4% against a healthy app.
    const model = await captureModel();
    const withFlowElement = {
      ...model,
      pages: model.pages.map((p) => ({
        ...p,
        elements: [
          ...p.elements,
          {
            ...p.elements[0]!,
            id: 'el-flow-only',
            testId: 'remove-item',
            provenance: { kind: 'flow' as const, flowId: 'populated-cart', step: 0 },
            selectorCandidates: [
              {
                strategy: 'testid' as const,
                value: '[data-testid="remove-item"]',
                score: 100,
                unique: true,
                verified: true,
              },
            ],
          },
        ],
      })),
    };
    const report = await validateModel(context, withFlowElement);
    expect(report.elementsNeedingPrecondition).toBe(1);
    expect(report.resolveRate).toBe(1);
    expect(report.broken).toHaveLength(0);
    expect(formatValidation(report)).toMatch(/Needs a precondition:\s+1/);
  }, 90_000);

  it('still reports a genuinely broken page-load selector as drift', async () => {
    // The precondition exemption must not become a blanket amnesty.
    const model = await captureModel();
    variant = 'renamed-testid';
    const report = await validateModel(context, model);
    expect(report.elementsNeedingPrecondition).toBe(0);
    expect(report.broken.length).toBeGreaterThan(0);
  }, 90_000);

  it('reports a rate of 1 for an empty model rather than dividing by zero', async () => {
    const report = await validateModel(context, {
      version: '1',
      baseUrl,
      capturedAt: new Date().toISOString(),
      pages: [],
    });
    expect(report.resolveRate).toBe(1);
    expect(Number.isNaN(report.resolveRate)).toBe(false);
  }, 60_000);
});
