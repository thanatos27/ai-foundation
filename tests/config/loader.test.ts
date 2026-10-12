import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/loader.js';

const repoConfig = fileURLToPath(new URL('../../config.yaml', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/config/${name}`, import.meta.url));

async function loadError(path: string): Promise<ConfigError> {
  const error = await loadConfig(path).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConfigError);
  return error as ConfigError;
}

describe('loadConfig', () => {
  it('loads the repository config.yaml', async () => {
    const config = await loadConfig(repoConfig);
    expect(config.version).toBe('0.1');
    expect(config.defaults).toEqual({ area: 'personal', timezone: 'Asia/Tokyo' });
    expect(config.sources.knowledge.default).toBe('obsidian');
  });

  it('reports a missing file with its path', async () => {
    const path = fixture('does-not-exist.yaml');
    const error = await loadError(path);
    expect(error.message).toBe(`Config file not found: ${path}`);
  });

  it('reports YAML syntax errors with the position', async () => {
    const error = await loadError(fixture('invalid-yaml.yaml'));
    expect(error.message).toMatch(/^Invalid YAML in .*invalid-yaml\.yaml: /);
    expect(error.message).toMatch(/at line \d+, column \d+/);
  });

  it('reports every schema violation with its key path', async () => {
    const error = await loadError(fixture('invalid-schema.yaml'));
    expect(error.message).toMatch(/^Invalid configuration in .*invalid-schema\.yaml:\n/);
    expect(error.message).toContain('  - version: ');
    expect(error.message).toContain('  - sources.task.provider: ');
    expect(error.message).toContain('  - (root): Unrecognized key: "projects"');
  });

  it('reports an empty file as invalid configuration', async () => {
    const error = await loadError(fixture('empty.yaml'));
    expect(error.message).toContain('  - (root): ');
  });
});
