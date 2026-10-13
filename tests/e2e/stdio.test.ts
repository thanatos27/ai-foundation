import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/config/${name}`, import.meta.url));
const invalidConfig = fixture('invalid-schema.yaml');

/**
 * Runs src/index.ts through tsx, exactly as `npm run dev` does, without the developer's .env so
 * that no test can reach a real provider.
 */
const serverCommand = { command: process.execPath, args: ['--import', 'tsx', 'src/index.ts', '--no-env-file'] };

const CREDENTIAL_VARS = [
  'TODOIST_API_TOKEN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
];

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.AI_FOUNDATION_CONFIG;
  for (const name of CREDENTIAL_VARS) delete env[name];
  return { ...env, ...extra };
}

async function withStdioClient<T>(run: (client: Client) => Promise<T>, args: string[] = [], env = childEnv()) {
  const transport = new StdioClientTransport({
    command: serverCommand.command,
    args: [...serverCommand.args, ...args],
    cwd: repoRoot,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e-client', version: '0.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

const listToolsOverStdio = (args: string[] = [], env = childEnv()) =>
  withStdioClient((client) => client.listTools(), args, env);

const TOOL_NAMES = ['schedule_create', 'schedule_list', 'task_complete', 'task_create', 'task_list', 'task_update'];
const toolNames = ({ tools }: { tools: { name: string }[] }) => tools.map((tool) => tool.name).sort();

async function runExpectingFailure(args: string[], env = childEnv()) {
  const error = await promisify(execFile)(serverCommand.command, [...serverCommand.args, ...args], {
    cwd: repoRoot,
    env,
    timeout: 20_000,
  }).then(
    () => undefined,
    (e: { code?: number; stderr?: string }) => e,
  );
  expect(error, 'server should exit with an error').toBeDefined();
  return { code: error!.code, stderr: error!.stderr ?? '' };
}

describe('stdio server (e2e)', { timeout: 30_000 }, () => {
  it('starts with the repository config.yaml and lists the task and schedule tools', async () => {
    expect(toolNames(await listToolsOverStdio())).toEqual(TOOL_NAMES);
  });

  it('starts without credentials and reports them missing on use', async () => {
    const result = await withStdioClient((client) => client.callTool({ name: 'task_list', arguments: {} }));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Credential error: Todoist credential is not configured');
  });

  it('uses AI_FOUNDATION_CONFIG when set', async () => {
    const { code, stderr } = await runExpectingFailure([], childEnv({ AI_FOUNDATION_CONFIG: invalidConfig }));
    expect(code).toBe(1);
    expect(stderr).toContain('invalid-schema.yaml');
  });

  it('prefers --config over AI_FOUNDATION_CONFIG', async () => {
    const valid = fileURLToPath(new URL('../../config.yaml', import.meta.url));
    const tools = await listToolsOverStdio(['--config', valid], childEnv({ AI_FOUNDATION_CONFIG: invalidConfig }));
    expect(toolNames(tools)).toEqual(TOOL_NAMES);
  });

  it('fails to start on an invalid config with a readable message', async () => {
    const { code, stderr } = await runExpectingFailure(['--config', invalidConfig]);
    expect(code).toBe(1);
    expect(stderr).toContain(`Invalid configuration in ${invalidConfig}`);
    expect(stderr).toContain('sources.task.provider');
  });

  it('fails to start when the config file is missing', async () => {
    const missing = fixture('does-not-exist.yaml');
    const { code, stderr } = await runExpectingFailure(['--config', missing]);
    expect(code).toBe(1);
    expect(stderr).toContain(`Config file not found: ${missing}`);
  });

  it('fails to start on an unknown argument', async () => {
    const { code, stderr } = await runExpectingFailure(['--unknown']);
    expect(code).toBe(1);
    expect(stderr).toContain('--unknown');
  });
});
