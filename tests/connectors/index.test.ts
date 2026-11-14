import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import { createConnectors } from '../../src/connectors/index.js';
import { EnvCredentialProvider } from '../../src/credentials/env.js';
import { ConfigurationError, MissingCredentialError } from '../../src/errors.js';
import { repoConfig } from '../helpers/mcp.js';

function withObsidian(obsidian: NonNullable<Config['sources']['knowledge']['obsidian']>): Config {
  return {
    ...repoConfig,
    sources: {
      ...repoConfig.sources,
      knowledge: { ...repoConfig.sources.knowledge, obsidian },
      lifelog: { provider: 'obsidian', obsidian: { directory: 'AI Foundation/LifeLog' } },
    },
  };
}

describe('createConnectors: the vault storage', () => {
  it('uses Google Drive for storage: google_drive (knowledge and life logs), contacting nothing until a call', async () => {
    const connectors = createConnectors(
      withObsidian({ storage: 'google_drive', vault_folder_id: '1AbCdEfGhIjKlMnOp', knowledge_dir: 'AI Foundation/Knowledge' }),
      new EnvCredentialProvider({}),
    );
    // No local vault is needed: the first call asks for the Google credentials.
    await expect(connectors.knowledge.search({})).rejects.toBeInstanceOf(MissingCredentialError);
    await expect(connectors.lifelog.get('lifelog:2026-10-03-x.md')).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it('reports a missing vault_folder_id before asking for credentials', async () => {
    const connectors = createConnectors(
      withObsidian({ storage: 'google_drive', knowledge_dir: 'AI Foundation/Knowledge' }),
      new EnvCredentialProvider({}),
    );
    await expect(connectors.knowledge.search({})).rejects.toThrow(ConfigurationError);
    await expect(connectors.knowledge.search({})).rejects.toThrow('vault_folder_id is not set');
  });

  it('keeps the file system for storage: filesystem', async () => {
    const connectors = createConnectors(
      withObsidian({ storage: 'filesystem', knowledge_dir: 'AI Foundation/Knowledge' }),
      new EnvCredentialProvider({}),
    );
    await expect(connectors.knowledge.search({})).rejects.toThrow('sources.knowledge.obsidian.vault_path is not set');
    await expect(connectors.lifelog.get('lifelog:2026-10-03-x.md')).rejects.toThrow(
      'sources.knowledge.obsidian.vault_path is not set',
    );
  });
});
