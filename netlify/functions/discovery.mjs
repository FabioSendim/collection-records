import jobs from '../lib/discovery-jobs.js';
import summary from './summary.js';

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export default async function (request) {
  if (request.method !== 'POST' && request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const url = new URL(request.url);
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (source) {
    let origin;
    try { origin = new URL(source).origin; } catch { return json(403, { error: 'Forbidden' }); }
    if (origin !== url.origin) return json(403, { error: 'Forbidden' });
  }
  if (request.method === 'GET') {
    const jobId = url.searchParams.get('job');
    if (!jobs.validJobId(jobId)) return json(400, { error: 'Invalid Discovery job ID' });
    try {
      const result = await jobs.status(jobId);
      return result ? json(200, result) : json(404, { error: 'Discovery job expired or was not found. Please discover again.' });
    } catch (err) {
      console.error('Could not read Discovery job:', err);
      return json(503, { error: 'Discovery result storage is unavailable. Please try again.' });
    }
  }
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'Bad JSON' }); }
  if (!summary.validDiscoveryKeys(body && body.keys)) return json(400, { error: 'Provide one to three non-empty music clues, each up to 200 characters' });
  try {
    return json(202, await jobs.start(body.keys));
  } catch (err) {
    console.error('Could not queue Discovery:', err);
    return json(503, { error: 'Could not start background Discovery. Check the Netlify function logs and Blobs configuration.' });
  }
}
