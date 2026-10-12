import { readFile } from 'node:fs/promises';
import { YAMLParseError, parse } from 'yaml';
import { ConfigSchema, type Config } from './schema.js';

/** Configuration could not be loaded. The message is meant to be shown to the user as-is. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads and validates the config file at `path`. Path resolution is the caller's job. */
export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`Config file not found: ${path}`);
    }
    throw new ConfigError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new ConfigError(`Invalid YAML in ${path}: ${error.message}`);
    }
    throw error;
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration in ${path}:\n${details}`);
  }
  return result.data;
}
