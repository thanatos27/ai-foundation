import { describe, expect, it } from 'vitest';
import { ApiKeyError } from '../../src/http/auth.js';
import { DEFAULT_HOST, DEFAULT_PORT, HttpOptionError, isLoopback, resolveHttpOptions } from '../../src/http/options.js';

const KEY = 'k'.repeat(40);

describe('resolveHttpOptions', () => {
  it('defaults to this machine only', () => {
    expect(resolveHttpOptions({}, { AI_FOUNDATION_API_KEY: KEY })).toEqual({ apiKey: KEY, host: DEFAULT_HOST, port: DEFAULT_PORT });
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('takes the environment over the defaults, and the arguments over the environment', () => {
    const env = { AI_FOUNDATION_API_KEY: KEY, AI_FOUNDATION_HTTP_HOST: '0.0.0.0', AI_FOUNDATION_HTTP_PORT: '9000' };
    expect(resolveHttpOptions({}, env)).toMatchObject({ host: '0.0.0.0', port: 9000 });
    expect(resolveHttpOptions({ host: '::1', port: '0' }, env)).toMatchObject({ host: '::1', port: 0 });
  });

  it('ignores blank environment values', () => {
    expect(resolveHttpOptions({}, { AI_FOUNDATION_API_KEY: KEY, AI_FOUNDATION_HTTP_HOST: ' ', AI_FOUNDATION_HTTP_PORT: '' })).toMatchObject({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    });
  });

  it.each(['-1', '65536', '80.5', 'http', '1e3', ''])('refuses the port %j', (port) => {
    expect(() => resolveHttpOptions({ port }, { AI_FOUNDATION_API_KEY: KEY })).toThrow(HttpOptionError);
    expect(() => resolveHttpOptions({}, { AI_FOUNDATION_API_KEY: KEY, AI_FOUNDATION_HTTP_PORT: port || 'x' })).toThrow(
      /AI_FOUNDATION_HTTP_PORT must be a port number/,
    );
  });

  it('needs the API key, from the environment only', () => {
    expect(() => resolveHttpOptions({}, {})).toThrow(ApiKeyError);
    expect(() => resolveHttpOptions({ port: '1' }, { AI_FOUNDATION_API_KEY: 'short' })).toThrow(/at least 32/);
  });
});

describe('isLoopback', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['localhost', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.10', false],
  ])('%s → %s', (host, expected) => {
    expect(isLoopback(host)).toBe(expected);
  });
});
