import { API_KEY_VARIABLE, ApiKeyError, parseApiKey } from './auth.js';

export const HOST_VARIABLE = 'AI_FOUNDATION_HTTP_HOST';
export const PORT_VARIABLE = 'AI_FOUNDATION_HTTP_PORT';
/** Set by Cloud Run (and other container platforms) to the port the container must listen on. */
export const PLATFORM_PORT_VARIABLE = 'PORT';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

/** `parseArgs` options the HTTP server takes besides the common ones. */
export const HTTP_ARG_OPTIONS = {
  host: { type: 'string' },
  port: { type: 'string' },
} as const;

export interface HttpServerOptions {
  apiKey: string;
  host: string;
  port: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/** A port that is not an integer from 0 to 65535 (0: any free port). */
export class HttpOptionError extends Error {
  override name = 'HttpOptionError';
}

function parsePort(value: string, source: string): number {
  const port = /^\d{1,5}$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new HttpOptionError(`${source} must be a port number from 0 to 65535 (got "${value}")`);
  }
  return port;
}

/**
 * The HTTP server's options: arguments > environment variables > defaults. The port is `--port` >
 * AI_FOUNDATION_HTTP_PORT > PORT > 8787: a container platform's PORT is used without setting it
 * twice, and a PORT set by other tools on a development machine does not override this server's own
 * variable. The API key comes from the environment only, so it never shows up in a process list.
 */
export function resolveHttpOptions(args: { host?: string | undefined; port?: string | undefined }, env: Env): HttpServerOptions {
  const apiKey = parseApiKey(env[API_KEY_VARIABLE]);
  const host = args.host?.trim() || env[HOST_VARIABLE]?.trim() || DEFAULT_HOST;
  const fromEnv = [PORT_VARIABLE, PLATFORM_PORT_VARIABLE].find((name) => env[name]?.trim());
  const port =
    args.port !== undefined
      ? parsePort(args.port, '--port')
      : fromEnv !== undefined
        ? parsePort(env[fromEnv]!, fromEnv)
        : DEFAULT_PORT;
  return { apiKey, host, port };
}

/** Errors whose message is the whole story. */
export function isHttpOptionError(error: unknown): boolean {
  return error instanceof ApiKeyError || error instanceof HttpOptionError;
}

/** Whether `host` only accepts connections from this machine. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
