import jobs from '../lib/discovery-jobs.js';

export default async function (request) {
  if (request.method !== 'POST') {
    console.error('Background Discovery requires POST');
    return;
  }
  let body;
  try { body = await request.json(); } catch (err) {
    console.error('Invalid background Discovery JSON:', err);
    return;
  }
  if (!jobs.validJobId(body && body.jobId)) {
    console.error('Invalid background Discovery job ID');
    return;
  }
  await jobs.run(body.jobId);
}
