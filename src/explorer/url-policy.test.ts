import { describe, it, expect } from 'vitest';
import {
  resolveUrl,
  isSameOrigin,
  globToRegExp,
  matchesPattern,
  decideScope,
  normalizePath,
  dedupeKey,
  policyFromConfig,
} from './url-policy.js';
import { FlintConfigSchema } from '../schemas/config.js';

const BASE = 'https://app.example.com';

describe('resolveUrl', () => {
  const cases: Array<[string, string | undefined]> = [
    ['/login', 'https://app.example.com/login'],
    ['login', 'https://app.example.com/login'],
    ['https://other.com/x', 'https://other.com/x'],
    ['#section', undefined],
    ['', undefined],
    ['   ', undefined],
    ['mailto:a@b.com', undefined],
    ['tel:+123', undefined],
    ['javascript:void(0)', undefined],
    ['ftp://files.example.com', undefined],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} => ${String(expected)}`, () => {
      expect(resolveUrl(input, BASE)).toBe(expected);
    });
  }

  it('strips nothing from a query string', () => {
    expect(resolveUrl('/search?q=a&b=2', BASE)).toBe('https://app.example.com/search?q=a&b=2');
  });
});

describe('isSameOrigin', () => {
  const cases: Array<[string, boolean]> = [
    ['https://app.example.com/x', true],
    ['https://app.example.com:443/x', true], // default port is the same origin
    ['http://app.example.com/x', false], // different protocol
    ['https://other.example.com/x', false], // subdomain is a different origin
    ['https://app.example.com:8080/x', false], // explicit non-default port
    ['not a url', false],
  ];
  for (const [url, expected] of cases) {
    it(`${url} => ${String(expected)}`, () => {
      expect(isSameOrigin(url, BASE)).toBe(expected);
    });
  }
});

describe('globToRegExp', () => {
  it('* does not cross a path segment', () => {
    expect(globToRegExp('/admin/*').test('/admin/users')).toBe(true);
    expect(globToRegExp('/admin/*').test('/admin/users/1')).toBe(false);
  });

  it('** crosses path segments', () => {
    expect(globToRegExp('/admin/**').test('/admin/users/1')).toBe(true);
  });

  it('escapes regex metacharacters so patterns stay literal', () => {
    expect(globToRegExp('/a.b').test('/a.b')).toBe(true);
    expect(globToRegExp('/a.b').test('/axb')).toBe(false);
  });

  it('is anchored at both ends', () => {
    expect(globToRegExp('/admin').test('/admin/extra')).toBe(false);
    expect(globToRegExp('/admin').test('/pre/admin')).toBe(false);
  });
});

describe('matchesPattern', () => {
  it('matches against path and query', () => {
    expect(matchesPattern('https://app.example.com/admin/users', '/admin/*')).toBe(true);
  });

  it('also accepts a full-URL pattern', () => {
    expect(matchesPattern('https://app.example.com/admin', 'https://app.example.com/admin')).toBe(
      true,
    );
  });
});

describe('decideScope', () => {
  it('accepts a same-origin URL when no patterns are configured', () => {
    const d = decideScope('/dashboard', { baseUrl: BASE });
    expect(d).toEqual({ inScope: true, url: 'https://app.example.com/dashboard' });
  });

  it('rejects cross-origin with a reason', () => {
    expect(decideScope('https://evil.com/x', { baseUrl: BASE })).toEqual({
      inScope: false,
      reason: 'cross-origin',
    });
  });

  it('rejects unparseable hrefs with a reason', () => {
    expect(decideScope('mailto:a@b.com', { baseUrl: BASE })).toEqual({
      inScope: false,
      reason: 'unparseable',
    });
  });

  it('rejects a URL outside the include list', () => {
    const d = decideScope('/other', { baseUrl: BASE, include: ['/admin/**'] });
    expect(d).toEqual({ inScope: false, reason: 'not-included' });
  });

  it('accepts a URL inside the include list', () => {
    const d = decideScope('/admin/users', { baseUrl: BASE, include: ['/admin/**'] });
    expect(d.inScope).toBe(true);
  });

  it('exclude wins over include, so users can carve exceptions', () => {
    const d = decideScope('/admin/logout', {
      baseUrl: BASE,
      include: ['/admin/**'],
      exclude: ['/admin/logout'],
    });
    expect(d).toEqual({ inScope: false, reason: 'excluded' });
  });
});

describe('normalizePath', () => {
  const rules = [
    { pattern: '/order/\\d+', replacement: '/order/:id' },
    { pattern: '/user/[^/]+/profile', replacement: '/user/:id/profile' },
  ];

  it('collapses a numeric id', () => {
    expect(normalizePath('https://app.example.com/order/1234', rules)).toBe('/order/:id');
  });

  it('collapses different ids to the same pattern', () => {
    expect(normalizePath('https://app.example.com/order/1', rules)).toBe(
      normalizePath('https://app.example.com/order/999', rules),
    );
  });

  it('leaves a non-matching path alone', () => {
    expect(normalizePath('https://app.example.com/settings', rules)).toBe('/settings');
  });

  it('anchors rules so a partial match does not rewrite', () => {
    expect(normalizePath('https://app.example.com/order/12/items', rules)).toBe('/order/12/items');
  });

  it('applies rules in configured order', () => {
    expect(normalizePath('https://app.example.com/user/abc/profile', rules)).toBe(
      '/user/:id/profile',
    );
  });

  it('skips an invalid regex rule instead of crashing the crawl', () => {
    const bad = [{ pattern: '/order/[', replacement: '/order/:id' }];
    expect(() => normalizePath('https://app.example.com/order/1', bad)).not.toThrow();
    expect(normalizePath('https://app.example.com/order/1', bad)).toBe('/order/1');
  });

  it('returns the path unchanged with no rules', () => {
    expect(normalizePath('https://app.example.com/a/b')).toBe('/a/b');
  });
});

describe('dedupeKey', () => {
  const rules = [{ pattern: '/order/\\d+', replacement: '/order/:id' }];

  it('drops the fragment — same document', () => {
    expect(dedupeKey('https://app.example.com/a#top')).toBe(dedupeKey('https://app.example.com/a'));
  });

  it('keeps the query — ?tab=billing is usually a different page', () => {
    expect(dedupeKey('https://app.example.com/s?tab=a')).not.toBe(
      dedupeKey('https://app.example.com/s?tab=b'),
    );
  });

  it('collapses parameterised URLs so they consume one budget slot', () => {
    expect(dedupeKey('https://app.example.com/order/1', rules)).toBe(
      dedupeKey('https://app.example.com/order/2', rules),
    );
  });

  it('keeps genuinely different pages distinct', () => {
    expect(dedupeKey('https://app.example.com/a')).not.toBe(dedupeKey('https://app.example.com/b'));
  });
});

describe('policyFromConfig', () => {
  it('reads patterns straight off a validated config', () => {
    const config = FlintConfigSchema.parse({
      baseUrl: BASE,
      envClass: 'test',
      models: { planner: 'a', coder: 'b', repair: 'c' },
      explorer: {
        urlPatterns: {
          include: ['/admin/**'],
          exclude: ['/admin/logout'],
          normalize: [{ pattern: '/order/\\d+', replacement: '/order/:id' }],
        },
      },
    });
    const policy = policyFromConfig(config);
    expect(policy.baseUrl).toBe(BASE);
    expect(policy.include).toEqual(['/admin/**']);
    expect(policy.exclude).toEqual(['/admin/logout']);
    expect(policy.normalize?.[0]?.replacement).toBe('/order/:id');
  });

  it('defaults to empty pattern lists (crawl everything same-origin)', () => {
    const config = FlintConfigSchema.parse({
      baseUrl: BASE,
      envClass: 'test',
      models: { planner: 'a', coder: 'b', repair: 'c' },
    });
    const policy = policyFromConfig(config);
    expect(policy.include).toEqual([]);
    expect(decideScope('/anything', policy).inScope).toBe(true);
  });
});
