import { randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import summary from '../functions/summary.js';

const { discover } = summary;

const RETENTION_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 3 * 60 * 1000;

function getJobs() {
  return getStore({ name: 'discovery-jobs', consistency: 'strong' });
}

function validJobId(id) {
  return typeof id === 'string' && /^\d{13}-[0-9a-f]{48}$/.test(id);
}

async function start(keys) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server');
  if (!process.env.URL) throw new Error('Background Discovery requires the Netlify runtime URL.');
  const endpoint = new URL('/.netlify/functions/discovery-background', process.env.URL);
  const store = getJobs(), now = Date.now();
  const jobId = (now + RETENTION_MS) + '-' + randomBytes(24).toString('hex');
  await store.setJSON(jobId, { status: 'queued', keys: keys.map((x) => x.trim()), createdAt: now });
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }), signal: AbortSignal.timeout(10000)
    });
    if (response.status !== 202) throw new Error('Could not start background Discovery (HTTP ' + response.status + ').');
  } catch (err) {
    await store.setJSON(jobId, { status: 'failed', error: 'Could not start background Discovery. Please try again.', createdAt: now });
    throw err;
  }
  return { jobId, status: 'queued' };
}

async function status(jobId) {
  const store = getJobs();
  const job = await store.get(jobId, { type: 'json' });
  if (!job) return null;
  if (Number(jobId.slice(0, 13)) <= Date.now()) {
    await store.delete(jobId);
    return null;
  }
  if ((job.status === 'queued' || job.status === 'running') && Date.now() - job.createdAt > MAX_WAIT_MS) {
    return { status: 'failed', error: 'Discovery did not finish in time. Please try again.' };
  }
  if (job.status === 'complete') return { status: 'complete', recommendations: job.recommendations };
  if (job.status === 'failed') return { status: 'failed', error: job.error };
  return { status: job.status };
}

async function run(jobId) {
  const store = getJobs();
  const job = await store.get(jobId, { type: 'json' });
  if (!job || job.status !== 'queued' || Number(jobId.slice(0, 13)) <= Date.now()) return;
  // Netlify may redeliver background invocations; claim the job before calling Gemini.
  const claim = await store.setJSON(jobId + '-claim', {}, { onlyIfNew: true });
  if (!claim.modified) return;
  await store.setJSON(jobId, { ...job, status: 'running' });
  let result;
  try {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set on the server');
    const response = await discover(process.env.GEMINI_API_KEY, job.keys);
    const data = JSON.parse(response.body);
    result = response.statusCode === 200
      ? { status: 'complete', recommendations: data.recommendations }
      : { status: 'failed', error: data.error };
  } catch (err) {
    console.error('Background Discovery failed:', err);
    result = { status: 'failed', error: 'Background Discovery failed. Please try again.' };
  }
  await store.setJSON(jobId, { ...result, createdAt: job.createdAt });
}

async function cleanup() {
  const store = getJobs();
  let deleted = 0;
  for await (const page of store.list({ paginate: true })) {
    const expired = page.blobs.filter(({ key }) =>
      validJobId(key.replace(/-claim$/, '')) && Number(key.slice(0, 13)) <= Date.now());
    await Promise.all(expired.map(({ key }) => store.delete(key)));
    deleted += expired.length;
  }
  return deleted;
}

export default { start, status, run, cleanup, validJobId };
