/**
 * Deterministic URL policy for the crawler: what is in scope, and which URLs
 * are "the same page" for dedupe purposes.
 *
 * Pure and browser-free so the crawl frontier is fully table-testable. The
 * crawler owns traversal; this module owns every yes/no decision about a URL.
 */

import type { FlintConfig } from '../schemas/config.js';

/** A URL normalization rule from config, e.g. `/order/\d+` → `/order/:id`. */
export interface NormalizeRule {
  pattern: string;
  replacement: string;
}

export interface UrlPolicyOptions {
  baseUrl: string;
  include?: string[];
  exclude?: string[];
  normalize?: NormalizeRule[];
}

/** Build policy options straight from a validated Flint config. */
export function policyFromConfig(config: FlintConfig): UrlPolicyOptions {
  return {
    baseUrl: config.baseUrl,
    include: config.explorer.urlPatterns.include,
    exclude: config.explorer.urlPatterns.exclude,
    normalize: config.explorer.urlPatterns.normalize,
  };
}

/**
 * Parse a possibly-relative href against a base. Returns undefined for
 * anything that is not a crawlable http(s) URL — `mailto:`, `tel:`,
 * `javascript:`, fragments, and malformed input all fall out here.
 */
export function resolveUrl(href: string, base: string): string | undefined {
  const trimmed = href.trim();
  if (trimmed === '') return undefined;
  // `#section` is a same-page anchor and not a page. `#/settings` is a *route*
  // in a hash-routed SPA — rejecting it makes such apps look like one page.
  if (trimmed.startsWith('#') && !trimmed.startsWith('#/')) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return url.toString();
}

/**
 * Same-origin check (protocol + host + port), per the master plan's
 * same-origin lock. A subdomain is a different origin and is out of scope.
 */
export function isSameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Convert a glob-ish pattern to a RegExp. Supports `*` (any run of characters
 * except `/`) and `**` (any run including `/`). Everything else is literal —
 * users write URL patterns, not regexes.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Match a URL's path (plus query) against a glob pattern. */
export function matchesPattern(url: string, pattern: string): boolean {
  const target = pathAndQuery(url);
  return globToRegExp(pattern).test(target) || globToRegExp(pattern).test(url);
}

function pathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Why a URL was rejected — surfaced in the crawl report, never swallowed. */
export type RejectReason = 'unparseable' | 'cross-origin' | 'excluded' | 'not-included';

export type ScopeDecision =
  { inScope: true; url: string } | { inScope: false; reason: RejectReason };

/**
 * Decide whether a URL belongs in the crawl. Order matters: exclude wins over
 * include, so a user can include a broad pattern and carve exceptions out of it.
 */
export function decideScope(
  rawUrl: string,
  options: UrlPolicyOptions,
  /**
   * The page the href was found on. Relative hrefs are relative to *that*, not
   * to `baseUrl` — `href="item"` on `/products/list` means `/products/item`.
   * Resolving everything against `baseUrl` silently rewrites those to `/item`.
   * Defaults to `baseUrl` for callers that have no page context.
   */
  from?: string,
): ScopeDecision {
  const url = resolveUrl(rawUrl, from ?? options.baseUrl);
  if (url === undefined) return { inScope: false, reason: 'unparseable' };
  if (!isSameOrigin(url, options.baseUrl)) return { inScope: false, reason: 'cross-origin' };

  const exclude = options.exclude ?? [];
  if (exclude.some((p) => matchesPattern(url, p))) {
    return { inScope: false, reason: 'excluded' };
  }

  const include = options.include ?? [];
  // An empty include list means "everything same-origin".
  if (include.length > 0 && !include.some((p) => matchesPattern(url, p))) {
    return { inScope: false, reason: 'not-included' };
  }
  return { inScope: true, url };
}

/**
 * Collapse a parameterised URL to its representative pattern, e.g.
 * `/order/1234` → `/order/:id`. Rules are applied in config order and each is
 * anchored to the whole path, so a rule cannot partially rewrite a path.
 *
 * Without this, `/order/1`…`/order/999` would each consume a page budget slot
 * and produce 999 near-identical Screen Model pages.
 */
export function normalizePath(url: string, rules: NormalizeRule[] = []): string {
  const path = (() => {
    try {
      const parsed = new URL(url);
      // A routing fragment is part of page identity; a plain anchor is not.
      return parsed.hash.startsWith('#/') ? `${parsed.pathname}${parsed.hash}` : parsed.pathname;
    } catch {
      return url;
    }
  })();

  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(`^${rule.pattern}$`);
    } catch {
      continue; // an invalid pattern is skipped, never crashes the crawl
    }
    if (re.test(path)) {
      return path.replace(re, rule.replacement);
    }
  }
  return path;
}

/**
 * The key used to decide "have I already seen this page?". Two URLs sharing a
 * dedupe key are represented by one Screen Model page.
 *
 * The fragment is always dropped (same document). The query string is kept,
 * because `?tab=billing` frequently IS a different page — normalization rules
 * are the escape hatch when it isn't.
 */
export function dedupeKey(url: string, rules: NormalizeRule[] = []): string {
  const normalizedPath = normalizePath(url, rules);
  let search = '';
  try {
    search = new URL(url).search;
  } catch {
    /* fall through with no query */
  }
  return `${normalizedPath}${search}`;
}
