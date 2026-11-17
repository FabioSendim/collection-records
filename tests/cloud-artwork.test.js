const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { webcrypto } = require('node:crypto');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const artworkCode = html.slice(html.indexOf('  async function cloudDecode('), html.indexOf('  async function cloudStart('));
const encodeCode = html.slice(html.indexOf('  async function cloudEncode('), html.indexOf('  async function cloudSave('));
const HASH = 'a'.repeat(64);
const IMAGE = 'data:image/png;base64,aGVsbG8=';

function app(request, store = new Map()) {
  const context = {
    cloud: {
      knownAssets: new Set(), hashes: new Map(),
      artwork: {
        assets: new Map(), pending: new Map(), failures: new Map(), queue: [],
        active: 0, timer: null, total: 0
      }
    },
    cloudRequest: request,
    openIDB: async () => ({}),
    htmlBackupStore: async (action, value, key) => {
      if (action === 'get') return store.get(key);
      store.set(key, value);
    },
    $: () => ({}),
    console: { warn() {}, error() {} },
    crypto: webcrypto, TextEncoder, setTimeout, clearTimeout
  };
  runInNewContext(artworkCode + encodeCode, context);
  return context;
}

test('decoding makes no artwork requests and rejects invalid cloud references', async () => {
  const context = app(() => { throw new Error('Artwork must not block decoding'); });
  const payload = { CSV: 'collection', META: {}, EXTRA: {}, COVERS: { 1: HASH }, PORTRAITS: { artist: HASH } };
  const decoded = await context.cloudDecode(payload);
  assert.equal(decoded.COVERS[1], 'cloud-asset:' + HASH);
  assert.equal(decoded.PORTRAITS.artist, 'cloud-asset:' + HASH);
  assert.equal(context.cloud.artwork.total, 1);
  assert.equal(payload.COVERS[1], HASH);
  await assert.rejects(context.cloudDecode({ ...payload, COVERS: { 1: 'bad-hash' } }), /Invalid cloud image reference/);
});

test('saving unresolved artwork preserves references without downloads or uploads', async () => {
  const context = app(() => { throw new Error('Unchanged artwork needs no network request'); });
  const snapshot = { CSV: 'edited notes', COVERS: { 1: 'cloud-asset:' + HASH }, PORTRAITS: { artist: 'cloud-asset:' + HASH } };
  const payload = await context.cloudEncode(snapshot);
  assert.equal(payload.COVERS[1], HASH);
  assert.equal(payload.PORTRAITS.artist, HASH);
  assert.equal(payload.CSV, 'edited notes');
  assert.equal(snapshot.COVERS[1], 'cloud-asset:' + HASH);
});

test('image cache deduplicates loads and full export resolves artwork without mutating references', async () => {
  let requests = 0;
  const store = new Map();
  const context = app(async () => { requests++; return [{ hash: HASH, content: IMAGE }]; }, store);
  const first = context.cloudLoadAsset(HASH);
  assert.equal(context.cloudLoadAsset(HASH), first);
  assert.equal(await first, IMAGE);
  assert.equal(requests, 1);
  const second = app(() => { throw new Error('Cached artwork must not be downloaded again'); }, store);
  const snapshot = { COVERS: { 1: 'cloud-asset:' + HASH }, PORTRAITS: { artist: 'cloud-asset:' + HASH } };
  const images = await second.cloudResolveImages(snapshot);
  assert.equal(images.COVERS[1], IMAGE);
  assert.equal(images.PORTRAITS.artist, IMAGE);
  assert.equal(snapshot.COVERS[1], 'cloud-asset:' + HASH);
});

test('missing artwork rejects export and can be retried without losing references', async () => {
  let missing = true;
  const context = app(async () => missing ? [] : [{ hash: HASH, content: IMAGE }]);
  const snapshot = { COVERS: { 1: 'cloud-asset:' + HASH }, PORTRAITS: {} };
  await assert.rejects(context.cloudResolveImages(snapshot), /missing or invalid/);
  assert.equal(context.cloud.artwork.failures.size, 1);
  assert.equal(snapshot.COVERS[1], 'cloud-asset:' + HASH);
  missing = false;
  assert.equal((await context.cloudResolveImages(snapshot)).COVERS[1], IMAGE);
  assert.equal(context.cloud.artwork.failures.size, 0);
});

test('artwork fetching stays within three concurrent batches of ten', async () => {
  let release, started, active = 0, peak = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const firstBatches = new Promise(resolve => { started = resolve; });
  const batches = [];
  const context = app(async path => {
    const hashes = path.match(/hash=in\.\(([^)]+)\)/)[1].split(',');
    batches.push(hashes);
    active++;
    peak = Math.max(peak, active);
    if (batches.length === 3) started();
    await gate;
    active--;
    return hashes.map(hash => ({ hash, content: IMAGE }));
  });
  const images = Array.from({ length: 45 }, (_, i) => context.cloudLoadAsset(i.toString(16).padStart(64, '0')));
  try {
    await firstBatches;
    assert.equal(peak, 3);
    assert.equal(batches.length, 3);
  } finally { release(); }
  await Promise.all(images);
  assert.ok(batches.every(batch => batch.length <= 10));
  assert.equal(peak, 3);
  assert.equal(new Set(batches.flat()).size, 45);
});

test('cache failures are reported without blocking image loading', async () => {
  const context = app(async () => [{ hash: HASH, content: IMAGE }]);
  context.htmlBackupStore = async () => { throw new Error('Storage unavailable'); };
  assert.equal(await context.cloudLoadAsset(HASH), IMAGE);
  assert.equal(context.cloud.artwork.cacheError, true);
});
