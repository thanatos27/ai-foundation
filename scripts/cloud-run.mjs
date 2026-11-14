import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CREDENTIALS = {
  'api-key': 'AI_FOUNDATION_API_KEY',
  'todoist-api-token': 'TODOIST_API_TOKEN',
  'google-oauth-client-id': 'GOOGLE_OAUTH_CLIENT_ID',
  'google-oauth-client-secret': 'GOOGLE_OAUTH_CLIENT_SECRET',
  'google-oauth-refresh-token': 'GOOGLE_OAUTH_REFRESH_TOKEN',
  'notion-api-token': 'NOTION_API_TOKEN',
  'github-token': 'GITHUB_TOKEN',
};

class SafeError extends Error {}
const fail = (message) => { throw new SafeError(message); };
const numericVersion = (v) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);

export function validateConfig(c) {
  const fields = ['project', 'region', 'service', 'repository', 'image', 'configVersion', 'credentialVersions'];
  if (!c || typeof c !== 'object' || Array.isArray(c) ||
      Object.keys(c).some(k => !fields.includes(k)) || fields.some(k => !(k in c))) {
    fail('Invalid deployment config fields. See deploy.cloud.example.json.');
  }
  if (typeof c.project !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c.project)) fail('Invalid project ID.');
  if (typeof c.region !== 'string' || !/^[a-z]+-[a-z]+[0-9]+$/.test(c.region)) fail('Invalid region.');
  for (const k of ['service', 'repository', 'image']) {
    if (typeof c[k] !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(c[k])) fail(`Invalid ${k}.`);
  }
  if (!numericVersion(c.configVersion)) fail('Config version must be a positive integer string.');
  const versions = c.credentialVersions;
  if (!versions || typeof versions !== 'object' || Array.isArray(versions) ||
      Object.keys(versions).length !== Object.keys(CREDENTIALS).length ||
      Object.keys(versions).some(k => !(k in CREDENTIALS)) ||
      Object.keys(CREDENTIALS).some(k => !numericVersion(versions[k]))) {
    fail('All seven credential versions must be positive integer strings.');
  }
  return c;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['status', 'deploy', 'rollback'].includes(command)) fail('Use status, deploy, or rollback.');
  const options = { command, config: 'deploy.cloud.local.json', writesPaused: false };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (seen.has(flag)) fail('Duplicate option.');
    seen.add(flag);
    if (flag === '--writes-paused') options.writesPaused = true;
    else if (flag === '--config' || flag === '--revision') {
      const value = rest[++i];
      if (!value || value.startsWith('--')) fail('Option value missing.');
      options[flag.slice(2)] = value;
    } else fail('Unknown option.');
  }
  if (command === 'status' && (options.writesPaused || options.revision)) fail('status accepts only --config.');
  if (command === 'deploy' && options.revision) fail('--revision is for rollback only.');
  if (command === 'rollback' && !options.revision) fail('rollback requires --revision.');
  if (command !== 'status' && !options.writesPaused) {
    fail('Pause client writes and local writers, then add --writes-paused.');
  }
  return options;
}

// stdout/stderr are capture-only. Never expose subprocess output in an error.
export async function execute(file, args, { cwd, env = process.env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    const collect = target => chunk => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { child.kill(); return; }
      if (target === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', () => reject(new Error('Cannot start required executable. Check local CLI installation.')));
    child.on('close', code => {
      if (size > 32 * 1024 * 1024) reject(new Error('Command output exceeded capture limit.'));
      else resolve({ code, stdout, stderr });
    });
  });
}

export async function resolveTools({ platform = process.platform, exec = execute, env = process.env,
  exists = existsSync, node = process.execPath } = {}) {
  const npmCli = env.npm_execpath || path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!path.isAbsolute(npmCli) || !exists(npmCli)) fail('Run from npm, or install npm alongside Node.');
  const tools = { npm: [node, npmCli], node: [node], git: [platform === 'win32' ? 'git.exe' : 'git'],
    docker: [platform === 'win32' ? 'docker.exe' : 'docker'], gcloud: ['gcloud'] };
  if (platform === 'win32') {
    const result = await exec('where.exe', ['gcloud.cmd']);
    if (result.code !== 0) fail('Google Cloud CLI not found.');
    const launcher = result.stdout.split(/\r?\n/).find(v => v.trim() && exists(v.trim()));
    if (!launcher) fail('Google Cloud CLI not found.');
    const sdk = path.win32.resolve(path.win32.dirname(launcher.trim()), '..');
    const script = path.win32.join(sdk, 'lib', 'gcloud.py');
    let python = env.CLOUDSDK_PYTHON || path.win32.join(sdk, 'platform', 'bundledpython', 'python.exe');
    if (!path.win32.isAbsolute(python) || !exists(python) || !exists(script)) {
      fail('Cloud SDK bundled Python not found. Set CLOUDSDK_PYTHON to an absolute python.exe path.');
    }
    tools.gcloud = [python, script];
  }
  return tools;
}

export function activeRevision(service) {
  const traffic = service?.status?.traffic;
  if (!Array.isArray(traffic)) fail('Service traffic is unavailable.');
  const serving = traffic.filter(t => Number(t.percent) > 0);
  if (serving.length !== 1 || Number(serving[0].percent) !== 100 || !serving[0].revisionName) {
    fail('Expected one revision serving 100%; split traffic is unsupported.');
  }
  return serving[0].revisionName;
}

export function assertRevision(revision, name, service) {
  if (revision?.metadata?.name !== name || revision?.metadata?.labels?.['serving.knative.dev/service'] !== service ||
      !revision?.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) {
    fail('Revision is not Ready or does not belong to this service.');
  }
}

export function resolveSecretName(revision, lookup, project, projectNumber) {
  if (typeof lookup !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(lookup)) fail('Invalid Secret reference name.');
  const aliases = revision?.metadata?.annotations?.['run.googleapis.com/secrets'];
  if (!aliases) return lookup;
  for (const alias of aliases.split(',')) {
    const separator = alias.indexOf(':');
    if (separator < 0) fail('Invalid Secret alias metadata.');
    if (alias.slice(0, separator).trim() !== lookup) continue;
    const resource = alias.slice(separator + 1).trim().match(/^projects\/([a-z0-9-]+)\/secrets\/([a-zA-Z0-9_-]+)$/);
    if (!resource || (resource[1] !== project &&
        !(typeof projectNumber === 'string' && /^[0-9]+$/.test(projectNumber) && resource[1] === projectNumber))) {
      fail('Cross-project Secret aliases are unsupported.');
    }
    return resource[2];
  }
  return lookup;
}

export function apiKeyReference(revision, project, projectNumber) {
  const ref = revision?.spec?.containers?.[0]?.env?.find(e => e.name === 'AI_FOUNDATION_API_KEY')?.valueFrom?.secretKeyRef;
  if (!ref || !/^[a-zA-Z0-9_-]+$/.test(ref.name) || !numericVersion(ref.key)) {
    fail('Revision API key must reference a numeric Secret version in this project.');
  }
  return { name: resolveSecretName(revision, ref.name, project, projectNumber), key: ref.key };
}

export function bareDigest(value) {
  const match = typeof value === 'string' && value.match(/(?:^|@)(sha256:[a-f0-9]{64})$/);
  if (!match) fail('Invalid revision image digest.');
  return match[1];
}

export function serviceUrl(service) {
  let u;
  try { u = new URL(service.status.url); } catch { fail('Service HTTPS URL unavailable.'); }
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.run.app') || u.username || u.password || u.port ||
      u.pathname !== '/' || u.search || u.hash) fail('Expected a standard Cloud Run HTTPS URL.');
  return u.origin;
}

export async function smoke(url, key, fetcher = fetch) {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{32,}$/.test(key)) fail('API key is invalid.');
  const now = new Date();
  const q = new URLSearchParams({ start: now.toISOString(), end: new Date(+now + 604800000).toISOString() });
  const checks = [
    ['/openapi.json', undefined, 401], ['/openapi.json', 'wrong-key', 401], ['/openapi.json', key, 200],
    ...['/v1/projects', '/v1/tasks', `/v1/schedules?${q}`, '/v1/collection-items', '/v1/areas'].map(p => [p, key, 200]),
  ];
  for (const [route, token, expected] of checks) {
    let response;
    try {
      response = await fetcher(url + route, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60000),
        headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (response.status !== expected) fail('status mismatch');
      // Cancel rather than log/store provider data; status is sufficient for read-only smoke.
      await response.body?.cancel();
    } catch { fail(`Read-only smoke failed: ${route.split('?')[0]} (expected ${expected}).`); }
  }
  return checks.length;
}

export function secretBindings(c) {
  return [`/etc/ai-foundation/config.yaml=ai-foundation-config:${c.configVersion}`,
    ...Object.entries(CREDENTIALS).map(([name, variable]) => `${variable}=ai-foundation-${name}:${c.credentialVersions[name]}`)].join(',');
}

export function revisionVersions(revision, project, projectNumber) {
  const container = revision.spec?.containers?.[0];
  const credentialVersions = Object.fromEntries(Object.entries(CREDENTIALS).map(([name, variable]) =>
    [name, container?.env?.find(e => e.name === variable)?.valueFrom?.secretKeyRef?.key ?? null]));
  // A revision may keep unmounted volumes from earlier updates. Record only the one mounted at the Config path.
  const mount = container?.volumeMounts?.find(m => m.mountPath === '/etc/ai-foundation');
  const volume = mount && revision.spec?.volumes?.find(v => v.name === mount.name && v.secret &&
    resolveSecretName(revision, v.secret.secretName, project, projectNumber) === 'ai-foundation-config');
  const configVersion = volume?.secret?.items?.find(i => i.path === 'config.yaml')?.key ?? null;
  return { configVersion, credentialVersions };
}

export async function withLock(root, task) {
  const dir = path.join(root, '.deploy');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'cloud-run.lock');
  let fd;
  try { fd = await open(lock, 'wx', 0o600); }
  catch { fail('Deployment lock exists or is inaccessible. Check for an active run; do not remove a live lock.'); }
  try { await fd.writeFile(String(process.pid)); return await task(dir); }
  finally { await fd.close(); await unlink(lock); }
}

export function publicSummary(record) {
  return ['# Cloud Run deployment', `Command: ${record.command}`, `Phase: ${record.phase}`,
    `Commit: ${record.commit || 'n/a'}`, `Digest: ${record.digest || 'n/a'}`,
    `Previous revision: ${record.before || 'n/a'}`, `Revision: ${record.revision || 'n/a'}`,
    `Config version: ${record.configVersion || 'n/a'}`, `Smoke: ${record.smoke || 'not completed'}`, ''].join('\n');
}

export function recoveryCommand(revision, config) {
  const base = `npm run cloud:rollback -- --revision ${revision} --writes-paused`;
  // A single command is portable for simple paths. Never echo a path containing shell syntax.
  if (/^[a-zA-Z0-9_./-]+$/.test(config)) return `${base} --config ${config}`;
  return `${base} --config <same-config-file> (use configPath in the private journal; quote for your shell)`;
}

export async function runAutomation(options, {
  root = process.cwd(), exec = execute, tools, fetcher = fetch, log = console.log,
  id = randomUUID().replaceAll('-', '').slice(0, 10),
} = {}) {
  let config;
  try { config = validateConfig(JSON.parse(await readFile(path.resolve(root, options.config), 'utf8'))); }
  catch { fail('Cannot read a valid deployment config. See deploy.cloud.example.json.'); }
  tools ||= await resolveTools();
  const c = config;
  async function command(tool, args, extra = {}) {
    const [file, ...prefix] = tools[tool];
    const result = await exec(file, [...prefix, ...args], { cwd: root, ...extra });
    if (result.code !== 0) fail(`${tool} command failed (exit ${result.code}); output withheld. Check authentication and permissions.`);
    return result.stdout.trim();
  }
  const gc = (args, run = true) => command('gcloud', [...args, `--project=${c.project}`, '--quiet',
    ...(run ? [`--region=${c.region}`] : [])]);
  const json = async (args, run = true) => {
    try { return JSON.parse(await gc([...args, '--format=json'], run)); }
    catch { fail('Cloud CLI query failed or returned invalid JSON. Check authentication, permissions and resource existence.'); }
  };
  const getService = () => json(['run', 'services', 'describe', c.service]);
  const getRevision = async name => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(name) || !name.startsWith(c.service + '-')) {
      fail('Invalid revision name.');
    }
    const revision = await json(['run', 'revisions', 'describe', name]);
    assertRevision(revision, name, c.service);
    return revision;
  };
  if (options.command === 'status') {
    const service = await getService();
    const current = activeRevision(service);
    const revision = await getRevision(current);
    const result = { project: c.project, region: c.region, service: c.service, revision: current,
      image: revision.spec.containers?.[0]?.image, resources: revision.spec.containers?.[0]?.resources,
      annotations: Object.fromEntries(Object.entries(revision.metadata.annotations || {}).filter(([k]) =>
        ['autoscaling.knative.dev/maxScale', 'autoscaling.knative.dev/minScale', 'run.googleapis.com/cpu-throttling',
          'run.googleapis.com/startup-cpu-boost'].includes(k))),
      secretVersions: revision.spec.containers?.[0]?.env?.filter(e => e.valueFrom?.secretKeyRef).map(e =>
        ({ variable: e.name, ...e.valueFrom.secretKeyRef })),
      configVolumes: revision.spec.volumes?.filter(v => v.secret).map(v => ({ name: v.name, secret: v.secret })) };
    log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!options.writesPaused) fail('Pause writes and pass --writes-paused.');
  return await withLock(root, async dir => {
    const record = { command: options.command, configPath: options.config, phase: 'preflight', time: new Date().toISOString(),
      configVersion: c.configVersion, credentialVersions: c.credentialVersions };
    const recordPath = path.join(dir, `${Date.now()}-${id}.json`);
    // Reserve a unique journal, never overwrite a prior deployment.
    const journal = await open(recordPath, 'wx', 0o600);
    await journal.close();
    async function save() {
      const fd = await open(recordPath, 'r+');
      try { await fd.truncate(0); await fd.writeFile(JSON.stringify(record, null, 2) + '\n'); }
      finally { await fd.close(); }
    }
    const phase = async name => { record.phase = name; log(`[cloud] ${name}`); await save(); };
    try {
      await phase('preflight');
      const service = await getService(); // Existing service required; never treat arbitrary errors as NOT_FOUND.
      record.before = activeRevision(service);
      const url = serviceUrl(service);
      let target;
      if (options.command === 'deploy') {
        if (await command('git', ['status', '--porcelain', '--untracked-files=normal'])) {
          fail('Working tree is not clean. Commit source changes; keep personal config ignored.');
        }
        record.commit = await command('git', ['rev-parse', 'HEAD']);
        if (!/^[a-f0-9]{40}$/.test(record.commit)) fail('Invalid Git commit.');
        await command('docker', ['version', '--format', '{{.Server.Version}}']);
        await phase('tests');
        for (const args of [['ci'], ['run', 'typecheck'], ['run', 'build'], ['test'], ['run', 'test:cloud']]) {
          await command('npm', args);
        }
        await phase('image-build');
        const candidate = `ai-foundation:candidate-${id}`;
        await command('docker', ['build', '--pull', '--platform', 'linux/amd64', '-t', candidate, '.']);
        const imageId = await command('docker', ['image', 'inspect', '-f', '{{.Id}}', candidate]);
        if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) fail('Invalid local image ID.');
        await phase('container-tests');
        await command('npm', ['run', 'test:container'], { env: { ...process.env, AI_FOUNDATION_CONTAINER_IMAGE: imageId } });
        await phase('image-push');
        const image = `${c.region}-docker.pkg.dev/${c.project}/${c.repository}/${c.image}`;
        const tagged = `${image}:${record.commit.slice(0, 12)}-${id}`;
        await command('docker', ['tag', imageId, tagged]);
        await command('docker', ['push', tagged]);
        const remote = await json(['artifacts', 'docker', 'images', 'describe', tagged], false);
        record.digest = remote.image_summary?.digest;
        if (!/^sha256:[a-f0-9]{64}$/.test(record.digest)) fail('Invalid registry digest.');
        await phase('revision-prepare');
        const suffix = `c${record.commit.slice(0, 7)}-${id}`;
        record.revision = `${c.service}-${suffix}`;
        await save();
        // Re-check source after tests (test/build hooks must not modify reviewed source).
        if (await command('git', ['status', '--porcelain', '--untracked-files=normal']) ||
            await command('git', ['rev-parse', 'HEAD']) !== record.commit) {
          fail('Source changed during build/test; refusing deployment.');
        }
        await gc(['run', 'deploy', c.service, `--image=${image}@${record.digest}`,
          `--revision-suffix=${suffix}`, '--no-traffic',
          `--service-account=ai-foundation-run@${c.project}.iam.gserviceaccount.com`,
          '--cpu-throttling', '--cpu=1', '--memory=512Mi', '--cpu-boost', '--min-instances=0',
          '--max-instances=1', '--concurrency=80', '--timeout=300', '--allow-unauthenticated', '--ingress=all',
          '--set-env-vars=AI_FOUNDATION_CONFIG=/etc/ai-foundation/config.yaml', `--set-secrets=${secretBindings(c)}`]);
        target = await getRevision(record.revision);
      } else {
        record.revision = options.revision;
        await phase('rollback-prepare');
        target = await getRevision(record.revision);
        record.digest = bareDigest(target.status?.imageDigest);
      }
      // Cloud Run v1 namespaces normally contain the project number. If absent, resolve
      // it through the explicitly scoped project API before comparing annotation aliases.
      let projectNumber = target.metadata?.namespace;
      if (target.metadata?.annotations?.['run.googleapis.com/secrets'] &&
          !(typeof projectNumber === 'string' && /^[0-9]+$/.test(projectNumber))) {
        const projectInfo = await json(['projects', 'describe', c.project], false);
        if (projectInfo.projectId !== c.project || !/^[0-9]+$/.test(String(projectInfo.projectNumber))) {
          fail('Could not resolve the target project number.');
        }
        projectNumber = String(projectInfo.projectNumber);
      }
      if (options.command === 'rollback') Object.assign(record, revisionVersions(target, c.project, projectNumber));
      // Access the exact target revision's API-key version, including after key rotation.
      // Requires the operator to have secretAccessor. Only capture the value in memory.
      const ref = apiKeyReference(target, c.project, projectNumber);
      const key = await gc(['secrets', 'versions', 'access', ref.key, `--secret=${ref.name}`], false);
      if (!/^[\x21-\x7e]{32,}$/.test(key)) fail('Target API key is invalid.');
      await phase('traffic-check');
      if (activeRevision(await getService()) !== record.before) fail('Traffic changed externally; refusing to switch.');
      await phase('traffic-switch');
      await gc(['run', 'services', 'update-traffic', c.service, `--to-revisions=${record.revision}=100`]);
      const serving = await getService();
      if (activeRevision(serving) !== record.revision) fail('Traffic did not move to the requested revision.');
      await phase('read-only-smoke');
      record.smoke = await smoke(serviceUrl(serving), key, fetcher);
      await phase('complete');
      const summary = await open(recordPath.replace(/\.json$/, '.public.md'), 'wx', 0o600);
      try { await summary.writeFile(publicSummary(record)); } finally { await summary.close(); }
      log('[cloud] Completed. Result recorded under .deploy/ (do not publish private JSON).');
      return record;
    } catch (error) {
      record.failedPhase = record.phase;
      record.phase = 'failed';
      // Do not persist arbitrary error text from providers, fetch, filesystem or SDKs.
      await save();
      log('[cloud] Failed. No automatic rollback or SoT writes were performed.');
      if (record.before) log(`Recovery: ${recoveryCommand(record.before, options.config)}`);
      throw error;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAutomation(parseArguments(process.argv.slice(2))); }
  catch (error) {
    // Never print untrusted errors, raw subprocess output, provider bodies or Secret values.
    console.error(error instanceof SafeError ? `[cloud] ${error.message}` :
      '[cloud] Command failed. Check configuration, local prerequisites and the last phase above.');
    process.exitCode = 1;
  }
}
