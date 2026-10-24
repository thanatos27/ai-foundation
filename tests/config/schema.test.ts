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

  describe('writable calendars', () => {
    const withSchedule = (fields: Record<string, unknown>) => {
      const config = validConfig();
      return { ...config, sources: { ...config.sources, schedule: { ...config.sources.schedule, ...fields } } };
    };
    const calendars = { personal: 'a@group.calendar.google.com', events: 'b@group.calendar.google.com' };

    it('accepts aliases with a default', () => {
      const result = ConfigSchema.safeParse(withSchedule({ default_calendar: 'personal', writable_calendars: calendars }));
      expect(result.success && result.data.sources.schedule).toEqual({
        provider: 'google_calendar',
        default_calendar: 'personal',
        writable_calendars: calendars,
      });
    });

    it('allows the writable calendars to be omitted', () => {
      const result = ConfigSchema.safeParse(validConfig());
      expect(result.success && result.data.sources.schedule.writable_calendars).toBeUndefined();
    });

    it.each([
      ['alone', {}],
      ['with the new keys', { default_calendar: 'personal', writable_calendars: calendars }],
    ])('rejects the old writable_calendar_id %s, explaining the migration', (_label, fields) => {
      const result = ConfigSchema.safeParse(withSchedule({ writable_calendar_id: 'a@group.calendar.google.com', ...fields }));
      expect(result.success).toBe(false);
      const issue = result.error?.issues.find((i) => i.path.join('.') === 'sources.schedule.writable_calendar_id');
      expect(issue?.message).toContain('writable_calendars');
      expect(issue?.message).toContain('default_calendar');
    });

    it.each([
      ['no calendar', { default_calendar: 'personal', writable_calendars: {} }, 'sources.schedule.writable_calendars'],
      ['no default', { writable_calendars: calendars }, 'sources.schedule.default_calendar'],
      ['an unknown default', { default_calendar: 'work', writable_calendars: calendars }, 'sources.schedule.default_calendar'],
      ['a default without calendars', { default_calendar: 'personal' }, 'sources.schedule.default_calendar'],
      [
        'the same ID twice',
        { default_calendar: 'personal', writable_calendars: { personal: 'a@x', events: 'a@x' } },
        'sources.schedule.writable_calendars.events',
      ],
      [
        'primary',
        { default_calendar: 'personal', writable_calendars: { personal: 'primary' } },
        'sources.schedule.writable_calendars.personal',
      ],
      [
        'Primary',
        { default_calendar: 'personal', writable_calendars: { personal: 'Primary' } },
        'sources.schedule.writable_calendars.personal',
      ],
      [
        'an empty ID',
        { default_calendar: 'personal', writable_calendars: { personal: '' } },
        'sources.schedule.writable_calendars.personal',
      ],
      [
        'a blank ID',
        { default_calendar: 'personal', writable_calendars: { personal: '  ' } },
        'sources.schedule.writable_calendars.personal',
      ],
    ])('rejects %s', (_label, fields, path) => {
      expect(issuePaths(withSchedule(fields))).toContain(path);
    });

    it.each(['Personal', 'my.cal', 'a@b', '1st', '', 'a'.repeat(33)])('rejects the alias %j', (alias) => {
      const result = ConfigSchema.safeParse(
        withSchedule({ default_calendar: 'personal', writable_calendars: { personal: 'a@x', [alias]: 'b@x' } }),
      );
      expect(result.success).toBe(false);
    });

    it.each(['personal', 'events', 'event_catalog', 'trip-2026', 'a'.repeat(32)])('accepts the alias %j', (alias) => {
      const result = ConfigSchema.safeParse(
        withSchedule({ default_calendar: alias, writable_calendars: { [alias]: 'a@group.calendar.google.com' } }),
      );
      expect(result.success).toBe(true);
    });
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

    it('rejects an area list under sources.area', () => {
      const config = validConfig();
      const area = { provider: 'notion', notion: { parent_page_id: PARENT_ID }, areas: ['Meals'] };
      expect(issuePaths({ ...config, sources: { ...config.sources, area } })).toEqual(['sources.area']);
    });
  });

  describe('sources.area', () => {
    const withArea = (area: unknown) => {
      const config = validConfig();
      return { ...config, sources: { ...config.sources, area } };
    };

    it('is optional, so configs written before areas still load', () => {
      expect(ConfigSchema.safeParse(validConfig()).success).toBe(true);
    });

    it('accepts the provider alone (the parent page is checked when an area tool is called)', () => {
      expect(ConfigSchema.safeParse(withArea({ provider: 'notion' })).success).toBe(true);
      expect(ConfigSchema.safeParse(withArea({ provider: 'notion', notion: {} })).success).toBe(true);
    });

    it.each([PARENT_ID, '1f2e3d4c-5b6a-4798-8796-a5b4c3d2e1f0', PARENT_ID.toUpperCase()])(
      'accepts the parent page id %s',
      (id) => {
        const parsed = ConfigSchema.parse(withArea({ provider: 'notion', notion: { parent_page_id: id } }));
        expect(parsed.sources.area?.notion?.parent_page_id).toBe(id);
      },
    );

    it.each(['', 'Areas', `${PARENT_ID}0`, 'https://app.notion.com/p/Areas-1f2e3d4c5b6a47988796a5b4c3d2e1f0'])(
      'rejects the parent page id %j',
      (id) => {
        expect(issuePaths(withArea({ provider: 'notion', notion: { parent_page_id: id } }))).toEqual([
          'sources.area.notion.parent_page_id',
        ]);
      },
    );

    it('rejects another provider and unknown keys', () => {
      expect(issuePaths(withArea({ provider: 'google_drive' }))).toEqual(['sources.area.provider']);
      expect(issuePaths(withArea({ provider: 'notion', notion: { parent_page_id: PARENT_ID, token: 'x' } }))).toEqual([
        'sources.area.notion',
      ]);
    });
  });

  describe('sources.lifelog', () => {
    const KNOWLEDGE_DIR = 'AI Foundation/Knowledge';
    const withLifeLog = (lifelog: unknown, knowledgeDir: string | null = KNOWLEDGE_DIR) => {
      const config = validConfig();
      const obsidian = { storage: 'filesystem', ...(knowledgeDir === null ? {} : { knowledge_dir: knowledgeDir }) };
      return { ...config, sources: { ...config.sources, knowledge: { ...config.sources.knowledge, obsidian }, lifelog } };
    };
    const lifelogDir = (directory: string) => ({ provider: 'obsidian', obsidian: { directory } });

    it('is optional, so configs written before life logs still load', () => {
      expect(ConfigSchema.safeParse(validConfig()).success).toBe(true);
      const { lifelog: _lifelog, ...sources } = withLifeLog(undefined).sources;
      expect(ConfigSchema.safeParse({ ...validConfig(), sources }).success).toBe(true);
    });

    it('accepts the provider alone and a directory next to knowledge_dir', () => {
      expect(ConfigSchema.safeParse(withLifeLog({ provider: 'obsidian' })).success).toBe(true);
      expect(ConfigSchema.safeParse(withLifeLog({ provider: 'obsidian', obsidian: {} })).success).toBe(true);
      const parsed = ConfigSchema.parse(withLifeLog(lifelogDir('AI Foundation/LifeLog')));
      expect(parsed.sources.lifelog).toEqual({ provider: 'obsidian', obsidian: { directory: 'AI Foundation/LifeLog' } });
    });

    it.each(['', '.', '..', '../outside', '/abs', 'C:/abs', 'a\b', 'a//b', 'a/'])(
      'rejects a directory outside the vault or not in vault-relative form: %j',
      (directory) => {
        expect(issuePaths(withLifeLog(lifelogDir(directory)))).toContain('sources.lifelog.obsidian.directory');
      },
    );

    it.each([
      ['the same as', KNOWLEDGE_DIR],
      ['inside', `${KNOWLEDGE_DIR}/LifeLog`],
      ['containing', 'AI Foundation'],
      ['the same (ignoring case) as', 'ai foundation/KNOWLEDGE'],
      ['inside (ignoring case)', 'AI FOUNDATION/knowledge/日記'],
    ])('rejects a directory %s knowledge_dir', (_label, directory) => {
      expect(issuePaths(withLifeLog(lifelogDir(directory)))).toEqual(['sources.lifelog.obsidian.directory']);
    });

    it('accepts directories that only share a name prefix with knowledge_dir', () => {
      expect(ConfigSchema.safeParse(withLifeLog(lifelogDir('AI Foundation/KnowledgeLog'))).success).toBe(true);
      expect(ConfigSchema.safeParse(withLifeLog(lifelogDir('AI'))).success).toBe(true);
    });

    it('does not compare when either directory is unset', () => {
      expect(ConfigSchema.safeParse(withLifeLog(lifelogDir(KNOWLEDGE_DIR), null)).success).toBe(true);
      expect(ConfigSchema.safeParse(withLifeLog({ provider: 'obsidian' }, KNOWLEDGE_DIR)).success).toBe(true);
    });

    it('rejects another provider and unknown keys (no article list, no vault path of its own)', () => {
      expect(issuePaths(withLifeLog({ provider: 'google_drive' }))).toEqual(['sources.lifelog.provider']);
      expect(issuePaths(withLifeLog({ provider: 'obsidian', obsidian: { directory: 'L', vault_path: '/v' } }))).toEqual([
        'sources.lifelog.obsidian',
      ]);
      expect(issuePaths(withLifeLog({ provider: 'obsidian', articles: ['x.md'] }))).toEqual(['sources.lifelog']);
    });
  });
});

const PARENT_ID = '1f2e3d4c5b6a47988796a5b4c3d2e1f0';
