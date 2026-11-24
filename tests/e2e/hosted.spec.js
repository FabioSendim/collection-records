const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
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
  const assets = new Map();
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
      if (route.request().method() === 'POST') {
        const asset = route.request().postDataJSON();
        assets.set(asset.hash, asset.content);
        body = [];
      } else {
        const hashes = url.searchParams.get('hash').slice(4, -1).split(',');
        if (onAssets) onAssets(hashes);
        if (assetGate && await assetGate(hashes, route) === false) return;
        body = hashes.map(hash => ({ hash, content: assets.get(hash) || IMAGE }));
      }
    } else if (owner && url.pathname === '/auth/v1/user') {
      body = { id: 'e585fe35-5450-4588-b33a-0098fbf93415' };
    } else if (owner && url.pathname === '/rest/v1/rpc/save_collection') {
      const saved = route.request().postDataJSON().new_payload;
      expect(saved.COVERS).toEqual(expect.objectContaining(payload.COVERS));
      expect(saved.PORTRAITS).toEqual(expect.objectContaining(payload.PORTRAITS));
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

async function seedOwner(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('collection-owner-session', JSON.stringify({
      user: { id: 'e585fe35-5450-4588-b33a-0098fbf93415' },
      access_token: 'test-access', refresh_token: 'test-refresh', expires_at: 9999999999
    }));
  });
}

async function openCdDialog(page) {
  if (!(await page.locator('#add-cd-btn').isVisible())) await page.locator('#collection-tools > summary').click();
  await page.locator('#add-cd-btn').click();
}

function cdRelease(id = 888111, name = 'CD') {
  return {
    id, title: 'Barcode Test Album', artists: [{ name: 'Barcode Test Artist' }],
    labels: [{ name: 'Barcode Test Label', catno: 'CD-123' }],
    formats: [{ name, qty: '2', descriptions: ['Album'] }],
    year: 2001, country: 'Europe', genres: ['Jazz'], styles: ['Modal'],
    identifiers: [{ type: 'Barcode', value: '4006381333931' }],
    tracklist: [{ position: '1-1', title: 'Barcode Test Track', type_: 'track' }],
    images: [{ uri: IMAGE }]
  };
}

async function mockCdDiscogs(page, { search, release, onSearch } = {}) {
  await page.route('**/.netlify/functions/discogs?**', async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has('barcode') && onSearch) onSearch(params);
    let body;
    if (params.has('status')) body = { discogsToken: true, ai: false };
    else if (params.has('barcode')) body = search ? await search(params) : {
      pagination: { page: 1, pages: 1, items: 2 },
      results: [888111, 888112].map((id, index) => ({
        id, type: 'release', title: 'Barcode Test Artist - Barcode Test Album',
        format: ['CD', 'Album'], label: ['Barcode Test Label'], catno: 'CD-123',
        year: 2001 + index, country: index ? 'US' : 'Europe'
      }))
    };
    else if (params.has('id')) body = release ? await release(params.get('id')) : cdRelease(Number(params.get('id')));
    else body = {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('CD barcode matches are selected, previewed, saved and reloaded as actual CDs', async ({ page }) => {
  const payload = collectionPayload();
  let saved, searched;
  await seedOwner(page);
  await mockCloud(page, { owner: true, payload, onSave: value => { saved = value; Object.assign(payload, value); } });
  await mockCdDiscogs(page, { onSearch: params => { searched = params.get('barcode'); } });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openCdDialog(page);
  await page.locator('#add-barcode').fill('4006 3813-33931');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('.barcode-result')).toHaveCount(2);
  expect(searched).toBe('4006381333931');
  await expect(page.locator('#add-submit')).toBeDisabled();
  await expect(page.locator('.barcode-result').nth(1)).toContainText('US');
  await page.locator('.barcode-result').first().click();
  await expect(page.locator('#add-preview')).toContainText('2xCD, Album');
  await expect(page.locator('#add-preview')).toContainText('Barcode Test Label');
  await expect(page.locator('#add-preview')).toContainText('4006381333931');
  await page.locator('#add-submit').click();
  await expect.poll(() => saved && saved.CSV).toContain('Barcode Test Album');
  expect(saved.CSV).toContain('2xCD, Album');
  expect(saved.CSV).toContain('4006381333931');
  expect(saved.EXTRA.credits['888111'].trk).toContain('Barcode Test Track');
  await page.reload();
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  await expect(page.locator('#out .cd-item')).toContainText('Barcode Test Album');
  await page.locator('#out .cd-item').click();
  await page.getByRole('textbox', { name: 'Comments', exact: true }).fill('Newly added CD comments');
  await expect.poll(() => saved.CSV).toContain('Newly added CD comments');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fs-user-records-v4')).find(record => record.id === 888111).cdComments)).toBe('Newly added CD comments');
  await page.locator('#dlg .x').click();
  await page.locator('#vgrid').click();
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#out')).not.toContainText('Barcode Test Album');
  await expect(page.locator('#stats')).toContainText(/1\s*records/);
  await expect(page.locator('#stats')).toContainText(/1\s*CD releases/);
  await openCdDialog(page);
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-status')).toContainText('already in the collection');
  await expect(page.locator('#add-submit')).toBeDisabled();
});

test('mixed releases share both views without duplicating saves or exposing vinyl controls in CDs', async ({ page }) => {
  const payload = collectionPayload();
  payload.CSV = 'Artist,Title,release_id,Format,CollectionFolder,Collection # of Auditions,Collection Personal Score,Rating,Country,Barcode,Collection Revision Notes,Collection Extra Notes,Released,Recording Year Start,Recording Year End,Recording Date Status\n' +
    'Media Test Artist,Vinyl with bonus CD,777001,LP + CD,Jazz,4,S-Tier,5,Europe,4006381333931,Vinyl notes,Vinyl other notes,2000,1959,1959,user\n' +
    'Media Test Artist,CD with bonus DVD,777002,CD + DVD,Jazz,99,S-Tier,5,Europe,4006381333931,Original CD note,Original CD other note,2001,1999,1999,user\n' +
    'Media Test Artist,CD box set,777003,Box Set + 2xCD,Rock,88,S-Tier,4,US,123456789012,Box notes,Box other notes,2021,2020,2020,user\n' +
    'Media Test Artist,Vinyl box set,777004,Box Set + 2xLP + CD,Rock,2,B-Tier,4,US,123456789012,Vinyl box notes,Vinyl box other notes,2021,2020,2020,user\n';
  payload.COVERS = { '777001': HASH };
  payload.PORTRAITS = { 'media test artist': PORTRAIT_HASH };
  let saved;
  await seedOwner(page);
  await page.addInitScript(() => {
    localStorage.setItem('rcQueue_v1', JSON.stringify(['id:777001', 'id:777002', 'id:777004']));
  });
  await mockCloud(page, { owner: true, payload, onSave: value => { saved = value; Object.assign(payload, value); } });
  await mockCdDiscogs(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await expect(page.locator('#stats')).toContainText(/2\s*records/);
  await expect(page.locator('#stats')).toContainText(/2\s*CD releases/);
  await expect(page.locator('#stats')).toContainText(/2\s*bonus CDs/);
  await expect(page.locator('#stats')).toContainText(/6\s*plays/);
  await expect(page.locator('#stats')).toContainText(/1\s*S-tier/);
  await expect(page.locator('#out .tile')).toHaveCount(2);
  await expect(page.locator('#out')).not.toContainText('CD with bonus DVD');
  await expect(page.locator('#queue-btn')).toHaveText('Play next (2)');
  await page.locator('#queue-btn').click();
  await expect(page.locator('#queue-list .queue-item')).toHaveCount(2);
  await expect(page.locator('#queue-list')).not.toContainText('CD with bonus DVD');
  await page.getByRole('button', { name: 'Move down: Vinyl with bonus CD', exact: true }).click();
  await expect(page.locator('#queue-list .open-record').first()).toContainText('Vinyl box set');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rcQueue_v1')))).toEqual(['id:777004', 'id:777002', 'id:777001']);
  await page.locator('#queue-close').click();
  await page.locator('#vtable').click();
  await expect(page.locator('#out tbody tr')).toHaveCount(2);
  await page.locator('#tier').selectOption('B');
  await page.locator('#fmt').selectOption('2xLP');
  await page.locator('#vcd').click();
  await expect(page.locator('#out .cd-item')).toHaveCount(4);
  await expect(page.locator('#out .cd-item').filter({ hasText: 'Bonus CD' })).toHaveCount(2);
  await expect(page.locator('#count')).toContainText('Showing 4 of 4 CD entries');
  await expect(page.locator('#chips button[data-folder="Jazz"] .n')).toHaveText('2');
  for (const id of ['tier', 'fmt', 'mono', 'less', 'random', 'queue-btn']) {
    await expect(page.locator('#' + id)).toBeHidden();
  }
  await page.locator('#out .cd-item').filter({ hasText: 'CD with bonus DVD' }).click();
  const details = page.getByRole('dialog', { name: 'CD details' });
  await expect(details).toBeVisible();
  await expect(details).toContainText('Europe');
  await expect(details).toContainText('4006381333931');
  await expect(details.locator('.record-actions, .phono-note, [data-plays], [data-play], [data-queue-add], [data-edit="sl"]')).toHaveCount(0);
  await expect(details.locator('dt').filter({ hasText: /^(Rating|Plays)$/ })).toHaveCount(0);
  await expect(details.locator('.recording-fold, [data-recorded]')).toHaveCount(0);
  await expect(details.locator('dt').filter({ hasText: /^Released$/ })).toHaveCount(1);
  await details.getByText('Release details', { exact: true }).click();
  await details.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('Rock');
  await details.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('Jazz');
  await expect(details.locator('.jazz-style-fold')).toHaveCount(1);
  const notes = details.getByRole('textbox', { name: 'Comments', exact: true });
  await expect(details.locator('textarea')).toHaveCount(1);
  await expect(details.locator('[data-edit="n"], [data-edit="x"]')).toHaveCount(0);
  await expect(notes).toHaveValue('');
  await notes.fill('Updated CD comments');
  await expect.poll(() => saved && saved.CSV).toContain('Updated CD comments');
  expect(saved.CSV).toContain('CD Comments');
  expect(saved.CSV).toContain('Original CD note');
  expect(saved.CSV).toContain('Original CD other note');
  expect(saved.CSV.split('\n').find(line => line.includes('CD with bonus DVD'))).toContain(',99,S-Tier,');
  expect(saved.CSV.split('\n').find(line => line.includes('CD with bonus DVD'))).toContain(',1999,1999,');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('#out .cd-item')).toHaveCount(4);
  await page.locator('#out .cd-item').filter({ hasText: 'CD with bonus DVD' }).click();
  await expect(page.getByRole('dialog', { name: 'CD details' }).getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('Updated CD comments');
  await page.keyboard.press('Escape');
  await page.locator('#out .cd-item').filter({ hasText: 'Vinyl with bonus CD' }).click();
  const bonusDetails = page.getByRole('dialog', { name: 'CD details' });
  await expect(bonusDetails).toContainText('Bonus CD');
  await expect(bonusDetails.locator('.record-actions, .phono-note, [data-plays], [data-play], [data-queue-add]')).toHaveCount(0);
  await expect(bonusDetails.locator('.recording-fold, [data-recorded]')).toHaveCount(0);
  await expect(bonusDetails.locator('textarea')).toHaveCount(1);
  await expect(bonusDetails.locator('[data-edit="n"], [data-edit="x"]')).toHaveCount(0);
  await bonusDetails.getByRole('textbox', { name: 'Comments', exact: true }).fill('Bonus CD comments only');
  await expect.poll(() => saved && saved.CSV).toContain('Bonus CD comments only');
  expect(saved.CSV.split('\n').filter(line => line.includes('Vinyl with bonus CD'))).toHaveLength(1);
  expect(saved.CSV.split('\n').find(line => line.includes('Vinyl with bonus CD'))).toContain(',4,S-Tier,');
  expect(saved.CSV.split('\n').find(line => line.includes('Vinyl with bonus CD'))).toContain(',1959,1959,');
  expect(saved.CSV.trim().split('\n')).toHaveLength(5);
  await page.keyboard.press('Escape');
  await page.locator('#vgrid').click();
  await expect(page.locator('#tier')).toHaveValue('B');
  await expect(page.locator('#fmt')).toHaveValue('2xLP');
  await expect(page.locator('#out .tile')).toHaveCount(0);
  await page.locator('#reset-filters-btn').click();
  await expect(page.locator('#out .tile')).toHaveCount(2);
  await page.locator('#out .tile').filter({ hasText: 'Vinyl with bonus CD' }).click();
  await expect(page.getByRole('dialog', { name: 'Record details' }).locator('.record-actions')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Record details' })).toContainText('Phono');
  await expect(page.getByRole('dialog', { name: 'Record details' }).locator('.recording-fold')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Record details' }).locator('[data-recorded]')).toHaveText('1959');
  await expect(page.getByRole('dialog', { name: 'Record details' }).getByRole('textbox', { name: 'Listening notes', exact: true })).toHaveValue('Vinyl notes');
  await expect(page.getByRole('dialog', { name: 'Record details' }).getByRole('textbox', { name: 'Other notes', exact: true })).toHaveValue('Vinyl other notes');
  await expect(page.getByRole('dialog', { name: 'Record details' }).getByRole('textbox', { name: 'Comments', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Record details' }).locator('[data-plays]')).toHaveText('4');
  await page.getByRole('dialog', { name: 'Record details' }).locator('[data-artist]').first().click();
  await expect(page.locator('#artist-dlg')).toContainText('2 records · 2 CD releases · 2 bonus CDs');
  await expect(page.locator('#artist-dlg')).toContainText('6 plays');
  await page.locator('#artist-dlg .a-work').filter({ hasText: 'CD with bonus DVD' }).click();
  await expect(page.getByRole('dialog', { name: 'CD details' }).locator('.record-actions, .phono-note')).toHaveCount(0);
  await page.locator('#dlg .x').click();
  await page.locator('#vcd').click();
  await expect(page).toHaveURL(/view=cd/);
  await page.reload();
  await page.locator('#out .cd-item').filter({ hasText: 'Vinyl with bonus CD' }).click();
  await expect(page.getByRole('dialog', { name: 'CD details' }).getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('Bonus CD comments only');
});

test('CD-specific comments persist offline and survive an HTML backup', async ({ page }, testInfo) => {
  await page.addInitScript(() => { window.showSaveFilePicker = undefined; });
  await page.goto(pathToFileURL(join(__dirname, '..', '..', 'index.html')).href);
  await page.locator('#vcd').click();
  await page.locator('#out .cd-item').filter({ hasText: 'Omega Alive' }).click();
  await page.getByRole('textbox', { name: 'Comments', exact: true }).fill('Offline CD comments, with "quotes"\nand another line');
  await page.locator('#dlg .x').click();
  await page.reload();
  await page.locator('#out .cd-item').filter({ hasText: 'Omega Alive' }).click();
  await expect(page.getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('Offline CD comments, with "quotes"\nand another line');
  await page.locator('#dlg .x').click();
  await page.locator('#collection-tools > summary').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#save-html-to-btn').click();
  const backup = testInfo.outputPath('cd-comments-backup.html');
  await (await downloaded).saveAs(backup);
  await page.evaluate(() => localStorage.clear());
  await page.goto(pathToFileURL(backup).href);
  await page.locator('#vcd').click();
  await page.locator('#out .cd-item').filter({ hasText: 'Omega Alive' }).click();
  await expect(page.getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('Offline CD comments, with "quotes"\nand another line');
});

test('an empty CD catalogue reports zero CDs and filtered exports stay empty', async ({ page }, testInfo) => {
  await mockCloud(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#stats')).toContainText(/0\s*CD releases/);
  await expect(page.locator('#stats')).toContainText(/0\s*bonus CDs/);
  await page.locator('#vcd').click();
  await expect(page.locator('#count')).toContainText('Showing 0 of 0 CD entries');
  await expect(page.locator('#out .empty')).toContainText('No CDs');
  await page.locator('#collection-tools > summary').click();
  await page.locator('#export-btn').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-filtered').click();
  const download = await downloaded;
  const path = testInfo.outputPath('empty-cds.csv');
  await download.saveAs(path);
  expect(readFileSync(path, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
  await expect(page.locator('#export-status')).toContainText('0 records · 0 CD releases · 0 bonus CDs');
});

test('CD search validates input, handles no matches, and paginates release choices', async ({ page }) => {
  await seedOwner(page);
  await mockCloud(page, { owner: true });
  let searches = 0;
  await mockCdDiscogs(page, {
    onSearch: () => { searches++; },
    search: params => params.get('barcode') === '123456789012' ?
      { results: [], pagination: { page: 1, pages: 0, items: 0 } } : {
        results: [{ id: 888110 + Number(params.get('page')), type: 'release', title: 'Page ' + params.get('page'), format: ['CD'] }],
        pagination: { page: Number(params.get('page')), pages: 2, items: 2 }
      }
  });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openCdDialog(page);
  await page.locator('#add-barcode').fill('abc');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('#add-status')).toContainText('digit barcode');
  expect(searches).toBe(0);
  await page.locator('#add-barcode').fill('123456789012');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('#add-status')).toContainText('No CD releases found');
  await page.route('**/.netlify/functions/discogs?barcode=123456789012&page=1', route =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Discogs barcode search needs DISCOGS_TOKEN on the server' }) }));
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('#add-status')).toContainText('DISCOGS_TOKEN');
  await expect(page.locator('#add-submit')).toBeDisabled();
  await page.locator('#add-barcode').fill('4006381333931');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('.barcode-result')).toHaveCount(1);
  await page.locator('#add-barcode-more').click();
  await expect(page.locator('.barcode-result')).toHaveCount(2);
  await expect(page.locator('#add-barcode-more')).toBeHidden();
});

test('CD previews reject vinyl and discard old results when input changes', async ({ page }) => {
  await seedOwner(page);
  await mockCloud(page, { owner: true });
  let resolveRelease, requested = false;
  const gate = new Promise(resolve => { resolveRelease = resolve; });
  await mockCdDiscogs(page, { release: async id => {
    if (id === '888112') { requested = true; await gate; }
    return cdRelease(Number(id), id === '888111' ? 'Vinyl' : 'CD');
  } });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openCdDialog(page);
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-status')).toContainText('not a CD');
  await expect(page.locator('#add-submit')).toBeDisabled();
  try {
    await page.locator('#add-url').fill('888112');
    await page.locator('#add-lookup').click();
    await expect.poll(() => requested).toBe(true);
    await page.locator('#add-url').fill('888113');
    const response = page.waitForResponse(url => new URL(url.url()).searchParams.get('id') === '888112');
    resolveRelease();
    await response;
    await expect(page.locator('#add-submit')).toBeDisabled();
    await expect(page.locator('#add-preview')).toBeHidden();
  } finally { resolveRelease(); }
  await page.locator('#add-close').click();
  await page.locator('#collection-tools > summary').click();
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-barcode-fields')).toBeHidden();
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-preview')).toContainText('2xVinyl, Album');
  await expect(page.locator('#add-submit')).toBeEnabled();
  await page.locator('#add-folder').fill('Rock');
  await expect(page.locator('#add-submit')).toBeDisabled();
  await expect(page.locator('#add-preview')).toBeHidden();
});

test('camera permission denial leaves manual CD barcode entry available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedOwner(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await mockCloud(page, { owner: true });
  await mockCdDiscogs(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openCdDialog(page);
  await page.locator('#add-scan').click();
  await expect(page.locator('#add-camera-status')).toContainText('permission was denied');
  await expect(page.locator('#add-camera')).toBeHidden();
  await expect(page.locator('#add-scan')).toBeEnabled();
  await page.locator('#add-barcode').fill('4006381333931');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('.barcode-result')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('camera decodes a real EAN barcode locally and stops its stream after detection', async ({ page }) => {
  await seedOwner(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 240;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 240);
      // EAN-13 fixture for 4006381333931, including guard bars.
      const bars = '10100011010100111010111101111010001001011001101010100001010000101000010111010010000101100110101';
      ctx.fillStyle = '#000';
      for (let i = 0; i < bars.length; i++) if (bars[i] === '1') ctx.fillRect(80 + i * 5, 40, 5, 160);
      window.cdTestStream = canvas.captureStream(10);
      return window.cdTestStream;
    };
  });
  await mockCloud(page, { owner: true });
  await mockCdDiscogs(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openCdDialog(page);
  await page.locator('#add-scan').click();
  await expect(page.locator('#add-barcode')).toHaveValue('4006381333931');
  await expect(page.locator('.barcode-result')).toHaveCount(2);
  expect(await page.evaluate(() => window.cdTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
});

test('closing the CD dialog during a camera permission request stops a late stream', async ({ page }) => {
  await seedOwner(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveCdCamera = resolve; });
  });
  await mockCloud(page, { owner: true });
  await mockCdDiscogs(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openCdDialog(page);
  await page.locator('#add-scan').click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveCdCamera)).toBe('function');
  await page.locator('#add-close').click();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    window.cdTestStream = canvas.captureStream();
    window.resolveCdCamera(window.cdTestStream);
  });
  await expect.poll(() => page.evaluate(() => window.cdTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  await expect(page.locator('#add-dlg')).not.toBeVisible();
});

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
