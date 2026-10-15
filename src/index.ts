import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config/loader.js';
import { createConnectors } from './connectors/index.js';
import { EnvCredentialProvider } from './credentials/env.js';
import { createServer } from './server.js';

// stdout carries MCP JSON-RPC only. Everything human-readable goes to stderr.

// src/index.ts and dist/index.js both sit one level below the repository root.
const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

interface CliArgs {
  config?: string | undefined;
  'no-env-file'?: boolean | undefined;
}

/** `--config <path>` > `AI_FOUNDATION_CONFIG` > the repository's config.yaml. */
function resolveConfigPath(args: CliArgs): string {
  return args.config ?? (process.env.AI_FOUNDATION_CONFIG || undefined) ?? repoFile('config.yaml');
}

/**
 * Loads the repository's .env when present. Variables already set (e.g. by the MCP client's env)
 * win. `--no-env-file` skips it.
 */
function loadEnvFile(args: CliArgs): void {
  const path = repoFile('.env');
  if (!args['no-env-file'] && existsSync(path)) process.loadEnvFile(path);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: { config: { type: 'string' }, 'no-env-file': { type: 'boolean' } },
  });
  loadEnvFile(args);
  const config = await loadConfig(resolveConfigPath(args));
  // The only place that hands process.env to the credential boundary.
  const connectors = createConnectors(config, new EnvCredentialProvider(process.env));

  const handle = serveStdio(() => createServer({ config, connectors }), {
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
