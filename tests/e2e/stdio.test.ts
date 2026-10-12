import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/config/${name}`, import.meta.url));
const invalidConfig = fixture('invalid-schema.yaml');

/** Runs src/index.ts through tsx, exactly as `npm run dev` does. */
const serverCommand = { command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'] };

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.AI_FOUNDATION_CONFIG;
  return { ...env, ...extra };
}

async function listToolsOverStdio(args: string[] = [], env = childEnv()) {
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
    return await client.listTools();
  } finally {
    await client.close();
  }
}

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
  it('starts with the repository config.yaml and answers tools/list', async () => {
    const { tools } = await listToolsOverStdio();
    expect(tools).toEqual([]);
  });

  it('uses AI_FOUNDATION_CONFIG when set', async () => {
    const { code, stderr } = await runExpectingFailure([], childEnv({ AI_FOUNDATION_CONFIG: invalidConfig }));
    expect(code).toBe(1);
    expect(stderr).toContain('invalid-schema.yaml');
  });

  it('prefers --config over AI_FOUNDATION_CONFIG', async () => {
    const valid = fileURLToPath(new URL('../../config.yaml', import.meta.url));
    const { tools } = await listToolsOverStdio(['--config', valid], childEnv({ AI_FOUNDATION_CONFIG: invalidConfig }));
    expect(tools).toEqual([]);
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
