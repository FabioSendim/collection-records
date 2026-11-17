const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const CLOUD_ORIGIN = 'https://jrrhnegaokissvkrkted.supabase.co';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const HASH = 'a'.repeat(64);
const PORTRAIT_HASH = 'b'.repeat(64);
const CSV = 'Artist,Title,release_id,CollectionFolder,Collection Revision Notes,Jazz Style Override\n' +
  'Cloud Test Artist,Cloud Test Album,999123,Jazz,Cloud listening note,"[""modal""]"\n';
const EXTRA = {
  credits: { '999123': { comp: 'Cloud composer', pers: [{ n: 'Cloud Test Artist', r: 'piano' }], trk: ['Cloud track'], styles: ['Modal'] } },
  summaries: { '999123': { text: 'Cloud album background', src: 'discogs' } },
  bios: { 'cloud test artist': { text: 'Cloud artist biography', src: 'discogs' } },
  dgArtists: {}
};

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
});

function collectionPayload() {
  return {
    CSV, META: { bakedAt: '2026-01-01T00:00:00.000Z' }, EXTRA,
    COVERS: { '999123': HASH }, PORTRAITS: { 'cloud test artist': PORTRAIT_HASH }
  };
}

async function mockCloud(page, { status = 200, published = true, payload = collectionPayload(), assetGate, onAssets, owner = false, onSave } = {}) {
  await page.route(CLOUD_ORIGIN + '/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'apikey, content-type, authorization'
        }
      });
      return;
    }
    if (url.pathname === '/rest/v1/collection_state') {
      body = status !== 200 ? { message: 'Test cloud outage' } : [{
        version: published ? 1 : 0,
        payload: published ? payload : null
      }];
    } else if (url.pathname === '/rest/v1/collection_assets') {
      const hashes = url.searchParams.get('hash').slice(4, -1).split(',');
      if (onAssets) onAssets(hashes);
      if (assetGate && await assetGate(hashes, route) === false) return;
      body = hashes.map(hash => ({ hash, content: IMAGE }));
    } else if (owner && url.pathname === '/auth/v1/user') {
      body = { id: 'e585fe35-5450-4588-b33a-0098fbf93415' };
    } else if (owner && url.pathname === '/rest/v1/rpc/save_collection') {
      const saved = route.request().postDataJSON().new_payload;
      expect(saved.COVERS['999123']).toBe(HASH);
      expect(saved.PORTRAITS['cloud test artist']).toBe(PORTRAIT_HASH);
      if (onSave) onSave(saved);
      body = { version: 2 };
    } else {
      await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' });
      return;
    }
    await route.fulfill({
      status,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  });
}

async function seedLegacyData(page) {
  await page.addInitScript(() => {
    localStorage.setItem('rcImportedCSV', 'Artist,Title,release_id,CollectionFolder\nOld Local Artist,Stale Local Album,999124,Jazz\n');
    localStorage.setItem('rcImportedAt', '2099-01-01T00:00:00.000Z');
  });
}

test('hosted shell loads only the current Supabase collection', async ({ page }) => {
  await seedLegacyData(page);
  await mockCloud(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Cloud collection loaded.');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#out')).toContainText('Cloud Test Album');
  await expect(page.locator('#out')).not.toContainText('Stale Local Album');
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  await expect(page.locator('.brand-icon')).toHaveJSProperty('complete', true);
  expect(await page.locator('.brand-icon').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
});

test('records and filters work before artwork finishes, without eagerly fetching portraits', async ({ page }) => {
  let releaseArtwork;
  const gate = new Promise(resolve => { releaseArtwork = resolve; });
  const requests = [];
  await mockCloud(page, { assetGate: () => gate, onAssets: hashes => requests.push(...hashes) });
  try {
    await page.goto('/hosted.html');
    await expect(page.locator('#out')).toContainText('Cloud Test Album');
    await expect(page.locator('#loading-skeleton')).toBeHidden();
    await expect(page.locator('#artwork-status')).toContainText('Loading artwork');
    await page.locator('#q').fill('no-match');
    await expect(page.locator('#out .tile')).toHaveCount(0);
    await page.locator('#q').fill('');
    await expect(page.locator('#out .tile')).toHaveCount(1);
    expect(requests).toContain(HASH);
    expect(requests).not.toContain(PORTRAIT_HASH);
    releaseArtwork();
    await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  } finally { releaseArtwork(); }
});

test('unchanged artwork is cached across reloads while changed hashes are fetched', async ({ page }) => {
  const requests = [], payload = collectionPayload();
  await mockCloud(page, { payload, onAssets: hashes => requests.push(...hashes) });
  await page.goto('/hosted.html');
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  expect(requests).toEqual([HASH]);
  await page.reload();
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  expect(requests).toEqual([HASH]);
  const changedHash = 'c'.repeat(64);
  payload.COVERS['999123'] = changedHash;
  await page.reload();
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  expect(requests).toEqual([HASH, changedHash]);
});

test('offscreen covers wait until their records become visible', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  const payload = collectionPayload(), requested = [];
  payload.CSV = 'Artist,Title,release_id,CollectionFolder,Date Added\n';
  payload.COVERS = {};
  payload.PORTRAITS = {};
  for (let i = 0; i < 80; i++) {
    payload.CSV += 'Cloud Test Artist,Cloud Album ' + i + ',' + (999000 + i) + ',Jazz,2026-01-01 00:00:00\n';
    payload.COVERS[999000 + i] = i.toString(16).padStart(64, '0');
  }
  const lastHash = payload.COVERS[999079];
  await mockCloud(page, { payload, onAssets: hashes => requested.push(...hashes) });
  await page.goto('/hosted.html');
  await expect(page.locator('#out .tile')).toHaveCount(80);
  await expect(page.locator('#out .tile img').first()).toHaveAttribute('src', IMAGE);
  expect(requested).not.toContain(lastHash);
  expect(requested.length).toBeLessThan(80);
  await page.locator('#q').fill('Cloud Album 79');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  expect(requested).toContain(lastHash);
});

test('failed artwork leaves records usable and can be retried', async ({ page }) => {
  let failing = true;
  await mockCloud(page, {
    assetGate: async (hashes, route) => {
      if (!failing) return;
      await route.fulfill({
        status: 503,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Test artwork outage' })
      });
      return false;
    }
  });
  await page.goto('/hosted.html');
  await expect(page.locator('#out')).toContainText('Cloud Test Album');
  await expect(page.locator('#artwork-status')).toContainText('Some artwork could not load');
  failing = false;
  await page.locator('#artwork-retry').click();
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  await expect(page.locator('#artwork-retry')).toBeHidden();
});

test('saving notes while artwork is pending preserves all cloud image references', async ({ page }) => {
  let releaseArtwork, saved;
  const gate = new Promise(resolve => { releaseArtwork = resolve; });
  await page.addInitScript(() => {
    sessionStorage.setItem('collection-owner-session', JSON.stringify({
      user: { id: 'e585fe35-5450-4588-b33a-0098fbf93415' },
      access_token: 'test-access', refresh_token: 'test-refresh', expires_at: 9999999999
    }));
  });
  await mockCloud(page, { owner: true, assetGate: () => gate, onSave: payload => { saved = payload; } });
  try {
    await page.goto('/hosted.html');
    await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
    await page.locator('#out .tile').click();
    await page.getByRole('textbox', { name: 'Listening notes', exact: true }).fill('Edited before artwork loaded');
    await expect.poll(() => saved && saved.CSV).toContain('Edited before artwork loaded');
    expect(saved.COVERS).toEqual({ '999123': HASH });
    expect(saved.PORTRAITS).toEqual({ 'cloud test artist': PORTRAIT_HASH });
    expect(saved.CSV).not.toContain('cloud-asset:');
  } finally { releaseArtwork(); }
});

test('hosted cloud failure does not display stale browser data or export an empty backup', async ({ page }) => {
  await seedLegacyData(page);
  await mockCloud(page, { status: 503 });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Cloud unavailable. No collection loaded.');
  await expect(page.locator('#out .tile')).toHaveCount(0);
  await expect(page.locator('#loading-skeleton')).toBeHidden();
  await page.locator('#collection-tools > summary').click();
  await page.locator('#save-html-to-btn').click();
  await expect(page.locator('#notice-message')).toContainText('Cannot export a backup before the cloud collection has loaded.');
});

test('an unpublished hosted collection does not fall back to a legacy local import', async ({ page }) => {
  await seedLegacyData(page);
  await mockCloud(page, { published: false });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('No cloud collection published yet.');
  await expect(page.locator('#out .tile')).toHaveCount(0);
  await page.locator('#collection-tools > summary').click();
  await page.locator('#save-html-to-btn').click();
  await expect(page.locator('#notice-message')).toContainText('Cannot export a backup before the cloud collection has loaded.');
});

test('HTML exported from the hosted shell contains current data and opens offline', async ({ page }, testInfo) => {
  let releasePortrait;
  const portraitGate = new Promise(resolve => { releasePortrait = resolve; });
  const requested = [];
  await page.addInitScript(() => {
    window.showSaveFilePicker = undefined;
  });
  await mockCloud(page, {
    onAssets: hashes => requested.push(...hashes),
    assetGate: hashes => hashes.includes(PORTRAIT_HASH) ? portraitGate : undefined
  });
  await page.goto('/hosted.html');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await page.locator('#collection-tools > summary').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#save-html-to-btn').click();
  try {
    await expect.poll(() => requested.includes(PORTRAIT_HASH)).toBe(true);
    await expect(page.locator('#artwork-status')).toContainText('Preparing complete HTML backup');
  } finally { releasePortrait(); }
  const download = await downloaded;
  const backupPath = testInfo.outputPath('collection-backup.html');
  await download.saveAs(backupPath);
  const html = readFileSync(backupPath, 'utf8');
  function dataBlock(name, variable) {
    const start = '/*<DATA:' + name + '>*/var ' + variable + '=';
    const end = ';/*</DATA:' + name + '>*/';
    const first = html.indexOf(start);
    expect(first).toBeGreaterThan(-1);
    return JSON.parse(html.slice(first + start.length, html.indexOf(end, first)));
  }
  expect(dataBlock('CSV', 'CSV')).toContain('Cloud Test Album');
  expect(dataBlock('CSV', 'CSV')).toContain('Cloud listening note');
  expect(dataBlock('EXTRA', 'EXTRA')).toEqual(EXTRA);
  expect(dataBlock('COVERS', 'EMBEDDED_COVERS')).toEqual({ '999123': IMAGE });
  expect(dataBlock('PORTRAITS', 'EMBEDDED_PORTRAITS')).toEqual({ 'cloud test artist': IMAGE });
  expect(dataBlock('META', 'DATA_META').hostedShell).toBeUndefined();
  expect(html).toMatch(/class="brand-icon" src="data:image\/png;base64,/);
  await page.goto(pathToFileURL(backupPath).href);
  await expect(page.locator('#cloud-status')).toContainText('Local file mode.');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#out')).toContainText('Cloud Test Album');
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  await expect(page.locator('.brand-icon')).toHaveJSProperty('complete', true);
  expect(await page.locator('.brand-icon').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
});
