import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/loader.js';
import type { Config } from '../../src/config/schema.js';
import { EnvCredentialProvider } from '../../src/credentials/env.js';

/**
 * Integration tests talk to the real Todoist / Google Calendar / Notion / GitHub accounts and Obsidian vault configured locally.
 * They run only with AI_FOUNDATION_INTEGRATION=1, read credentials from the environment or the
 * repository's .env, and the config from AI_FOUNDATION_CONFIG (else config.local.yaml, else config.yaml).
 */
const repoFile = (name: string) => fileURLToPath(new URL(`../../${name}`, import.meta.url));

if (existsSync(repoFile('.env'))) process.loadEnvFile(repoFile('.env'));

export const enabled = process.env.AI_FOUNDATION_INTEGRATION === '1';

export const credentials = new EnvCredentialProvider(process.env);

export async function integrationConfig(): Promise<Config> {
  const path =
    process.env.AI_FOUNDATION_CONFIG ||
    (existsSync(repoFile('config.local.yaml')) ? repoFile('config.local.yaml') : repoFile('config.yaml'));
  return loadConfig(path);
}

export const hasEnv = (...names: string[]) => names.every((name) => !!process.env[name]?.trim());

/** Unique, recognisable prefix for everything a run creates. */
export const runLabel = `[af-it ${new Date().toISOString()}]`;

/** `YYYY-MM-DD` `days` from today (UTC). */
export function daysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
