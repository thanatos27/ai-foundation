import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * AC-03: src/serve-http.ts run through tsx, as `npm run dev:http` does, without the developer's
 * .env, so that no test can reach a real provider. It listens on loopback only.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const command = process.execPath;
const baseArgs = ['--import', 'tsx', 'src/serve-http.ts', '--no-env-file'];
const KEY = 'e2e-api-key-0123456789abcdefghijklmnopqrstuv';

const DROPPED_VARS = [
  'AI_FOUNDATION_CONFIG',
  'AI_FOUNDATION_API_KEY',
  'AI_FOUNDATION_HTTP_HOST',
  'AI_FOUNDATION_HTTP_PORT',
  'PORT',
  'TODOIST_API_TOKEN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'NOTION_API_TOKEN',
  'GITHUB_TOKEN',
];

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const name of DROPPED_VARS) delete env[name];
  return { ...env, ...extra };
}

async function runExpectingFailure(args: string[], env: Record<string, string>) {
  const error = await promisify(execFile)(command, [...baseArgs, ...args], { cwd: repoRoot, env, timeout: 20_000 }).then(
    () => undefined,
    (e: { code?: number; stderr?: string }) => e,
  );
  expect(error, 'the server should exit with an error').toBeDefined();
  return { code: error!.code, stderr: error!.stderr ?? '' };
}

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
});

/** Starts the server on a free loopback port and resolves with its base URL once it listens. */
async function start(env: Record<string, string>): Promise<{ url: string; stderr: () => string }> {
  child = spawn(command, [...baseArgs, '--port', '0'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start: ${stderr}`)), 20_000);
    child!.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child!.once('exit', (code) => reject(new Error(`exited with ${code}: ${stderr}`)));
  });
  return { url, stderr: () => stderr };
}

describe('HTTP server (e2e)', { timeout: 30_000 }, () => {
  it.each([
    ['unset', {}],
    ['blank', { AI_FOUNDATION_API_KEY: '   ' }],
    ['too short', { AI_FOUNDATION_API_KEY: 'k'.repeat(31) }],
    ['not ASCII', { AI_FOUNDATION_API_KEY: '鍵'.repeat(40) }],
  ])('does not start when the API key is %s, saying why', async (_label, extra) => {
    const { code, stderr } = await runExpectingFailure([], childEnv(extra));
    expect(code).toBe(1);
    expect(stderr).toContain('AI_FOUNDATION_API_KEY');
    expect(stderr).not.toContain('listening');
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  it('checks the key before the config', async () => {
    const { stderr } = await runExpectingFailure(['--config', 'does-not-exist.yaml'], childEnv());
    expect(stderr).toContain('AI_FOUNDATION_API_KEY');
  });

  it('reports a bad config once the key is set', async () => {
    const { code, stderr } = await runExpectingFailure(['--config', 'does-not-exist.yaml'], childEnv({ AI_FOUNDATION_API_KEY: KEY }));
    expect(code).toBe(1);
    expect(stderr).toContain('Config file not found');
  });

  it('refuses an invalid port', async () => {
    const { code, stderr } = await runExpectingFailure(['--port', '70000'], childEnv({ AI_FOUNDATION_API_KEY: KEY }));
    expect(code).toBe(1);
    expect(stderr).toContain('--port must be a port number');
  });

  it('starts with the key and serves the API and its document behind it', async () => {
    const { url } = await start(childEnv({ AI_FOUNDATION_API_KEY: KEY }));
    const auth = { Authorization: `Bearer ${KEY}` };

    expect((await fetch(`${url}/openapi.json`)).status).toBe(401);
    const document = await fetch(`${url}/openapi.json`, { headers: auth });
    expect(document.status).toBe(200);
    expect(((await document.json()) as { info: { title: string } }).info.title).toBe('AI Foundation');

    // No provider credential in this environment: refused before any network access.
    const tasks = await fetch(`${url}/v1/tasks`, { headers: auth });
    expect(tasks.status).toBe(503);
    expect(await tasks.json()).toEqual({
      error: { code: 'credential_missing', message: 'Credential error: Todoist credential is not configured: set TODOIST_API_TOKEN' },
    });
  });

  it('stops on a signal', async () => {
    await start(childEnv({ AI_FOUNDATION_API_KEY: KEY }));
    const exited = once(child!, 'exit');
    child!.kill('SIGTERM');
    await exited;
    expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
  });
});
