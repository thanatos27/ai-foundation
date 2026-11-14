import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CREDENTIALS, validateConfig, parseArguments, activeRevision, assertRevision, apiKeyReference,
  serviceUrl, smoke, execute, resolveTools, withLock, runAutomation, publicSummary, revisionVersions } from '../../scripts/cloud-run.mjs';

const key = 'dummy-only-key-'.padEnd(48, 'x');
const old = 'ai-foundation-old';
const digest = 'sha256:' + 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
const commit = 'c'.repeat(40);
const config = () => ({ project: 'example-project', region: 'asia-northeast1', service: 'ai-foundation',
  repository: 'ai-foundation', image: 'ai-foundation', configVersion: '2',
  credentialVersions: Object.fromEntries(Object.keys(CREDENTIALS).map(k => [k, '1'])) });
const revision = name => ({ metadata: { name, labels: { 'serving.knative.dev/service': 'ai-foundation' } },
  status: { conditions: [{ type: 'Ready', status: 'True' }], imageDigest: digest },
  spec: { containers: [{ image: digest, env: [{ name: 'AI_FOUNDATION_API_KEY',
    valueFrom: { secretKeyRef: { name: 'ai-foundation-api-key', key: '1' } } }], resources: { limits: { cpu: '1' } } }] } });
const service = name => ({ status: { url: 'https://example.asia-northeast1.run.app',
  latestReadyRevisionName: 'ai-foundation-unrelated-latest', traffic: [{ revisionName: name, percent: 100 }] } });
const ok = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });

async function fixture(t, opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'foundation-cloud-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'deploy.cloud.local.json'), JSON.stringify(config()));
  const calls = [], requests = [], logs = [];
  let serving = old, switches = 0, serviceReads = 0, gitStatusReads = 0;
  const exec = async (tool, args, extra) => {
    calls.push({ tool, args, extra });
    if (opts.fail?.(tool, args)) return { code: 17, stdout: key, stderr: key };
    if (tool === 'git') {
      if (args[0] === 'status') {
        gitStatusReads++;
        return ok(opts.dirty || (opts.sourceChanged && gitStatusReads > 1) ? ' M src/index.ts' : '');
      }
      return ok(commit);
    }
    if (tool === 'docker') return ok(args[0] === 'image' ? imageId : 'success');
    if (tool === 'npm') return ok('tests passed');
    if (tool !== 'gcloud') throw new Error('unexpected executable');
    if (args[0] === 'artifacts') return ok({ image_summary: { digest } });
    if (args[0] === 'secrets') return ok(opts.invalidKey ? 'invalid' : key);
    if (args[1] === 'deploy') return ok({});
    if (args[1] === 'revisions') {
      const r = revision(args[3]);
      if (opts.foreign) r.metadata.labels['serving.knative.dev/service'] = 'another-service';
      if (opts.keyVersion) r.spec.containers[0].env[0].valueFrom.secretKeyRef.key = opts.keyVersion;
      if (opts.notReady) r.status.conditions[0].status = 'False';
      return ok(r);
    }
    if (args[2] === 'update-traffic') {
      serving = args.find(a => a.startsWith('--to-revisions=')).slice('--to-revisions='.length).split('=')[0];
      switches++;
      return ok(service(serving));
    }
    serviceReads++;
    if (opts.externalChange && serviceReads === 2) serving = 'ai-foundation-external';
    const s = service(serving);
    if (opts.split) s.status.traffic = [{ revisionName: old, percent: 50 }, { revisionName: 'ai-foundation-other', percent: 50 }];
    return ok(s);
  };
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    if (opts.fetchError) throw new Error(key);
    const auth = options.headers.Authorization;
    return { status: auth === `Bearer ${key}` ? (opts.smokeFailure ? 502 : 200) : 401,
      body: { cancel: async () => {} } };
  };
  const deps = { root, exec, tools: { git: ['git'], docker: ['docker'], npm: ['npm'], gcloud: ['gcloud'] },
    fetcher, log: msg => logs.push(msg), id: '0123456789' };
  return { root, calls, requests, logs, deps, switches: () => switches };
}
const deployOptions = { command: 'deploy', config: 'deploy.cloud.local.json', writesPaused: true };
const rollbackOptions = { ...deployOptions, command: 'rollback', revision: 'ai-foundation-older' };

test('configuration rejects unsafe identifiers, latest versions, unknown or missing fields', () => {
  assert.equal(validateConfig(config()).configVersion, '2');
  for (const change of [{ project: 'bad;cmd' }, { service: '--flag' }, { region: 'x&echo' },
    { configVersion: 'latest' }, { extra: 'unknown' }, { region: ['asia-northeast1'] }, { credentialVersions: {} }]) {
    assert.throws(() => validateConfig({ ...config(), ...change }));
  }
});
test('CLI requires explicit quiescence and strict arguments', () => {
  assert.throws(() => parseArguments(['deploy']), /writes-paused/);
  assert.throws(() => parseArguments(['rollback', '--writes-paused']), /revision/);
  assert.throws(() => parseArguments(['status', '--skip-tests']));
  assert.throws(() => parseArguments(['status', '--writes-paused']));
  assert.throws(() => parseArguments(['deploy', '--writes-paused', '--writes-paused']));
  assert.equal(parseArguments(['rollback', '--revision', old, '--writes-paused']).revision, old);
});
test('traffic selection uses serving revision, not latestReady; rejects split and empty', () => {
  assert.equal(activeRevision(service(old)), old);
  assert.throws(() => activeRevision({ status: { traffic: [] } }));
  assert.throws(() => activeRevision({ status: { traffic: [{ percent: 50 }, { percent: 50 }] } }));
});
test('revision and Secret references validated before access', () => {
  assertRevision(revision(old), old, 'ai-foundation');
  assert.throws(() => assertRevision(revision(old), old, 'other'));
  const r = revision(old);
  r.spec.containers[0].env[0].valueFrom.secretKeyRef.key = 'latest';
  assert.throws(() => apiKeyReference(r, 'example-project'));
});
test('service URLs reject redirects to alternate origins before any API call', () => {
  for (const url of ['http://example.run.app', 'https://evil.test', 'https://x.run.app.evil.test',
    'https://x.run.app:8443', 'https://a:b@x.run.app', 'https://x.run.app/path']) {
    assert.throws(() => serviceUrl({ status: { url } }));
  }
});
test('real subprocess runner passes shell metacharacters literally', async () => {
  const value = 'space & echo $() ` ; | "quoted"';
  const r = await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, value);
});
test('Windows tool resolver invokes SDK Python and npm Node entrypoints without cmd.exe', async () => {
  const node = process.execPath;
  const launcher = 'C:\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';
  const tools = await resolveTools({ platform: 'win32', node, env: { npm_execpath: path.resolve('npm-cli.js') },
    exists: () => true, exec: async (file, args) => {
      assert.equal(file, 'where.exe'); assert.deepEqual(args, ['gcloud.cmd']); return ok(launcher);
    } });
  assert.match(tools.gcloud[0], /bundledpython\\python.exe$/);
  assert.match(tools.gcloud[1], /lib\\gcloud.py$/);
  assert.equal(tools.npm[0], node);
});
test('lock prevents parallel mutation and releases after failures', async t => {
  const f = await fixture(t);
  await withLock(f.root, async () => {
    await assert.rejects(withLock(f.root, async () => {}), /lock/);
  });
  await assert.rejects(withLock(f.root, async () => { throw new Error('failure'); }));
  await withLock(f.root, async () => {});
});
test('successful deploy reuses tested image, pins versions, prepares before switching and runs only reads', async t => {
  const f = await fixture(t);
  const result = await runAutomation(deployOptions, f.deps);
  assert.equal(result.phase, 'complete');
  assert.equal(result.before, old);
  assert.equal(result.digest, digest);
  assert.equal(f.switches(), 1);
  const tests = f.calls.find(c => c.tool === 'npm' && c.args.includes('test:container'));
  assert.equal(tests.extra.env.AI_FOUNDATION_CONTAINER_IMAGE, imageId);
  assert.equal(f.calls.find(c => c.tool === 'docker' && c.args[0] === 'tag').args[1], imageId);
  const prep = f.calls.findIndex(c => c.tool === 'gcloud' && c.args[1] === 'deploy');
  const sw = f.calls.findIndex(c => c.args.includes('update-traffic'));
  assert.ok(prep < sw);
  assert.ok(f.calls[prep].args.includes('--no-traffic'));
  assert.ok(f.calls[prep].args.some(a => a.includes('ai-foundation-config:2')));
  for (const call of f.calls.filter(c => c.tool === 'gcloud')) {
    assert.ok(call.args.includes('--project=example-project'));
    if (call.args[0] === 'run') assert.ok(call.args.includes('--region=asia-northeast1'));
  }
  assert.equal(f.requests.length, 8);
  assert.ok(f.requests.every(r => r.options.method === 'GET' && r.options.redirect === 'error'));
  assert.ok(f.requests.some(r => r.url.includes('/v1/collection-items')));
  assert.ok(!f.calls.some(c => c.args.includes('rmi') || c.args.includes('remove')));
  const files = await readdir(path.join(f.root, '.deploy'));
  assert.equal(files.filter(x => x.endsWith('.json')).length, 1);
  for (const file of files) assert.ok(!(await readFile(path.join(f.root, '.deploy', file), 'utf8')).includes(key));
  assert.ok(!f.logs.join('\n').includes(key));
});

for (const [name, failWhen, forbid] of [
  ['service query permissions', (tool, args) => tool === 'gcloud' && args[1] === 'services', 'build'],
  ['npm test', (tool, args) => tool === 'npm' && args[0] === 'test', 'push'],
  ['image build', (tool, args) => tool === 'docker' && args[0] === 'build', 'push'],
  ['container tests', (tool, args) => tool === 'npm' && args.includes('test:container'), 'push'],
  ['image push', (tool, args) => tool === 'docker' && args[0] === 'push', 'deploy'],
  ['revision preparation', (tool, args) => tool === 'gcloud' && args[1] === 'deploy', 'update-traffic'],
  ['key access', (tool, args) => tool === 'gcloud' && args[0] === 'secrets', 'update-traffic'],
]) {
  test(`${name} failure stops later mutation without leaking output`, async t => {
    const f = await fixture(t, { fail: failWhen });
    await assert.rejects(runAutomation(deployOptions, f.deps), e => !e.message.includes(key));
    assert.equal(f.switches(), 0);
    assert.ok(!f.calls.some(c => c.args[0] === forbid || c.args[1] === forbid || c.args[2] === forbid));
    assert.ok(!f.logs.join('').includes(key));
    assert.ok(!(await readdir(path.join(f.root, '.deploy'))).includes('cloud-run.lock'));
  });
}
for (const [name, opts] of [['dirty source', { dirty: true }], ['split traffic', { split: true }]]) {
  test(`${name} aborts before builds`, async t => {
    const f = await fixture(t, opts);
    await assert.rejects(runAutomation(deployOptions, f.deps));
    assert.ok(!f.calls.some(c => c.tool === 'npm'));
  });
}
test('external traffic change prevents switching', async t => {
  const f = await fixture(t, { externalChange: true });
  await assert.rejects(runAutomation(deployOptions, f.deps), /externally/);
  assert.equal(f.switches(), 0);
});
test('source changed by a build hook prevents revision creation', async t => {
  const f = await fixture(t, { sourceChanged: true });
  await assert.rejects(runAutomation(deployOptions, f.deps), /Source changed/);
  assert.ok(!f.calls.some(c => c.tool === 'gcloud' && c.args[1] === 'deploy'));
  assert.equal(f.switches(), 0);
});
test('traffic switch error does not run smoke or automatically retry', async t => {
  const f = await fixture(t, { fail: (tool, args) => tool === 'gcloud' && args.includes('update-traffic') });
  await assert.rejects(runAutomation(deployOptions, f.deps));
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.filter(c => c.args.includes('update-traffic')).length, 1);
});
test('rollback records actual target versions, not current deployment configuration', () => {
  const r = revision(old);
  r.spec.volumes = [{ secret: { secretName: 'ai-foundation-config', items: [{ key: '1', path: 'config.yaml' }] } }];
  const refs = revisionVersions(r);
  assert.equal(refs.configVersion, '1');
  assert.equal(refs.credentialVersions['api-key'], '1');
  assert.equal(refs.credentialVersions['github-token'], null);
});
test('post-switch smoke failure records failure without automatic rollback or leaked response', async t => {
  const f = await fixture(t, { fetchError: true });
  await assert.rejects(runAutomation(deployOptions, f.deps), e => !e.message.includes(key));
  assert.equal(f.switches(), 1);
  const files = await readdir(path.join(f.root, '.deploy'));
  const r = JSON.parse(await readFile(path.join(f.root, '.deploy', files.find(x => x.endsWith('.json'))), 'utf8'));
  assert.equal(r.phase, 'failed'); assert.equal(r.failedPhase, 'read-only-smoke');
  assert.ok(!JSON.stringify(r).includes(key));
});
test('rollback retrieves target key version before switching; does not build/push', async t => {
  const f = await fixture(t, { keyVersion: '7' });
  const r = await runAutomation(rollbackOptions, f.deps);
  assert.equal(r.revision, rollbackOptions.revision);
  const keyAccess = f.calls.findIndex(c => c.args[0] === 'secrets');
  const switchTraffic = f.calls.findIndex(c => c.args.includes('update-traffic'));
  assert.ok(keyAccess < switchTraffic);
  assert.equal(f.calls[keyAccess].args[3], '7');
  assert.ok(!f.calls.some(c => ['npm', 'docker', 'git'].includes(c.tool)));
});
for (const [name, opts] of [['foreign revision', { foreign: true }], ['unready revision', { notReady: true }],
  ['invalid target key', { invalidKey: true }]]) {
  test(`rollback rejects ${name} before switching`, async t => {
    const f = await fixture(t, opts);
    await assert.rejects(runAutomation(rollbackOptions, f.deps)); assert.equal(f.switches(), 0);
  });
}
test('status is read-only and never accesses key values or writes journals', async t => {
  const f = await fixture(t);
  const result = await runAutomation({ command: 'status', config: 'deploy.cloud.local.json' }, f.deps);
  assert.equal(result.revision, old);
  assert.ok(!f.calls.some(c => c.args[0] === 'secrets' || c.args.includes('deploy') || c.args.includes('update-traffic')));
  assert.ok(!(await readdir(f.root)).includes('.deploy'));
});
test('public summary omits private configuration and URLs', () => {
  const text = publicSummary({ command: 'deploy', phase: 'complete', project: 'private-project',
    url: 'https://private.run.app', secret: key, credentialVersions: { 'api-key': '2' } });
  assert.ok(!text.includes('private')); assert.ok(!text.includes(key));
});
