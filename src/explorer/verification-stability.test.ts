import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext } from '@playwright/test';
import { launchBrowser, createContext } from './browser.js';
import { crawl } from './crawler.js';
import { diffModels } from './screen-model-store.js';
import { pickBest } from './selector-ranker.js';
import { FlintConfigSchema, type FlintConfig } from '../schemas/config.js';

/**
 * Properties of live uniqueness verification.
 *
 * `unique` is the only field verification can change, so an unreproducible
 * reading is indistinguishable from a real UI change in `explore --diff`.
 * Verification therefore takes two readings and requires them to agree.
 *
 * **Honest scope note.** These tests pin the properties the confirm-read must
 * preserve; they do *not* reproduce timing-flaky verification. A fixture that
 * re-renders after load does not reproduce it either, because `waitForDomStable`
 * settles before extraction begins — which is the point of that wait. Producing
 * a genuine flake needs a DOM that never settles, and a test built on that would
 * itself be flaky. The confirm-read is justified on its own terms (a selector
 * whose uniqueness cannot be reproduced must not reach the Emitter), not by a
 * repro here.
 */

/** Re-renders after load: a duplicate appears, then goes away. */
const RERENDERING = `<html lang="en"><body>
  <h1>Cart</h1>
  <button id="real">Checkout</button>
  <div id="host"></div>
  <script>
    setTimeout(function () {
      var d = document.createElement('button');
      d.id = 'twin';
      d.textContent = 'Checkout';
      document.getElementById('host').appendChild(d);
    }, 60);
    setTimeout(function () {
      var t = document.getElementById('twin');
      if (t !== null) t.remove();
    }, 300);
  </script>
</body></html>`;

/** Genuinely static — the control for "confirmation did not break uniqueness". */
const STABLE = `<html lang="en"><body><h1>Stable</h1>
  <button data-testid="go">Go</button>
  <label for="q">Query</label><input id="q">
  </body></html>`;

/** Two nodes with the same text, permanently — must be non-unique, always. */
const AMBIGUOUS = `<html lang="en"><body>
  <button>Checkout</button><button>Checkout</button>
  <button data-testid="only">Only</button>
</body></html>`;

let server: Server;
let baseUrl: string;
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  server = createServer((req, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0]!;
    res.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/rerendering') return void res.end(RERENDERING);
    if (path === '/ambiguous') return void res.end(AMBIGUOUS);
    res.end(STABLE);
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

function crawlOnce(path: string) {
  return crawl(context, {
    config: config(),
    startUrl: `${baseUrl}${path}`,
    interactionPass: false,
    routeDiscovery: false,
  });
}

describe('uniqueness verification', () => {
  it('still marks a genuinely unique selector as unique', async () => {
    // The risk of requiring two agreeing readings is that everything becomes
    // non-unique and the Emitter is left with nothing to use.
    const result = await crawlOnce('/stable');
    const page = result.model.pages[0]!;
    const go = page.elements.find((e) => e.testId === 'go')!;
    const best = pickBest(go.selectorCandidates);
    expect(best).toBeDefined();
    expect(best!.unique).toBe(true);

    // And every element on a static page keeps a usable selector.
    for (const element of page.elements) {
      expect(pickBest(element.selectorCandidates)).toBeDefined();
    }
  }, 90_000);

  it('marks a permanently ambiguous selector non-unique', async () => {
    const result = await crawlOnce('/ambiguous');
    const page = result.model.pages[0]!;
    const duplicated = page.elements.filter((e) => e.text === 'Checkout');
    expect(duplicated.length).toBe(2);
    for (const element of duplicated) {
      const text = element.selectorCandidates.find((c) => c.strategy === 'text');
      if (text !== undefined) expect(text.unique).toBe(false);
    }
    // The unambiguous one on the same page is unaffected.
    const only = page.elements.find((e) => e.testId === 'only')!;
    expect(pickBest(only.selectorCandidates)?.unique).toBe(true);
  }, 90_000);

  it('produces an identical model across repeated crawls of a re-rendering page', async () => {
    const a = await crawlOnce('/rerendering');
    const b = await crawlOnce('/rerendering');
    const diff = diffModels(a.model, b.model);
    expect(flatten(diff)).toEqual([]);
    expect(diff.unchanged).toBe(true);
  }, 120_000);

  it('never offers the Emitter a candidate it did not confirm unique', async () => {
    // The structural guarantee behind core principle #1, restated as a test:
    // whatever pickBest returns is both verified and unique, on every page.
    for (const path of ['/stable', '/ambiguous', '/rerendering']) {
      const result = await crawlOnce(path);
      for (const element of result.model.pages[0]!.elements) {
        const best = pickBest(element.selectorCandidates);
        if (best === undefined) continue;
        expect(best.verified).toBe(true);
        expect(best.unique).toBe(true);
      }
    }
  }, 180_000);
});

/** Flatten a diff to readable strings so a failure names what moved. */
function flatten(diff: ReturnType<typeof diffModels>): string[] {
  return diff.changedPages.flatMap((page) =>
    page.changedElements.flatMap((el) =>
      el.changed.map((c) => `${page.urlPattern} ${el.elementId} ${c}`),
    ),
  );
}
