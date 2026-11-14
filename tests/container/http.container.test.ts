import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * The container image (Dockerfile) as Cloud Run runs it: PORT set by the platform, the config
 * mounted as a file, no .env. No credential is passed, so no test reaches a provider.
 *
 * AI_FOUNDATION_CONTAINER_IMAGE (an image ID or tag) tests that image without building it, so the
 * image deployed is the one tested (docs/deploy/cloud-run.md). Without it the image is built here.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureConfig = fileURLToPath(new URL('../fixtures/container/config.yaml', import.meta.url));
const KEY = 'container-api-key-0123456789abcdefghijklmnop';
const CONFIG_IN_CONTAINER = '/etc/ai-foundation/config.yaml';
const PLATFORM = 'linux/amd64';
/** The FROM of the Dockerfile's final stage. */
const BASE_IMAGE = 'node:24-bookworm-slim';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function docker(args: string[], timeout = 120_000): Promise<Run> {
  return promisify(execFile)('docker', args, { timeout, maxBuffer: 64 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number | string; stdout?: string; stderr?: string }) => {
      if (typeof error.code !== 'number') throw error; // docker missing, timeout
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    },
  );
}

async function dockerOk(args: string[], timeout?: number): Promise<string> {
  const run = await docker(args, timeout);
  if (run.code !== 0) throw new Error(`docker ${args.join(' ')} failed (${run.code}): ${run.stderr}`);
  return run.stdout.trim();
}

/** Builds `context` and returns the image ID. */
async function build(context: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'aif-iid-'));
  try {
    const iidFile = join(dir, 'iid');
    await dockerOk(['build', '--platform', PLATFORM, '--iidfile', iidFile, context], 600_000);
    return (await readFile(iidFile, 'utf8')).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let image: string;
let builtHere = false;
let scratch: string;
const containers: string[] = [];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'aif-container-'));
  const given = process.env.AI_FOUNDATION_CONTAINER_IMAGE?.trim();
  if (given) {
    image = given;
  } else {
    image = await build(repoRoot);
    builtHere = true;
  }
});

afterEach(async () => {
  for (const id of containers.splice(0)) await docker(['rm', '-f', id]);
});

afterAll(async () => {
  if (builtHere && image) await docker(['rmi', image]);
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const mountConfig = (path: string) => ['-v', `${path}:${CONFIG_IN_CONTAINER}:ro`];
const baseEnv = ['-e', 'PORT=8080', '-e', `AI_FOUNDATION_CONFIG=${CONFIG_IN_CONTAINER}`];

/** Runs the image in the foreground (expected to exit). */
async function runToExit(args: string[]): Promise<Run> {
  return docker(['run', '--rm', '--platform', PLATFORM, ...args, image], 60_000);
}

/** Runs a shell command in the image instead of the server. */
async function shell(command: string, user?: string): Promise<Run> {
  return docker(['run', '--rm', '--platform', PLATFORM, ...(user ? ['--user', user] : []), '--entrypoint', 'sh', image, '-c', command]);
}

/** Starts the server detached and resolves once it listens; returns its host URL. */
async function startServer(): Promise<{ id: string; url: string; logs: () => Promise<string> }> {
  const id = await dockerOk([
    'run', '-d', '--platform', PLATFORM, '-p', '127.0.0.1::8080',
    ...baseEnv, '-e', `AI_FOUNDATION_API_KEY=${KEY}`, ...mountConfig(fixtureConfig), image,
  ]);
  containers.push(id);
  const logs = async () => {
    const run = await docker(['logs', id]);
    return run.stdout + run.stderr;
  };
  const deadline = Date.now() + 30_000;
  while (!(await logs()).includes('listening on')) {
    if (Date.now() > deadline) throw new Error(`did not start: ${await logs()}`);
    const state = await dockerOk(['inspect', '-f', '{{.State.Running}}', id]);
    if (state !== 'true') throw new Error(`exited: ${await logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const port = /:(\d+)\s*$/m.exec(await dockerOk(['port', id, '8080/tcp']))?.[1];
  return { id, url: `http://127.0.0.1:${port}`, logs };
}

describe('container: serving (AC-C01, AC-C02, AC-C05, AC-C06)', () => {
  it('listens on 0.0.0.0 at PORT as a single node process, behind the API key, and stops on SIGTERM', async () => {
    const { id, url, logs } = await startServer();
    expect(await logs()).toContain('HTTP server listening on http://0.0.0.0:8080');

    // One process in the container: node, as PID 1 (docker top lists every process).
    const processes = (await dockerOk(['top', id])).split('\n').slice(1).filter((line) => line.trim() !== '');
    expect(processes).toHaveLength(1);
    expect(processes[0]).toContain('node dist/serve-http.js --no-env-file --host 0.0.0.0');
    // /proc/1/comm is "MainThread" (node names its main thread); the command line says what PID 1 is.
    const pid1 = (await dockerOk(['exec', id, 'cat', '/proc/1/cmdline'])).split('\0');
    expect(pid1.slice(0, 2)).toEqual(['node', 'dist/serve-http.js']);

    expect((await fetch(`${url}/openapi.json`)).status).toBe(401);
    expect((await fetch(`${url}/openapi.json`, { headers: { Authorization: 'Bearer wrong-key' } })).status).toBe(401);
    const document = await fetch(`${url}/openapi.json`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(document.status).toBe(200);
    expect(((await document.json()) as { openapi: string }).openapi).toBe('3.1.0');

    // No credential in the container: refused before any network access.
    const tasks = await fetch(`${url}/v1/tasks`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(tasks.status).toBe(503);
    expect(((await tasks.json()) as { error: { code: string } }).error.code).toBe('credential_missing');

    const started = Date.now();
    await dockerOk(['stop', '-t', '15', id]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await dockerOk(['inspect', '-f', '{{.State.ExitCode}}', id])).toBe('0');
  });
});

describe('container: refuses to start (AC-C04, AC-C05)', () => {
  it.each([
    ['unset', [], /AI_FOUNDATION_API_KEY is not set/],
    ['too short', ['-e', `AI_FOUNDATION_API_KEY=${'k'.repeat(31)}`], /at least 32 characters/],
  ])('without a usable API key (%s), naming no value', async (_label, keyEnv, reason) => {
    const run = await runToExit([...baseEnv, ...keyEnv, ...mountConfig(fixtureConfig)]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(reason);
    expect(run.stderr).not.toContain('k'.repeat(31));
    expect(run.stderr).not.toContain('listening');
  });

  it('without AI_FOUNDATION_CONFIG: the image holds no config of its own', async () => {
    const run = await runToExit(['-e', 'PORT=8080', '-e', `AI_FOUNDATION_API_KEY=${KEY}`]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Config file not found: /app/config.yaml');
  });

  it.each([
    ['invalid YAML', 'version: "0.1"\ndefaults: [unclosed\n', /Invalid YAML in/],
    ['a schema violation', 'version: "0.2"\n', /Invalid configuration in/],
  ])('with %s in the mounted config', async (_label, text, reason) => {
    const path = join(scratch, `bad-${Math.random().toString(36).slice(2)}.yaml`);
    await writeFile(path, text, 'utf8');
    const run = await runToExit([...baseEnv, '-e', `AI_FOUNDATION_API_KEY=${KEY}`, ...mountConfig(path)]);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(reason);
  });
});

/** Names of files that hold secrets or personal config. */
const SECRET_NAMES = ['.env*', 'config*.yaml', 'credentials*.json', 'token*.json', '*.pem', '*.key'];
const findSecrets = (root: string) =>
  `find ${root} -xdev \\( ${SECRET_NAMES.map((name) => `-name '${name}'`).join(' -o ')} \\) -print 2>/dev/null | sort`;

describe('container: image contents (AC-C01, AC-C04)', () => {
  it('runs as a non-root user that cannot change the app', async () => {
    expect((await shell('id -u')).stdout.trim()).not.toBe('0');
    const write = await shell('touch /app/dist/serve-http.js || echo READ_ONLY');
    expect(write.stdout).toContain('READ_ONLY');
  });

  it('holds only package.json, the production dependencies and dist/ under /app', async () => {
    expect((await shell('ls -A /app')).stdout.trim().split('\n')).toEqual(['dist', 'node_modules', 'package.json']);
    // devDependencies were pruned.
    expect((await shell('test -e /app/node_modules/vitest || echo PRUNED')).stdout).toContain('PRUNED');
  });

  it('adds no secret-like file outside the packaged dependencies', async () => {
    const ours = (await shell(findSecrets('/'), '0')).stdout.split('\n').filter(Boolean);
    // Files of the base image (e.g. CA certificates) are not ours.
    const baseFiles = new Set(
      (await docker(['run', '--rm', '--platform', PLATFORM, '--user', '0', '--entrypoint', 'sh', BASE_IMAGE, '-c', findSecrets('/')])).stdout
        .split('\n')
        .filter(Boolean),
    );
    const added = ours.filter((path) => !baseFiles.has(path) && !path.startsWith('/app/node_modules/'));
    expect(added).toEqual([]);
  });

  it('has no credential or config variable in its environment or build history', async () => {
    const env = await dockerOk(['image', 'inspect', '-f', '{{json .Config.Env}}', image]);
    expect(env).not.toMatch(/AI_FOUNDATION_|TODOIST_|GOOGLE_|NOTION_|GITHUB_/);
    const history = await dockerOk(['history', '--no-trunc', '--format', '{{.CreatedBy}}', image]);
    expect(history).not.toMatch(/(^|[\s/])\.env\b|config\.(local|cloud)\.yaml|AI_FOUNDATION_API_KEY|_TOKEN|_SECRET/);
  });
});

describe('container: build context (AC-C04)', () => {
  // Built from a copy in a temporary directory, never from the working tree: real .env.cloud and
  // config.cloud.yaml files there must not be created, overwritten or deleted by a test.
  const DUMMIES = ['.env', '.env.cloud', 'config.local.yaml', 'config.cloud.yaml', 'credentials.json', 'archive.zip'];

  it('sends only the .dockerignore allowlist, and the image holds none of the rest', async () => {
    const context = await mkdtemp(join(tmpdir(), 'aif-context-'));
    let isolated: string | undefined;
    try {
      for (const name of ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) {
        await cp(join(repoRoot, name), join(context, name));
      }
      await cp(join(repoRoot, 'src'), join(context, 'src'), { recursive: true });
      for (const name of DUMMIES) await writeFile(join(context, name), 'DUMMY_SECRET_VALUE\n', 'utf8');

      // What the build context holds, whatever the Dockerfile copies: the same context and
      // .dockerignore, copied whole by a probe Dockerfile kept outside the context.
      const probeDir = await mkdtemp(join(tmpdir(), 'aif-probe-'));
      try {
        const probe = join(probeDir, 'Dockerfile');
        await writeFile(probe, `FROM ${BASE_IMAGE}\nCOPY . /ctx\n`, 'utf8');
        const iidFile = join(probeDir, 'iid');
        await dockerOk(['build', '--platform', PLATFORM, '-f', probe, '--iidfile', iidFile, context], 600_000);
        const probeImage = (await readFile(iidFile, 'utf8')).trim();
        try {
          const listed = await dockerOk(['run', '--rm', '--platform', PLATFORM, '--entrypoint', 'sh', probeImage, '-c', 'ls -A /ctx']);
          expect(listed.split('\n').sort()).toEqual(['package-lock.json', 'package.json', 'src', 'tsconfig.build.json', 'tsconfig.json']);
        } finally {
          await docker(['rmi', probeImage]);
        }
      } finally {
        await rm(probeDir, { recursive: true, force: true });
      }

      isolated = await build(context);
      const found = await docker([
        'run', '--rm', '--platform', PLATFORM, '--user', '0', '--entrypoint', 'sh', isolated, '-c',
        `find / -xdev \\( ${DUMMIES.map((name) => `-name '${name}'`).join(' -o ')} \\) -print 2>/dev/null; grep -rl DUMMY_SECRET_VALUE /app 2>/dev/null; true`,
      ]);
      expect(found.stdout.trim()).toBe('');
    } finally {
      if (isolated) await docker(['rmi', isolated]);
      await rm(context, { recursive: true, force: true });
    }
  });
});
