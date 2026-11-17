const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const CLOUD_ORIGIN = 'https://jrrhnegaokissvkrkted.supabase.co';
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const HASH = 'a'.repeat(64);
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

async function mockCloud(page, { status = 200, published = true } = {}) {
  await page.route(CLOUD_ORIGIN + '/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/rest/v1/collection_state') {
      body = status !== 200 ? { message: 'Test cloud outage' } : [{
        version: published ? 1 : 0,
        payload: published ? {
          CSV, META: { bakedAt: '2026-01-01T00:00:00.000Z' }, EXTRA,
          COVERS: { '999123': HASH }, PORTRAITS: { 'cloud test artist': HASH }
        } : null
      }];
    } else if (url.pathname === '/rest/v1/collection_assets') {
      body = [{ hash: HASH, content: IMAGE }];
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
  await page.addInitScript(() => {
    window.showSaveFilePicker = undefined;
  });
  await mockCloud(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await page.locator('#collection-tools > summary').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#save-html-to-btn').click();
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
  await page.goto(pathToFileURL(backupPath).href);
  await expect(page.locator('#cloud-status')).toContainText('Local file mode.');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#out')).toContainText('Cloud Test Album');
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
});
