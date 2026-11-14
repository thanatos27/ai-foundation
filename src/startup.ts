import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from './config/loader.js';
import { createConnectors } from './connectors/index.js';
import { EnvCredentialProvider } from './credentials/env.js';
import type { OperationContext } from './operations/index.js';

/** Startup shared by the stdio MCP server and the HTTP server. Messages go to stderr. */

// src/startup.ts and dist/startup.js both sit one level below the repository root.
const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

export interface CommonArgs {
  config?: string | undefined;
  'no-env-file'?: boolean | undefined;
}

/** `parseArgs` options for the arguments every entry point takes. */
export const COMMON_ARG_OPTIONS = {
  config: { type: 'string' },
  'no-env-file': { type: 'boolean' },
} as const;

/** `--config <path>` > `AI_FOUNDATION_CONFIG` > the repository's config.yaml. */
export function resolveConfigPath(args: CommonArgs): string {
  return args.config ?? (process.env.AI_FOUNDATION_CONFIG || undefined) ?? repoFile('config.yaml');
}

/**
 * Loads the repository's .env when present. Variables already set (e.g. by the MCP client's env)
 * win. `--no-env-file` skips it.
 */
export function loadEnvFile(args: CommonArgs): void {
  const path = repoFile('.env');
  if (!args['no-env-file'] && existsSync(path)) process.loadEnvFile(path);
}

/** Loads the config and builds the connectors. Nothing is contacted yet. */
export async function loadContext(args: CommonArgs): Promise<OperationContext> {
  const config = await loadConfig(resolveConfigPath(args));
  // The only place that hands process.env to the credential boundary.
  const connectors = createConnectors(config, new EnvCredentialProvider(process.env));
  return { config, connectors };
}

/** Errors whose message is the whole story: shown without a stack trace. */
export function isUserFacingStartupError(error: unknown): boolean {
  return error instanceof ConfigError || (error as NodeJS.ErrnoException)?.code?.startsWith('ERR_PARSE_ARGS') === true;
}

/** Reports a failed start on stderr and exits with 1. */
export function exitOnStartupError(error: unknown, isUserFacing: (error: unknown) => boolean = isUserFacingStartupError): never {
  if (isUserFacing(error)) {
    console.error(`[ai-foundation] ${(error as Error).message}`);
  } else {
    console.error('[ai-foundation] Failed to start:', error);
  }
  process.exit(1);
}
