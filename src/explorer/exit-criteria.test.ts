import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext } from '@playwright/test';
import { launchBrowser, createContext } from './browser.js';
import { crawl } from './crawler.js';
import { validateModel } from './validator.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';
import { ScreenModelSchema } from '../schemas/screen-model.js';

/**
 * Phase 1 numeric exit criteria, measured rather than asserted by hand:
 *
 *   - a 30-page crawl completes in under 5 minutes
 *   - ≥95% of stored top-candidate selectors re-resolve on an immediate
 *     validation run
 *
 * The fixture is a 30-page server-rendered app plus a client-rendered section
 * that paints after load, so the numbers cover both the plain case and the SPA
 * case the master plan calls out.
 */

const PAGE_COUNT = 30;
/** Pages that render their content client-side, after a deliberate delay. */
const SPA_ROUTES = 4;
const RENDER_DELAY_MS = 120;

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;

/** A hub page linking to every content page, so depth stays shallow. */
function hub(): string {
  const links = Array.from(
    { length: PAGE_COUNT - 1 - SPA_ROUTES },
    (_, i) => `<a href="/p/${i}">Page ${i}</a>`,
  ).join('\n');
  const spa = Array.from({ length: SPA_ROUTES }, (_, i) => `<a href="/spa/${i}">SPA ${i}</a>`).join(
    '\n',
  );
  return `<html lang="en"><body><h1>Hub</h1>${links}${spa}
    <button data-testid="hub-action">Hub action</button></body></html>`;
}

function contentPage(n: number): string {
  return `<html lang="en"><body>
    <h1>Page ${n}</h1>
    <a href="/">Home</a>
    <button data-testid="p${n}-primary">Primary ${n}</button>
    <button data-testid="p${n}-secondary">Secondary ${n}</button>
    <label for="p${n}-field">Field ${n}</label>
    <input id="p${n}-field" name="field${n}">
    <input placeholder="Search ${n}">
    <select id="p${n}-select"><option>One</option></select>
  </body></html>`;
}

/**
 * A shell that paints nothing on first byte and fills in after a delay — the
 * shape that makes `networkidle` alone insufficient.
 */
function spaShell(n: number): string {
  return `<html lang="en"><body>
    <div id="root"></div>
    <script>
      setTimeout(function () {
        document.getElementById('root').innerHTML =
          '<h1>SPA ${n}</h1>' +
          '<a href="/">Home</a>' +
          '<button data-testid="spa${n}-cta">CTA ${n}</button>' +
          '<input placeholder="SPA search ${n}">';
      }, ${RENDER_DELAY_MS});
    </script>
  </body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    res.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/') return void res.end(hub());
    const spa = /^\/spa\/(\d+)$/.exec(path);
    if (spa !== null) return void res.end(spaShell(Number(spa[1])));
    const content = /^\/p\/(\d+)$/.exec(path);
    if (content !== null) return void res.end(contentPage(Number(content[1])));
    res.end('<html lang="en"><body><h1>404</h1></body></html>');
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
    explorer: { maxPages: PAGE_COUNT, maxDepth: 3 },
  });
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

describe('Phase 1 exit criteria', () => {
  it(`crawls ${PAGE_COUNT} pages in under 5 minutes and re-resolves ≥95% of selectors`, async () => {
    const result = await crawl(context, { config: config() });

    expect(result.model.pages).toHaveLength(PAGE_COUNT);
    expect(ScreenModelSchema.safeParse(result.model).success).toBe(true);
    expect(result.durationMs).toBeLessThan(FIVE_MINUTES_MS);

    const report = await validateModel(context, result.model);
    expect(report.pagesChecked).toBe(PAGE_COUNT);
    expect(report.selectorsChecked).toBeGreaterThan(100);
    expect(report.resolveRate).toBeGreaterThanOrEqual(0.95);

    // Printed so the exit-criteria numbers in PHASE_NOTES.md come from a run,
    // not from a guess.
    console.log(
      `[exit criteria] ${result.model.pages.length} pages in ` +
        `${(result.durationMs / 1000).toFixed(1)}s; ` +
        `${report.selectorsResolved}/${report.selectorsChecked} selectors re-resolved ` +
        `(${(report.resolveRate * 100).toFixed(1)}%)`,
    );
  }, 400_000);

  it('captures client-rendered content that only appears after load', async () => {
    const result = await crawl(context, {
      config: config(),
      startUrl: `${baseUrl}/spa/0`,
      interactionPass: false,
    });
    const spaPage = result.model.pages.find((p) => p.urlPattern === '/spa/0')!;
    const testIds = spaPage.elements.map((e) => e.testId);
    // Without the DOM-stability wait the shell is empty at extraction time.
    expect(testIds).toContain('spa0-cta');
    expect(spaPage.navTargets).toContain('/');
  }, 120_000);

  it('every element the emitter could use has a verified unique selector', async () => {
    const result = await crawl(context, {
      config: config(),
      startUrl: `${baseUrl}/p/1`,
      interactionPass: false,
    });
    const page = result.model.pages.find((p) => p.urlPattern === '/p/1')!;
    const usable = page.elements.filter((e) =>
      e.selectorCandidates.some((c) => c.verified && c.unique),
    );
    // The emitter may only ever use verified+unique candidates, so the share of
    // elements that have one is the ceiling on what Phase 4 can reference.
    expect(usable.length / page.elements.length).toBeGreaterThanOrEqual(0.95);
  }, 120_000);
});
