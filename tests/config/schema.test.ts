import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/config/schema.js';

function validConfig() {
  return {
    version: '0.1',
    defaults: { area: 'personal', timezone: 'Asia/Tokyo' },
    sources: {
      task: { provider: 'todoist' },
      schedule: { provider: 'google_calendar' },
      collection: { provider: 'notion' },
      knowledge: { default: 'obsidian', providers: ['obsidian', 'google_drive'] },
      project: { providers: ['github', 'google_drive'] },
    },
  };
}

function issuePaths(input: unknown): string[] {
  const result = ConfigSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.error!.issues.map((issue) => issue.path.join('.'));
}

describe('ConfigSchema', () => {
  it('accepts the spec §13 configuration', () => {
    expect(ConfigSchema.safeParse(validConfig()).success).toBe(true);
  });

  it('rejects a numeric version', () => {
    expect(issuePaths({ ...validConfig(), version: 0.1 })).toEqual(['version']);
  });

  it('rejects an unsupported version', () => {
    expect(issuePaths({ ...validConfig(), version: '0.2' })).toEqual(['version']);
  });

  it('rejects a missing source', () => {
    const config = validConfig();
    const { task: _task, ...sources } = config.sources;
    expect(issuePaths({ ...config, sources })).toEqual(['sources.task']);
  });

  it('rejects an unknown provider', () => {
    const config = validConfig();
    config.sources.task.provider = 'asana';
    expect(issuePaths(config)).toEqual(['sources.task.provider']);
  });

  it('rejects a knowledge default that is not an enabled provider', () => {
    const config = validConfig();
    config.sources.knowledge = { default: 'google_drive', providers: ['obsidian'] };
    expect(issuePaths(config)).toEqual(['sources.knowledge.default']);
  });

  it('rejects empty provider lists', () => {
    const config = validConfig();
    config.sources.project.providers = [];
    expect(issuePaths(config)).toEqual(['sources.project.providers']);
  });

  it('rejects an invalid time zone', () => {
    const config = validConfig();
    config.defaults.timezone = 'Mars/Olympus_Mons';
    expect(issuePaths(config)).toEqual(['defaults.timezone']);
  });

  it('accepts a writable calendar ID for schedules', () => {
    const config = validConfig();
    const schedule = { ...config.sources.schedule, writable_calendar_id: 'abc@group.calendar.google.com' };
    const result = ConfigSchema.safeParse({ ...config, sources: { ...config.sources, schedule } });
    expect(result.success && result.data.sources.schedule.writable_calendar_id).toBe('abc@group.calendar.google.com');
  });

  it('allows the writable calendar ID to be omitted', () => {
    const result = ConfigSchema.safeParse(validConfig());
    expect(result.success && result.data.sources.schedule.writable_calendar_id).toBeUndefined();
  });

  it('rejects an empty writable calendar ID', () => {
    const config = validConfig();
    const schedule = { ...config.sources.schedule, writable_calendar_id: '' };
    expect(issuePaths({ ...config, sources: { ...config.sources, schedule } })).toEqual([
      'sources.schedule.writable_calendar_id',
    ]);
  });

  it('accepts a data source ID for collections', () => {
    const config = validConfig();
    const collection = { ...config.sources.collection, data_source_id: '0f9e3c1a-1111-2222-3333-444455556666' };
    const result = ConfigSchema.safeParse({ ...config, sources: { ...config.sources, collection } });
    expect(result.success && result.data.sources.collection.data_source_id).toBe('0f9e3c1a-1111-2222-3333-444455556666');
  });

  it('allows the collection data source ID to be omitted', () => {
    const result = ConfigSchema.safeParse(validConfig());
    expect(result.success && result.data.sources.collection.data_source_id).toBeUndefined();
  });

  it('rejects an empty collection data source ID', () => {
    const config = validConfig();
    const collection = { ...config.sources.collection, data_source_id: '' };
    expect(issuePaths({ ...config, sources: { ...config.sources, collection } })).toEqual([
      'sources.collection.data_source_id',
    ]);
  });

  it('rejects a Notion token in the collection source', () => {
    const config = validConfig();
    const collection = { ...config.sources.collection, api_token: 'ntn_secret' };
    expect(issuePaths({ ...config, sources: { ...config.sources, collection } })).toEqual(['sources.collection']);
  });

  describe('knowledge.obsidian', () => {
    const vaultPath = process.platform === 'win32' ? 'C:/Users/me/Obsidian/Vault' : '/home/me/Obsidian/Vault';

    function withObsidian(obsidian: Record<string, unknown>) {
      const config = validConfig();
      return { ...config, sources: { ...config.sources, knowledge: { ...config.sources.knowledge, obsidian } } };
    }

    it('accepts a filesystem vault with a knowledge directory', () => {
      const result = ConfigSchema.safeParse(
        withObsidian({ storage: 'filesystem', vault_path: vaultPath, knowledge_dir: 'AI Foundation/Knowledge' }),
      );
      expect(result.success && result.data.sources.knowledge.obsidian).toEqual({
        storage: 'filesystem',
        vault_path: vaultPath,
        knowledge_dir: 'AI Foundation/Knowledge',
      });
    });

    it('allows the block, vault_path and knowledge_dir to be omitted', () => {
      expect(ConfigSchema.safeParse(validConfig()).success).toBe(true);
      expect(ConfigSchema.safeParse(withObsidian({ storage: 'filesystem' })).success).toBe(true);
    });

    it('accepts a knowledge directory with dot-prefixed or Japanese segments', () => {
      for (const knowledgeDir of ['.knowledge', 'ナレッジ/AI Foundation']) {
        expect(ConfigSchema.safeParse(withObsidian({ storage: 'filesystem', knowledge_dir: knowledgeDir })).success).toBe(
          true,
        );
      }
    });

    it.each(['google_drive', undefined])('rejects storage %s', (storage) => {
      expect(issuePaths(withObsidian({ storage, knowledge_dir: 'K' }))).toEqual(['sources.knowledge.obsidian.storage']);
    });

    it.each(['relative/vault', './vault', ''])('rejects a vault_path that is not absolute: %j', (vault_path) => {
      expect(issuePaths(withObsidian({ storage: 'filesystem', vault_path }))).toContain(
        'sources.knowledge.obsidian.vault_path',
      );
    });

    it.each(['', '.', '..', '../outside', 'AI Foundation/../..', '/abs', 'C:/abs', 'a\\b', 'a//b', 'a/', 'a/./b'])(
      'rejects a knowledge_dir outside the vault or not in vault-relative form: %j',
      (knowledge_dir) => {
        expect(issuePaths(withObsidian({ storage: 'filesystem', knowledge_dir }))).toContain(
          'sources.knowledge.obsidian.knowledge_dir',
        );
      },
    );

    it('rejects unknown keys', () => {
      expect(issuePaths(withObsidian({ storage: 'filesystem', api_token: 'x' }))).toEqual(['sources.knowledge.obsidian']);
    });
  });

  it('rejects an invalid default area', () => {
    const config = validConfig();
    config.defaults.area = 'study';
    expect(issuePaths(config)).toEqual(['defaults.area']);
  });

  describe('keeps dynamic data and secrets out of the config', () => {
    it('rejects a project list', () => {
      const config = { ...validConfig(), projects: [{ name: 'physical-ai-robot', repo: 'thanatos27/physical-ai-robot' }] };
      expect(issuePaths(config)).toEqual(['']);
    });

    it('rejects project entries under sources.project', () => {
      const config = validConfig();
      const project = { ...config.sources.project, items: ['thanatos27/physical-ai-robot'] };
      expect(issuePaths({ ...config, sources: { ...config.sources, project } })).toEqual(['sources.project']);
    });

    it('rejects credentials under a source', () => {
      const config = validConfig();
      const task = { ...config.sources.task, api_token: 'xxxx' };
      expect(issuePaths({ ...config, sources: { ...config.sources, task } })).toEqual(['sources.task']);
    });

    it('rejects OAuth secrets under the schedule source', () => {
      const config = validConfig();
      const schedule = { ...config.sources.schedule, refresh_token: 'xxxx' };
      expect(issuePaths({ ...config, sources: { ...config.sources, schedule } })).toEqual(['sources.schedule']);
    });
  });
});
