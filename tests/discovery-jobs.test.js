const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');

const filename = join(__dirname, '..', 'netlify', 'lib', 'discovery-jobs.mjs');
const source = readFileSync(filename, 'utf8');
const jobLogic = source.slice(source.indexOf('const RETENTION_MS'), source.indexOf('export default'));
const nodeRequire = createRequire(filename);
const albums = Array.from({ length: 12 }, (_, i) => ({ artist: 'Artist ' + i, title: 'Album ' + i, reason: 'Jazz.' }));
const generated = (body, statusCode = 200) => ({ statusCode, body: JSON.stringify(body) });

function fixture() {
  const entries = new Map(), requests = [], writes = [], errors = [];
  let now = Date.now(), generations = 0;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const store = {
    async setJSON(key, data, options = {}) {
      if (options.onlyIfNew && entries.has(key)) return { modified: false };
      entries.set(key, { data: clone(data) });
      writes.push({ key, data: clone(data), options });
      return { modified: true };
    },
    async get(key) { return entries.has(key) ? clone(entries.get(key).data) : null; },
    async delete(key) { entries.delete(key); },
    async *list() { yield { blobs: Array.from(entries.keys(), (key) => ({ key })) }; }
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports,
    require: (name) => {
      if (name === '@netlify/blobs') return { getStore: (options) => {
        assert.equal(options.consistency, 'strong');
        return store;
      } };
      if (name === '../functions/summary') return { discover: async (...args) => {
        generations++;
        return context.generate(...args);
      } };
      return nodeRequire(name);
    },
    process: { env: { GEMINI_API_KEY: 'test-key', DEPLOY_URL: 'https://deploy.netlify.app' } },
    Date: class extends Date { static now() { return now; } },
    URL, AbortSignal,
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return context.dispatch(url, options);
    },
    dispatch: async () => ({ status: 202 }),
    generate: async () => generated({ recommendations: albums })
  };
  runInNewContext(
    "const { randomBytes } = require('node:crypto'); const { getStore } = require('@netlify/blobs');" +
    "const { discover } = require('../functions/summary');" + jobLogic +
    'module.exports = { start, status, run, cleanup, validJobId };', context);
  return {
    jobs: module.exports, entries, store, context, requests, writes, errors,
    advance(ms) { now += ms; },
    get generations() { return generations; }
  };
}

test('submission queues work without generating and status exposes no clues', async () => {
  const f = fixture();
  const job = await f.jobs.start([' jazz ']);
  assert.equal(job.status, 'queued');
  assert.equal(f.generations, 0);
  assert.equal(f.requests[0].url, 'https://deploy.netlify.app/.netlify/functions/discovery-background');
  assert.equal(JSON.parse(f.requests[0].options.body).jobId, job.jobId);
  assert.equal(f.entries.get(job.jobId).data.keys[0], 'jazz');
  const queued = await f.jobs.status(job.jobId);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.keys, undefined);
  assert.equal(queued.createdAt, undefined);

  f.context.generate = async () => {
    assert.equal((await f.jobs.status(job.jobId)).status, 'running');
    return generated({ recommendations: albums });
  };
  await f.jobs.run(job.jobId);
  const completed = await f.jobs.status(job.jobId);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.recommendations.length, 12);
  assert.equal(f.entries.get(job.jobId).data.keys, undefined);
});

test('conditional claims prevent concurrent and redelivered jobs from generating twice', async () => {
  const f = fixture();
  const { jobId } = await f.jobs.start(['jazz']);
  await Promise.all([f.jobs.run(jobId), f.jobs.run(jobId)]);
  await f.jobs.run(jobId);
  assert.equal(f.generations, 1);
  assert.ok(f.writes.some((write) => write.options.onlyIfNew));
});

test('generation errors become pollable failures without storing clues in the result', async () => {
  const f = fixture();
  const { jobId } = await f.jobs.start(['jazz']);
  f.context.generate = async () => generated({ error: 'Gemini quota exceeded' }, 429);
  await f.jobs.run(jobId);
  const result = await f.jobs.status(jobId);
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Gemini quota exceeded');
  assert.equal(result.recommendations, undefined);
  assert.equal(f.entries.get(jobId).data.keys, undefined);
});

test('rejected dispatch and unavailable storage never claim work was accepted', async () => {
  const f = fixture();
  f.context.dispatch = async () => ({ status: 403 });
  await assert.rejects(f.jobs.start(['jazz']), /HTTP 403/);
  assert.equal(Array.from(f.entries.values())[0].data.status, 'failed');
  f.store.setJSON = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(f.jobs.start(['jazz']), /Storage unavailable/);
  assert.equal(f.requests.length, 1);
});

test('stalled jobs fail within the client wait and expiry deletes temporary data', async () => {
  const f = fixture();
  const { jobId } = await f.jobs.start(['jazz']);
  f.advance(181000);
  assert.equal((await f.jobs.status(jobId)).status, 'failed');
  f.advance(420000);
  assert.equal(await f.jobs.status(jobId), null);
  assert.equal(f.entries.has(jobId), false);
});

test('cleanup removes expired abandoned jobs but keeps active jobs', async () => {
  const f = fixture();
  const expired = await f.jobs.start(['old clue']);
  await f.jobs.run(expired.jobId);
  f.advance(601000);
  const active = await f.jobs.start(['new clue']);
  assert.equal(await f.jobs.cleanup(), 2);
  assert.equal(f.entries.has(expired.jobId), false);
  assert.equal(f.entries.has(expired.jobId + '-claim'), false);
  assert.equal(f.entries.has(active.jobId), true);
});

test('public endpoint validates input, protects origin, and reports storage failures', async (t) => {
  const { default: jobs } = await import('../netlify/lib/discovery-jobs.mjs');
  const { default: handler } = await import('../netlify/functions/discovery.mjs');
  let submissions = 0;
  const jobId = Date.now() + '-' + 'a'.repeat(48);
  t.mock.method(jobs, 'start', async () => { submissions++; return { jobId, status: 'queued' }; });
  t.mock.method(jobs, 'status', async () => null);
  const request = (body, options = {}) => new Request('https://crate.test/.netlify/functions/discovery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options
  });
  assert.equal((await handler(request({ keys: ['jazz'] }))).status, 202);
  for (const body of [null, [], { keys: [] }, { keys: [' '] }, { keys: [1] }, { keys: ['x'.repeat(201)] }]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal(submissions, 1);
  assert.equal((await handler(request({ keys: ['jazz'] }, { headers: { origin: 'https://other.test' } }))).status, 403);
  assert.equal((await handler(new Request('https://crate.test/.netlify/functions/discovery?job=bad'))).status, 400);
  assert.equal((await handler(new Request('https://crate.test/.netlify/functions/discovery?job=' + jobId))).status, 404);
  t.mock.method(console, 'error', () => {});
  jobs.start.mock.mockImplementation(async () => { throw new Error('Blobs unavailable'); });
  const failure = await handler(request({ keys: ['jazz'] }));
  assert.equal(failure.status, 503);
  assert.match((await failure.json()).error, /Could not start background/);
  jobs.status.mock.mockImplementation(async () => { throw new Error('Blobs unavailable'); });
  const unavailable = await handler(new Request('https://crate.test/.netlify/functions/discovery?job=' + jobId));
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).error, /storage is unavailable/);
});

test('submission, worker and polling integrate with the real local Netlify Blobs server', async () => {
  const { mkdtemp, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { BlobsServer } = require('@netlify/blobs/server');
  const { setEnvironmentContext, getStore } = require('@netlify/blobs');
  const { default: handler } = await import('../netlify/functions/discovery.mjs');
  const { default: worker } = await import('../netlify/functions/discovery-background.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'collection-discovery-test-'));
  const server = new BlobsServer({ directory, token: 'test-token', logger() {} });
  const originalFetch = global.fetch, originalContext = global.netlifyBlobsContext;
  const originalKey = process.env.GEMINI_API_KEY, originalDeploy = process.env.DEPLOY_URL;
  let dispatch, finishGeneration, generationStarted;
  const started = new Promise((resolve) => { generationStarted = resolve; });
  try {
    const address = await server.start();
    const base = 'http://127.0.0.1:' + address.port;
    setEnvironmentContext({ siteID: 'test-site', token: 'test-token', edgeURL: base, uncachedEdgeURL: base });
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.DEPLOY_URL = 'https://deploy.test';
    global.fetch = async (url, options) => {
      if (String(url).startsWith('https://deploy.test/')) {
        dispatch = { url: String(url), options };
        return new Response(null, { status: 202 });
      }
      if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
        generationStarted();
        return new Promise((resolve) => { finishGeneration = () => resolve(Response.json({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ recommendations: albums }) }] } }]
        })); });
      }
      return originalFetch(url, options);
    };
    const submitted = await handler(new Request('https://crate.test/.netlify/functions/discovery', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ['jazz'] })
    }));
    assert.equal(submitted.status, 202);
    const { jobId } = await submitted.json();
    const poll = () => handler(new Request('https://crate.test/.netlify/functions/discovery?job=' + jobId));
    assert.equal((await (await poll()).json()).status, 'queued');
    const processing = worker(new Request(dispatch.url, dispatch.options));
    await Promise.race([started, processing.then(() => { throw new Error('Worker stopped before generation started'); })]);
    assert.equal((await (await poll()).json()).status, 'running');
    finishGeneration();
    await processing;
    const result = await (await poll()).json();
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.recommendations, albums);
    const stored = await getStore({ name: 'discovery-jobs', consistency: 'strong' }).get(jobId, { type: 'json' });
    assert.equal(stored.keys, undefined);
  } finally {
    global.fetch = originalFetch;
    global.netlifyBlobsContext = originalContext;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalDeploy === undefined) delete process.env.DEPLOY_URL;
    else process.env.DEPLOY_URL = originalDeploy;
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
