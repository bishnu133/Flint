import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext } from '@playwright/test';
import { launchBrowser, createContext } from './browser.js';
import { crawl } from './crawler.js';
import {
  compileFlow,
  discoverFlowFiles,
  formatReplay,
  loadFlowDefinitions,
  mergeFlowPages,
  parseFlowMarkdown,
  replayFlows,
  FLOWS_SUBDIR,
} from './flows.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';
import { ScreenModelSchema, type ScreenModel } from '../schemas/screen-model.js';
import { FlintError } from '../shared/errors.js';

/**
 * Flow scripts exist for states a crawl cannot reach. The fixture app has one:
 * a cart page whose contents only appear after an item has been added, which
 * no amount of `goto` will produce.
 */

const SITE: Record<string, string> = {
  '/': `<html lang="en"><body><h1>Shop</h1>
    <a href="/cart">Cart</a>
    <button data-testid="add-item" onclick="sessionStorage.setItem('item','1')">Add item</button>
  </body></html>`,
  '/cart': `<html lang="en"><body><h1>Cart</h1>
    <div id="contents"></div>
    <script>
      if (sessionStorage.getItem('item') === '1') {
        document.getElementById('contents').innerHTML =
          '<button data-testid="checkout">Checkout</button>' +
          '<button data-testid="remove-item">Remove</button>';
      }
    </script>
  </body></html>`,
};

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;
let projectRoot: string;

beforeAll(async () => {
  server = createServer((req, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const body = SITE[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html' });
    res.end(body ?? '<html lang="en"><body>404</body></html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser({ proxyServer: '' });
  context = await createContext(browser);
  projectRoot = mkdtempSync(join(tmpdir(), 'flint-flows-'));
  mkdirSync(join(projectRoot, 'kb', FLOWS_SUBDIR), { recursive: true });
}, 120_000);

afterAll(async () => {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await new Promise<void>((r) => server?.close(() => r()));
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeFlow(name: string, contents: string): string {
  const path = join(projectRoot, 'kb', FLOWS_SUBDIR, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

function clearFlows(): void {
  rmSync(join(projectRoot, 'kb', FLOWS_SUBDIR), { recursive: true, force: true });
  mkdirSync(join(projectRoot, 'kb', FLOWS_SUBDIR), { recursive: true });
}

function config(): FlintConfig {
  return FlintConfigSchema.parse({
    baseUrl,
    envClass: 'test',
    models: { planner: 'a', coder: 'b', repair: 'c' },
  });
}

// ---------------------------------------------------------------------------
// Parsing — pure, no browser
// ---------------------------------------------------------------------------

describe('parseFlowMarkdown', () => {
  it('reads the id and description from frontmatter', () => {
    const flow = parseFlowMarkdown(
      ['---', 'id: checkout', 'description: Reach checkout', '---', '', '```ts', 'x', '```'].join(
        '\n',
      ),
      'fallback',
      'f.md',
    );
    expect(flow.id).toBe('checkout');
    expect(flow.description).toBe('Reach checkout');
    expect(flow.code.trim()).toBe('x');
  });

  it('falls back to the filename when there is no frontmatter', () => {
    const flow = parseFlowMarkdown('```ts\nx\n```', 'my-flow', 'my-flow.md');
    expect(flow.id).toBe('my-flow');
  });

  it('ignores prose outside the code fence', () => {
    const flow = parseFlowMarkdown(
      ['Some explanation for humans.', '', '```ts', 'const a = 1;', '```', '', 'More prose.'].join(
        '\n',
      ),
      'f',
      'f.md',
    );
    expect(flow.code).toContain('const a = 1;');
    expect(flow.code).not.toContain('More prose');
  });

  it('accepts js and typescript fences too', () => {
    for (const lang of ['js', 'javascript', 'typescript']) {
      expect(parseFlowMarkdown(`\`\`\`${lang}\ny\n\`\`\``, 'f', 'f.md').code.trim()).toBe('y');
    }
  });

  it('uses only the first code fence, so prose layout cannot reorder a flow', () => {
    const flow = parseFlowMarkdown('```ts\nfirst\n```\n\n```ts\nsecond\n```', 'f', 'f.md');
    expect(flow.code).toContain('first');
    expect(flow.code).not.toContain('second');
  });

  it('errors actionably when there is no code block', () => {
    expect(() => parseFlowMarkdown('just prose', 'f', '/kb/f.md')).toThrowError(FlintError);
    expect(() => parseFlowMarkdown('just prose', 'f', '/kb/f.md')).toThrow(/no ts\/js code block/);
  });

  it('handles CRLF line endings', () => {
    const flow = parseFlowMarkdown('---\r\nid: x\r\n---\r\n\r\n```ts\r\nz\r\n```\r\n', 'f', 'f.md');
    expect(flow.id).toBe('x');
    expect(flow.code.trim()).toBe('z');
  });
});

describe('discoverFlowFiles', () => {
  it('returns an empty list when the directory does not exist', () => {
    expect(discoverFlowFiles(projectRoot, 'no-such-kb')).toEqual([]);
  });

  it('skips _-prefixed files so the shipped example never runs', () => {
    clearFlows();
    writeFlow('_example.md', '```ts\nexport default async () => {};\n```');
    writeFlow('real.md', '```ts\nexport default async () => {};\n```');
    const files = discoverFlowFiles(projectRoot, 'kb').map((p) => p.split('/').pop());
    expect(files).toEqual(['real.md']);
  });

  it('lists .md files in sorted order and ignores everything else', () => {
    clearFlows();
    writeFlow('b.md', '```ts\nexport default async () => {};\n```');
    writeFlow('a.md', '```ts\nexport default async () => {};\n```');
    writeFlow('notes.txt', 'ignored');
    const files = discoverFlowFiles(projectRoot, 'kb').map((p) => p.split('/').pop());
    expect(files).toEqual(['a.md', 'b.md']);
  });
});

describe('compileFlow', () => {
  it('compiles a TypeScript arrow function', async () => {
    const fn = await compileFlow({
      id: 'x',
      path: 'x.md',
      code: 'export default async (page: unknown): Promise<void> => { void page; };',
    });
    expect(typeof fn).toBe('function');
  });

  it('errors actionably when there is no default export', async () => {
    await expect(
      compileFlow({ id: 'x', path: '/kb/x.md', code: 'export const nope = 1;' }),
    ).rejects.toThrow(/does not export a default function/);
  });

  it('errors actionably on a syntax error, naming the file', async () => {
    await expect(
      compileFlow({ id: 'x', path: '/kb/x.md', code: 'export default async ( => {' }),
    ).rejects.toThrow(/failed to compile/);
  });
});

describe('mergeFlowPages', () => {
  const model: ScreenModel = {
    version: '1',
    baseUrl: 'https://example.com',
    capturedAt: new Date().toISOString(),
    pages: [
      {
        id: 'page-a',
        url: 'https://example.com/cart',
        urlPattern: '/cart',
        title: 'Cart',
        reachedVia: { kind: 'link', href: '/cart' },
        elements: [element('el-1')],
        navTargets: ['/'],
        capturedAt: new Date().toISOString(),
      },
    ],
  };

  function element(id: string) {
    return {
      id,
      role: 'button',
      name: id,
      tagName: 'button',
      boundingBox: { x: 0, y: 0, width: 1, height: 1 },
      states: { visible: true, enabled: true },
      selectorCandidates: [],
    };
  }

  it('adds a page the crawl never saw', () => {
    const merged = mergeFlowPages(model, [
      { ...model.pages[0]!, id: 'page-b', elements: [element('el-9')] },
    ]);
    expect(merged.pages.map((p) => p.id)).toEqual(['page-a', 'page-b']);
  });

  it('unions elements onto a page the crawl already had', () => {
    const merged = mergeFlowPages(model, [
      { ...model.pages[0]!, elements: [element('el-1'), element('el-2')] },
    ]);
    expect(merged.pages).toHaveLength(1);
    expect(merged.pages[0]!.elements.map((e) => e.id)).toEqual(['el-1', 'el-2']);
  });

  it('keeps the crawl reachedVia, since a plain link is the simpler way in', () => {
    const merged = mergeFlowPages(model, [
      { ...model.pages[0]!, reachedVia: { kind: 'flow', flowId: 'f', step: 0 } },
    ]);
    expect(merged.pages[0]!.reachedVia.kind).toBe('link');
  });

  it('produces a schema-valid model', () => {
    const merged = mergeFlowPages(model, [{ ...model.pages[0]!, id: 'page-b' }]);
    expect(ScreenModelSchema.safeParse(merged).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Replay — real browser, real fixture app
// ---------------------------------------------------------------------------

describe('replayFlows', () => {
  it('captures a state the crawler cannot reach', async () => {
    clearFlows();
    writeFlow(
      'cart.md',
      [
        '---',
        'id: populated-cart',
        'description: Cart with one item',
        '---',
        '',
        '```ts',
        'export default async (page, flint) => {',
        '  await page.goto(flint.baseUrl + "/");',
        '  await page.click("[data-testid=add-item]");',
        '  await page.goto(flint.baseUrl + "/cart");',
        '  await flint.capture("cart-populated");',
        '};',
        '```',
      ].join('\n'),
    );

    // The crawl sees an empty cart: no checkout button exists yet.
    const crawled = await crawl(context, { config: config(), interactionPass: false });
    const crawledCart = crawled.model.pages.find((p) => p.urlPattern === '/cart')!;
    expect(crawledCart.elements.map((e) => e.testId)).not.toContain('checkout');

    const replay = await replayFlows(context, { config: config(), projectRoot });
    expect(replay.failures).toEqual([]);
    expect(replay.succeeded).toEqual(['populated-cart']);
    expect(replay.pages).toHaveLength(1);
    expect(replay.pages[0]!.elements.map((e) => e.testId)).toContain('checkout');
    expect(replay.pages[0]!.reachedVia).toEqual({
      kind: 'flow',
      flowId: 'populated-cart',
      step: 0,
    });
  }, 90_000);

  it('merges the flow state onto the crawled page', async () => {
    const crawled = await crawl(context, { config: config(), interactionPass: false });
    const replay = await replayFlows(context, { config: config(), projectRoot });
    const merged = mergeFlowPages(crawled.model, replay.pages);
    const cart = merged.pages.find((p) => p.urlPattern === '/cart')!;
    expect(cart.elements.map((e) => e.testId)).toContain('checkout');
    expect(ScreenModelSchema.safeParse(merged).success).toBe(true);
  }, 90_000);

  it('stamps flow-captured elements with the flow and step that produced them', async () => {
    clearFlows();
    writeFlow(
      'cart.md',
      [
        '---',
        'id: populated-cart',
        '---',
        '',
        '```ts',
        'export default async (page, flint) => {',
        '  await page.goto(flint.baseUrl + "/");',
        '  await page.click("[data-testid=add-item]");',
        '  await page.goto(flint.baseUrl + "/cart");',
        '  await flint.capture();',
        '};',
        '```',
      ].join('\n'),
    );
    const replay = await replayFlows(context, { config: config(), projectRoot });
    const checkout = replay.pages[0]!.elements.find((e) => e.testId === 'checkout')!;
    // Without this the validator reports it as drift and the Emitter would
    // reference it with no precondition.
    expect(checkout.provenance).toEqual({ kind: 'flow', flowId: 'populated-cart', step: 0 });
  }, 90_000);

  it('numbers multiple captures so each state is distinguishable', async () => {
    clearFlows();
    writeFlow(
      'two-step.md',
      [
        '```ts',
        'export default async (page, flint) => {',
        '  await page.goto(flint.baseUrl + "/");',
        '  await flint.capture("home");',
        '  await page.click("[data-testid=add-item]");',
        '  await page.goto(flint.baseUrl + "/cart");',
        '  await flint.capture("cart");',
        '};',
        '```',
      ].join('\n'),
    );
    const replay = await replayFlows(context, { config: config(), projectRoot });
    expect(replay.pages.map((p) => p.reachedVia)).toEqual([
      { kind: 'flow', flowId: 'two-step', step: 0 },
      { kind: 'flow', flowId: 'two-step', step: 1 },
    ]);
  }, 90_000);

  it('captures once at the end when a flow never calls capture', async () => {
    clearFlows();
    writeFlow(
      'no-capture.md',
      [
        '```ts',
        'export default async (page, flint) => {',
        '  await page.goto(flint.baseUrl + "/cart");',
        '};',
        '```',
      ].join('\n'),
    );
    const replay = await replayFlows(context, { config: config(), projectRoot });
    expect(replay.pages).toHaveLength(1);
    expect(replay.pages[0]!.urlPattern).toBe('/cart');
  }, 90_000);

  it('records a throwing flow as a failure and keeps replaying the others', async () => {
    clearFlows();
    writeFlow(
      'a-broken.md',
      ['```ts', 'export default async () => { throw new Error("boom"); };', '```'].join('\n'),
    );
    writeFlow(
      'b-good.md',
      [
        '```ts',
        'export default async (page, flint) => {',
        '  await page.goto(flint.baseUrl + "/");',
        '  await flint.capture();',
        '};',
        '```',
      ].join('\n'),
    );
    const replay = await replayFlows(context, { config: config(), projectRoot });
    expect(replay.failures).toHaveLength(1);
    expect(replay.failures[0]!.flowId).toBe('a-broken');
    expect(replay.failures[0]!.message).toBe('boom');
    expect(replay.succeeded).toEqual(['b-good']);
    expect(formatReplay(replay)).toMatch(/a-broken/);
  }, 90_000);

  it('replays only the requested flows when `only` is set', async () => {
    const replay = await replayFlows(context, {
      config: config(),
      projectRoot,
      only: ['b-good'],
    });
    expect(replay.succeeded).toEqual(['b-good']);
    expect(replay.failures).toEqual([]);
  }, 90_000);

  it('does nothing when there are no flow files', async () => {
    clearFlows();
    const replay = await replayFlows(context, { config: config(), projectRoot });
    expect(replay).toEqual({ pages: [], failures: [], succeeded: [] });
    expect(loadFlowDefinitions(projectRoot, 'kb')).toEqual([]);
  }, 60_000);

  it('verifies selectors in flow-captured pages, like any other page', async () => {
    clearFlows();
    writeFlow(
      'cart.md',
      [
        '```ts',
        'export default async (page, flint) => {',
        '  await page.goto(flint.baseUrl + "/");',
        '  await page.click("[data-testid=add-item]");',
        '  await page.goto(flint.baseUrl + "/cart");',
        '  await flint.capture();',
        '};',
        '```',
      ].join('\n'),
    );
    const replay = await replayFlows(context, { config: config(), projectRoot });
    const checkout = replay.pages[0]!.elements.find((e) => e.testId === 'checkout')!;
    expect(checkout.selectorCandidates.every((c) => c.verified)).toBe(true);
    expect(checkout.selectorCandidates.some((c) => c.unique)).toBe(true);
  }, 90_000);
});
