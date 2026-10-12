import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config/loader.js';
import { createServer } from './server.js';

// stdout carries MCP JSON-RPC only. Everything human-readable goes to stderr.

/** `--config <path>` > `AI_FOUNDATION_CONFIG` > the repository's config.yaml. */
function resolveConfigPath(): string {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  return (
    values.config ??
    (process.env.AI_FOUNDATION_CONFIG || undefined) ??
    // src/index.ts and dist/index.js both sit one level below the repository root.
    fileURLToPath(new URL('../config.yaml', import.meta.url))
  );
}

async function main(): Promise<void> {
  const config = await loadConfig(resolveConfigPath());

  const handle = serveStdio(() => createServer({ config, connectors: {} }), {
    onerror: (error) => console.error('[ai-foundation]', error),
  });

  const shutdown = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
    console.error(`[ai-foundation] ${(error as Error).message}`);
  } else {
    console.error('[ai-foundation] Failed to start:', error);
  }
  process.exit(1);
});
