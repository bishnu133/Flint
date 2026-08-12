import { describe, it, expect } from 'vitest';
import { checkHealth } from './health.js';

describe('checkHealth', () => {
  it('treats any HTTP answer as healthy, including a 500', () => {
    // A 500 is the application failing, which is a test's job to catch. Calling
    // it an environment failure here would suppress a real finding.
    return Promise.all(
      [200, 302, 404, 500].map(async (status) => {
        const result = await checkHealth({
          baseUrl: 'https://app.example.com',
          fetchImpl: (() =>
            Promise.resolve({ status }) as unknown as Promise<Response>) as typeof fetch,
        });
        expect(result.healthy, `status ${status}`).toBe(true);
        expect(result.detail).toContain(String(status));
      }),
    );
  });

  it('reports a refused connection as unhealthy', async () => {
    const result = await checkHealth({
      baseUrl: 'http://localhost:3000',
      fetchImpl: (() =>
        Promise.reject(new Error('fetch failed: ECONNREFUSED'))) as unknown as typeof fetch,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(/unreachable/);
  });

  it('rejects a malformed base URL before trying to reach anything', async () => {
    let called = false;
    const result = await checkHealth({
      baseUrl: 'not-a-url',
      fetchImpl: (() => {
        called = true;
        return Promise.resolve({ status: 200 }) as unknown as Promise<Response>;
      }) as typeof fetch,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(/not a valid absolute URL/);
    expect(called).toBe(false);
  });

  it('gives up after the timeout rather than hanging the run', async () => {
    const result = await checkHealth({
      baseUrl: 'https://slow.example.com',
      timeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    expect(result.healthy).toBe(false);
    expect(result.detail).toMatch(/did not answer within 20ms/);
  });
});
