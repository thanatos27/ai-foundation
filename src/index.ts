import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';
import { COMMON_ARG_OPTIONS, exitOnStartupError, loadContext, loadEnvFile } from './startup.js';

// stdout carries MCP JSON-RPC only. Everything human-readable goes to stderr.

async function main(): Promise<void> {
  const { values: args } = parseArgs({ options: COMMON_ARG_OPTIONS });
  loadEnvFile(args);
  const context = await loadContext(args);

  const handle = serveStdio(() => createServer(context), {
    onerror: (error) => console.error('[ai-foundation]', error),
  });

  const shutdown = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => exitOnStartupError(error));
