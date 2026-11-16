import jobs from '../lib/discovery-jobs.mjs';

export default async function () {
  const deleted = await jobs.cleanup();
  console.log('Removed expired Discovery jobs:', deleted);
}

export const config = { schedule: '@hourly' };
