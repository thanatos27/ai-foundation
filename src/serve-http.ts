import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createHttpApp } from './http/app.js';
import { HTTP_ARG_OPTIONS, isHttpOptionError, isLoopback, resolveHttpOptions } from './http/options.js';
import { COMMON_ARG_OPTIONS, exitOnStartupError, isUserFacingStartupError, loadContext, loadEnvFile } from './startup.js';

/**
 * The REST API entry point (the MCP server is src/index.ts). It refuses to start without a valid
 * AI_FOUNDATION_API_KEY. It serves plain HTTP: expose it only behind HTTPS termination.
 */

const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Errors whose message is the whole story, shown without a stack trace. */
const isUserFacing = (error: unknown) =>
  isUserFacingStartupError(error) ||
  isHttpOptionError(error) ||
  ['EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES'].includes((error as NodeJS.ErrnoException)?.code ?? '');

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: { ...COMMON_ARG_OPTIONS, ...HTTP_ARG_OPTIONS } });
  loadEnvFile(args);
  // Checked before the config is read: without a key there is nothing to serve.
  const { apiKey, host, port } = resolveHttpOptions(args, process.env);
  const { config, connectors } = await loadContext(args);
  const app = createHttpApp({ config, connectors, apiKey });

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info: AddressInfo) => {
    const shown = info.family === 'IPv6' ? `[${info.address}]` : info.address;
    console.error(`[ai-foundation] HTTP server listening on http://${shown}:${info.port}`);
    if (!isLoopback(host)) {
      console.error('[ai-foundation] Listening beyond this machine: expose it only behind HTTPS termination.');
    }
  });
  server.on('error', (error) => exitOnStartupError(error, isUserFacing));

  const shutdown = () => {
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => exitOnStartupError(error, isUserFacing));
