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
  let version = published ? 1 : 0;
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
        version,
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
      const request = route.request().postDataJSON();
      expect(request.expected_version).toBe(version);
      const saved = request.new_payload;
      expect(saved.COVERS).toEqual(expect.objectContaining(payload.COVERS));
      expect(saved.PORTRAITS).toEqual(expect.objectContaining(payload.PORTRAITS));
      if (onSave) onSave(saved);
      body = { version: ++version };
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

async function openAddDialog(page, mode = 'cd') {
  const button = page.locator(mode === 'cd' ? '#add-cd-btn' : '#add-btn');
  if (!(await button.isVisible())) {
    const tools = page.locator('#collection-tools > summary');
    if (!(await tools.isVisible())) await page.locator('#mobile-more > summary').click();
    if (!(await button.isVisible())) await tools.click();
  }
  await button.click();
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
        format: [params.get('format') || 'CD', 'Album'], label: ['Barcode Test Label'], catno: 'CD-123',
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
  await openAddDialog(page);
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
  await expect(page.locator('#record-count')).toHaveText('1');
  await expect(page.locator('#cd-count')).toHaveText('1');
  await openAddDialog(page);
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-status')).toContainText('already in the collection');
  await expect(page.locator('#add-submit')).toBeDisabled();
});

test('vinyl barcodes select a pressing, reject CD matches and save bonus-CD sets once', async ({ page }) => {
  const payload = collectionPayload();
  const searches = [];
  let saved;
  await seedOwner(page);
  await mockCloud(page, { owner: true, payload, onSave: value => { saved = value; Object.assign(payload, value); } });
  await mockCdDiscogs(page, {
    onSearch: params => { searches.push(Object.fromEntries(params)); },
    search: params => {
      if (params.get('barcode') !== '0077774615225') return { results: [], pagination: { pages: 0 } };
      return {
        results: params.get('page') === '1' ? [
          { id: 999123, type: 'release', title: 'Already owned pressing', format: ['Vinyl', 'LP'] },
          { id: 888112, type: 'release', title: 'Mismatched pressing', format: ['Vinyl'] },
          { id: 888113, type: 'release', title: 'CD edition', format: ['CD'] },
          { id: 888114, type: 'release', title: 'CD-led set', format: ['CD', 'Vinyl'] },
          { id: 888115, type: 'release', title: 'Not a record', format: ['Not Vinyl'] }
        ] : [{ id: 888111, type: 'release', title: 'Vinyl with bonus CD', format: ['Vinyl', 'LP', 'CD'], country: 'Europe', catno: 'LP-123' }],
        pagination: { pages: 2 }
      };
    },
    release: id => {
      if (id === '888112') return cdRelease(Number(id));
      return {
        ...cdRelease(Number(id), 'Vinyl'), title: 'Vinyl Barcode Album',
        formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }, { name: 'CD', qty: '1' }],
        identifiers: [{ type: 'Barcode', value: '0077774615225' }]
      };
    }
  });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openAddDialog(page, 'record');
  await expect(page.locator('#add-barcode')).toBeFocused();
  await page.getByRole('textbox', { name: 'Vinyl barcode', exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Find vinyl releases', exact: true }).click();
  await expect(page.locator('#add-status')).toContainText('digit barcode');
  expect(searches).toHaveLength(0);
  await page.locator('#add-barcode').fill('12345678');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('#add-status')).toContainText('No vinyl releases found');
  await page.locator('#add-barcode').fill('0 07777-4615225');
  await page.locator('#add-barcode').press('Enter');
  await expect(page.locator('.barcode-result')).toHaveCount(2);
  await expect(page.locator('.barcode-result[data-release-id="999123"]')).toBeDisabled();
  await page.locator('.barcode-result[data-release-id="888112"]').click();
  await expect(page.locator('#add-status')).toContainText('not a vinyl record');
  await expect(page.locator('#add-submit')).toBeDisabled();
  await page.locator('#add-barcode-more').click();
  await expect(page.locator('.barcode-result')).toHaveCount(3);
  await expect(page.locator('#add-barcode-more')).toBeHidden();
  expect(searches.every(query => query.format === 'Vinyl')).toBe(true);
  expect(searches.at(-1)).toMatchObject({ barcode: '0077774615225', page: '2' });
  await page.locator('.barcode-result[data-release-id="888111"]').click();
  await expect(page.locator('#add-preview')).toContainText('2xVinyl, CD, LP, Album');
  await page.locator('#add-folder').fill('Rock');
  await page.locator('#add-submit').click();
  await expect.poll(() => saved && saved.CSV).toContain('Vinyl Barcode Album');
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
  expect(saved.CSV.split('\n').filter(line => line.includes('Vinyl Barcode Album'))).toHaveLength(1);
  expect(saved.CSV).toContain('0077774615225');
  expect(saved.CSV).toContain('Rock');
  expect(saved.COVERS['888111']).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.getByRole('dialog', { name: 'Record details' }).locator('.record-actions')).toBeVisible();
  await page.locator('#dlg .x').click();
  await page.reload();
  await expect(page.locator('#out .tile')).toHaveCount(2);
  await expect(page.locator('#record-count')).toHaveText('2');
  await expect(page.locator('#cd-count')).toHaveText('1');
  await page.locator('#vcd').click();
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  await expect(page.locator('#out .cd-item')).toContainText('Vinyl Barcode Album');
  await expect(page.locator('#out .cd-item')).toContainText('CD · also in Records');
  await openAddDialog(page, 'record');
  await page.locator('#add-barcode').fill('0077774615225');
  await page.locator('#add-barcode-search').click();
  await page.locator('#add-barcode-more').click();
  await expect(page.locator('.barcode-result[data-release-id="888111"]')).toBeDisabled();
});

test('adding a release reports storage failure and can retry with the artwork-free fallback', async ({ page }) => {
  const payload = collectionPayload();
  let saved;
  await seedOwner(page);
  await mockCloud(page, { owner: true, payload, onSave: value => { saved = value; Object.assign(payload, value); } });
  await mockCdDiscogs(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openAddDialog(page);
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-submit')).toBeEnabled();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.failReleaseSave = 'all';
    Storage.prototype.setItem = function(key, value) {
      if (key === 'fs-user-records-v4' &&
          (window.failReleaseSave === 'all' || JSON.parse(value).some(record => record.img))) {
        throw new DOMException('Simulated full storage', 'QuotaExceededError');
      }
      return setItem.call(this, key, value);
    };
  });
  await page.locator('#add-submit').click();
  await expect(page.locator('#add-status')).toContainText('could not be saved');
  await expect(page.locator('#notice.error')).toBeVisible();
  await expect(page.locator('#add-preview')).toBeVisible();
  await expect(page.locator('#cd-count')).toHaveText('0');
  expect(saved).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('fs-user-records-v4'))).toBeNull();
  await page.locator('#notice-close').click();
  await page.evaluate(() => { window.failReleaseSave = 'images'; });
  await page.locator('#add-submit').click();
  await expect.poll(() => saved && saved.CSV).toContain('Barcode Test Album');
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
  expect(saved.COVERS['888111']).toMatch(/^[a-f0-9]{64}$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fs-user-records-v4')).find(record => record.id === 888111).img)).toBe('');
  await page.reload();
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  await expect(page.locator('#out .cd-item img')).toBeVisible();
});

test('local removal blocks failed writes and remains durable if later cleanup fails', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('removal-fixture-seeded')) return;
    localStorage.setItem('removal-fixture-seeded', '1');
    localStorage.setItem('rcImportedCSV',
      'Artist,Title,release_id,Format,App Last Modified,CD Comments\n' +
      'Removal artist,Removal test CD,999991,CD,2026-01-01T00:00:00.000Z,Keep these comments\n');
    localStorage.setItem('rcImportedAt', '2099-01-01T00:00:00.000Z');
  });
  await page.goto(pathToFileURL(join(__dirname, '..', '..', 'index.html')).href + '#view=cd');
  const release = page.locator('#out .cd-item').filter({ hasText: 'Removal test CD' });
  await release.click();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (['rcRemoved_v1', 'fs-user-records-v4', 'rcEdits_v1'].includes(key)) {
        throw new DOMException('Simulated full storage', 'QuotaExceededError');
      }
      return setItem.call(this, key, value);
    };
  });
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#dlg [data-remove]').click();
  await expect(page.locator('#notice-message')).toContainText('has not been removed');
  await expect(page.locator('#dlg')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('Keep these comments');
  await page.reload();
  await release.click();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'fs-user-records-v4') throw new DOMException('Simulated full storage', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.locator('#dlg [data-remove]').click();
  await expect(page.locator('#dlg')).not.toBeVisible();
  await expect(page.locator('#notice-message')).toContainText('Could not save locally added releases');
  await expect(release).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#out .cd-collection')).toBeVisible();
  await expect(release).toHaveCount(0);
});

test('shared releases search only the notes belonging to the active media view', async ({ page }) => {
  const payload = collectionPayload();
  payload.CSV = 'Artist,Title,release_id,Format,CollectionFolder,Collection Revision Notes,Collection Extra Notes,CD Comments\n' +
    'Split Artist,Both Media,777001,LP + CD,Jazz,vinylmarker,extramarker,caf\u00e9cdmarker\n';
  await mockCloud(page, { payload });
  await page.goto('/hosted.html');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  for (const term of ['vinylmarker', 'extramarker']) {
    await page.locator('#q').fill(term);
    await expect(page.locator('#count')).toContainText('Search: ' + term);
    await expect(page.locator('#out .tile')).toHaveCount(1);
  }
  await page.locator('#q').fill('cafecdmarker');
  await expect(page.locator('#out .tile')).toHaveCount(0);
  await page.locator('#vcd').click();
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  for (const term of ['vinylmarker', 'extramarker']) {
    await page.locator('#q').fill(term);
    await expect(page.locator('#count')).toContainText('Search: ' + term);
    await expect(page.locator('#out .cd-item')).toHaveCount(0);
  }
  await page.locator('#q').fill('Split cafecdmarker');
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  await page.locator('#q').fill('Both Media');
  await expect(page.locator('#count')).toContainText('Search: Both Media');
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  await page.locator('#vgrid').click();
  await expect(page.locator('#out .tile')).toHaveCount(1);
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
  await expect(page.locator('#record-count')).toHaveText('2');
  await expect(page.locator('#cd-count')).toHaveText('4');
  await expect(page.locator('#stats')).not.toContainText(/bonus CDs/i);
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
  await expect(page.locator('#out .cd-item').filter({ hasText: 'CD · also in Records' })).toHaveCount(2);
  await expect(page.locator('#count')).toContainText('Showing 4 of 4 CD entries');
  await expect(page.locator('#chips button[data-folder="Jazz"] .n')).toHaveText('2');
  for (const id of ['tier', 'fmt', 'mono', 'less', 'random', 'queue-btn']) {
    await expect(page.locator('#' + id)).toBeHidden();
  }
  await page.locator('#out .cd-item').filter({ hasText: 'CD with bonus DVD' }).click();
  const details = page.getByRole('dialog', { name: 'CD details' });
  await expect(details).toBeVisible();
  await expect(details.locator('.about')).not.toHaveAttribute('open');
  await details.locator('.about summary').click();
  await expect(details.locator('.about p').first()).toBeVisible();
  await expect(details).toContainText('Europe');
  await expect(details).toContainText('4006381333931');
  await expect(details.locator('.record-actions, .phono-note, [data-plays], [data-play], [data-queue-add], [data-edit="sl"]')).toHaveCount(0);
  await expect(details.locator('dt').filter({ hasText: /^(Rating|Plays)$/ })).toHaveCount(0);
  await expect(details.locator('.recording-fold')).toBeVisible();
  await expect(details.locator('[data-recorded]')).toHaveText('1999');
  await expect(details.locator('dt').filter({ hasText: /^Released$/ })).toHaveCount(1);
  await details.getByText('Release details', { exact: true }).click();
  await details.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('Rock');
  await expect(details.locator('.about')).toHaveAttribute('open');
  await expect(page.locator('#chips button[data-folder="Jazz"] .n')).toHaveText('1');
  await details.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('Jazz');
  await expect(page.locator('#chips button[data-folder="Jazz"] .n')).toHaveText('2');
  await expect(details.locator('.jazz-style-fold')).toHaveCount(1);
  const notes = details.getByRole('textbox', { name: 'Comments', exact: true });
  await expect(details.locator('textarea')).toHaveCount(1);
  await expect(details.locator('[data-edit="n"], [data-edit="x"]')).toHaveCount(0);
  await expect(notes).toHaveValue('');
  await notes.fill('Updated CD comments');
  await expect.poll(() => saved && saved.CSV).toContain('Updated CD comments');
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
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
  await expect(bonusDetails).toContainText('CD · also in Records');
  await expect(bonusDetails.locator('.record-actions, .phono-note, [data-plays], [data-play], [data-queue-add]')).toHaveCount(0);
  await expect(bonusDetails.locator('.recording-fold')).toBeVisible();
  await expect(bonusDetails.locator('[data-recorded]')).toHaveText('1959');
  await expect(bonusDetails.locator('textarea')).toHaveCount(1);
  await expect(bonusDetails.locator('[data-edit="n"], [data-edit="x"]')).toHaveCount(0);
  await bonusDetails.getByRole('textbox', { name: 'Comments', exact: true }).fill('Bonus CD comments only');
  await bonusDetails.getByRole('button', { name: 'Open in Records', exact: true }).click();
  const linkedRecord = page.getByRole('dialog', { name: 'Record details' });
  await expect(linkedRecord.locator('.record-actions')).toBeVisible();
  await expect(linkedRecord).toContainText('Vinyl with bonus CD');
  await expect(linkedRecord.getByRole('textbox', { name: 'Listening notes', exact: true })).toHaveValue('Vinyl notes');
  await linkedRecord.getByRole('textbox', { name: 'Listening notes', exact: true }).fill('Updated vinyl notes');
  await linkedRecord.getByRole('button', { name: 'Open CD view', exact: true }).click();
  await expect(bonusDetails.getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('Bonus CD comments only');
  await expect(bonusDetails.locator('.record-actions')).toHaveCount(0);
  await expect.poll(() => saved && saved.CSV).toContain('Bonus CD comments only');
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
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
  await expect(page.getByRole('dialog', { name: 'Record details' }).getByRole('textbox', { name: 'Listening notes', exact: true })).toHaveValue('Updated vinyl notes');
  await expect(page.getByRole('dialog', { name: 'Record details' }).getByRole('textbox', { name: 'Other notes', exact: true })).toHaveValue('Vinyl other notes');
  await expect(page.getByRole('dialog', { name: 'Record details' }).getByRole('textbox', { name: 'Comments', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Record details' }).locator('[data-plays]')).toHaveText('4');
  await page.getByRole('dialog', { name: 'Record details' }).locator('[data-artist]').first().click();
  await expect(page.locator('#artist-dlg')).toContainText('2 records · 4 CDs');
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
  const chips = await page.locator('#chips button').first().elementHandle();
  const queue = await page.locator('#queue-list li').first().elementHandle();
  await page.getByRole('textbox', { name: 'Comments', exact: true }).fill('Offline CD comments, with "quotes"\nand another line');
  await page.locator('#dlg .x').click();
  await page.locator('#q').fill('Offline CD comments');
  await expect(page.locator('#count')).toContainText('Search: Offline CD comments');
  await expect(page.locator('#out .cd-item')).toHaveCount(1);
  expect(await chips.evaluate(node => node.isConnected)).toBe(true);
  expect(await queue.evaluate(node => node.isConnected)).toBe(true);
  await page.locator('#reset-filters-btn').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fs-state-v4')).q)).toBe('');
  await expect(page).not.toHaveURL(/q=/);
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
  await expect(page.locator('#cd-count')).toHaveText('0');
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
  await expect(page.locator('#export-status')).toContainText('0 records · 0 CDs');
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
  await openAddDialog(page);
  await page.locator('#add-barcode').fill('abc');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('#add-status')).toContainText('digit barcode');
  expect(searches).toBe(0);
  await page.locator('#add-barcode').fill('123456789012');
  await page.locator('#add-barcode-search').click();
  await expect(page.locator('#add-status')).toContainText('No CD releases found');
  await page.route('**/.netlify/functions/discogs?barcode=123456789012&page=1&format=CD', route =>
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

test('CD previews reject vinyl, discard changed releases and update folders without refetching', async ({ page }) => {
  await seedOwner(page);
  let saved;
  await mockCloud(page, { owner: true, onSave: value => { saved = value; } });
  let resolveRelease, requested = false, releaseRequests = 0;
  const gate = new Promise(resolve => { resolveRelease = resolve; });
  await mockCdDiscogs(page, { release: async id => {
    releaseRequests++;
    if (id === '888112') { requested = true; await gate; }
    return cdRelease(Number(id), id === '888111' ? 'Vinyl' : 'CD');
  } });
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openAddDialog(page);
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-status')).toContainText('not a CD');
  await expect(page.locator('#add-submit')).toBeDisabled();
  try {
    await page.locator('#add-url').fill('888112');
    await page.locator('#add-lookup').click();
    await expect.poll(() => requested).toBe(true);
    await page.locator('#add-folder').fill('Rock');
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
  await expect(page.locator('#add-barcode-fields')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Vinyl barcode', exact: true })).toBeVisible();
  await page.locator('#add-url').fill('888111');
  await page.locator('#add-lookup').click();
  await expect(page.locator('#add-preview')).toContainText('2xVinyl, Album');
  await expect(page.locator('#add-submit')).toBeEnabled();
  const requestsAfterPreview = releaseRequests;
  const cover = await page.locator('#add-preview img').getAttribute('src');
  await page.locator('#add-folder').fill('Rock');
  await expect(page.locator('#add-submit')).toBeEnabled();
  await expect(page.locator('#add-preview')).toContainText('Rock');
  await expect(page.locator('#add-preview img')).toHaveAttribute('src', cover);
  await page.locator('#add-folder').fill('');
  await expect(page.locator('#add-preview')).toContainText('Jazz');
  await page.locator('#add-folder').fill('New folder');
  await expect(page.locator('#add-preview')).toContainText('New folder');
  expect(releaseRequests).toBe(requestsAfterPreview);
  await page.locator('#add-submit').click();
  await expect(page.locator('#dlg')).toContainText('Barcode Test Album');
  await page.getByRole('dialog', { name: 'Record details' }).getByText('Release details', { exact: true }).click();
  await expect(page.locator('#dlg select[data-edit="g"]')).toHaveValue('New folder');
  await expect.poll(() => saved && saved.CSV).toContain('New folder');
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
});

for (const mode of ['cd', 'record']) {
  test('camera permission denial leaves manual barcode entry available for ' + mode, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seedOwner(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
    });
    await mockCloud(page, { owner: true });
    await mockCdDiscogs(page);
    await page.goto('/hosted.html');
    await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
    await openAddDialog(page, mode);
    await page.locator('#add-scan').click();
    await expect(page.locator('#add-camera-status')).toContainText('permission was denied');
    await expect(page.locator('#add-camera')).toBeHidden();
    await expect(page.locator('#add-scan')).toBeEnabled();
    await page.locator('#add-barcode').fill('4006381333931');
    await page.locator('#add-barcode-search').click();
    await expect(page.locator('.barcode-result')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('camera decodes a real EAN barcode locally and stops its stream for ' + mode, async ({ page }) => {
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
    await openAddDialog(page, mode);
    await page.locator('#add-scan').click();
    await expect(page.locator('#add-barcode')).toHaveValue('4006381333931');
    await expect(page.locator('.barcode-result')).toHaveCount(2);
    expect(await page.evaluate(() => window.cdTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
  });
}

test('a portrait camera feed fills a landscape scanner preview without stretching', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedOwner(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 360; canvas.height = 640;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      window.portraitTestStream = canvas.captureStream(10);
      return window.portraitTestStream;
    };
  });
  await mockCloud(page, { owner: true });
  await mockCdDiscogs(page);
  await page.goto('/hosted.html');
  await expect(page.locator('#cloud-status')).toContainText('Owner signed in');
  await openAddDialog(page);
  await page.locator('#add-scan').click();
  const video = page.locator('#add-video');
  await expect.poll(() => video.evaluate(node => node.videoHeight)).toBe(640);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const preview = await video.boundingBox();
    expect(preview.width / preview.height).toBeCloseTo(16 / 9, 2);
    await expect(video).toHaveCSS('object-fit', 'cover');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.locator('#add-close').click();
  expect(await page.evaluate(() => window.portraitTestStream.getTracks().every(track => track.readyState === 'ended'))).toBe(true);
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
  await openAddDialog(page);
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

test('album summary receives saved recording dates and collection credits', async ({ page }) => {
  await seedOwner(page);
  const payload = collectionPayload();
  payload.CSV = 'Artist,Title,release_id,CollectionFolder,Recording Year Start,Recording Year End,Recording Source URL,Recording Date Status\n' +
    'Cloud Test Artist,Cloud Test Album,999123,Jazz,1958,1959,https://example.org/source,verified\n';
  await mockCloud(page, { owner: true, payload });
  await page.route('**/.netlify/functions/discogs?status=1', route =>
    route.fulfill({ json: { ai: true, discogsToken: true } }));
  let summaryRequest;
  await page.route('**/.netlify/functions/summary', route => {
    summaryRequest = route.request().postDataJSON();
    return route.fulfill({ json: { text: 'A new summary.', styles: [] } });
  });
  await page.goto('/hosted.html');
  await page.locator('#out .tile').click();
  const about = page.locator('#dlg .about');
  await expect(about).not.toHaveAttribute('open');
  await expect(about.locator('[data-summary]')).toBeHidden();
  await about.locator('summary').click();
  await expect(about.locator('[data-summary]')).toBeVisible();
  await page.locator('#dlg [data-summary]').click();
  await expect(page.locator('#dlg .about')).toContainText('A new summary.');
  await expect(page.locator('#dlg .about')).toHaveAttribute('open');
  await expect(page.locator('#dlg .about p').first()).toBeVisible();
  await page.locator('#dlg .about summary').click();
  await expect(page.locator('#dlg .about p').first()).toBeHidden();
  await page.locator('#dlg .x').click();
  await page.locator('#out .tile').click();
  await expect(page.locator('#dlg .about')).not.toHaveAttribute('open');
  await expect(page.locator('#dlg .about p').first()).toBeHidden();
  expect(summaryRequest.recordingYears).toEqual({ start: 1958, end: 1959, status: 'verified', source: 'https://example.org/source' });
  expect(summaryRequest.personnel).toContainEqual({ name: 'Cloud Test Artist', role: 'piano' });
});

test('CD recording years persist and update the artist timeline', async ({ page }) => {
  const payload = collectionPayload();
  payload.CSV = 'Artist,Title,release_id,Format,CollectionFolder,Released,Recording Date Status\n' +
    'CD Timeline Artist,CD Album,777101,CD,Jazz,2020,unknown\n' +
    'CD Timeline Artist,Vinyl Album,777102,LP,Jazz,2021,unknown\n';
  payload.EXTRA = { credits: {}, summaries: {}, bios: {}, dgArtists: {} };
  payload.COVERS = {}; payload.PORTRAITS = {};
  await seedOwner(page);
  await mockCloud(page, { owner: true, payload, onSave: value => Object.assign(payload, value) });
  await page.goto('/hosted.html');
  await page.locator('#vcd').click();
  await page.locator('#out .cd-item').filter({ hasText: 'CD Album' }).click();
  const details = page.getByRole('dialog', { name: 'CD details' });
  await details.locator('.recording-fold summary').click();
  await details.locator('#recording-year').fill('1962');
  await details.getByRole('button', { name: 'Save recording year' }).click();
  await expect(details.locator('[data-recorded]')).toHaveText('1962');
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
  await page.reload();
  await page.locator('#out .cd-item').filter({ hasText: 'CD Album' }).click();
  await expect(details.locator('[data-recorded]')).toHaveText('1962');
  await details.locator('[data-artist]').first().click();
  const timeline = page.locator('#artist-dlg .recording-timeline .ev');
  await expect(timeline.locator('.yr')).toHaveText(['1962', '—']);
  await expect(timeline.locator('.tlink')).toHaveText(['CD Album', 'Vinyl Album']);
  await timeline.locator('.tlink').first().click();
  await details.locator('.recording-fold summary').click();
  await details.getByRole('button', { name: 'Mark year unknown' }).click();
  await expect(details.locator('[data-recorded]')).toHaveCount(0);
  await expect(page.locator('#cloud-status')).toContainText('Saved to cloud.');
  await page.reload();
  await page.locator('#out .cd-item').filter({ hasText: 'CD Album' }).click();
  await expect(details.locator('[data-recorded]')).toHaveCount(0);
});

test('artist timeline orders recording years and keeps edition years on release cards', async ({ page }) => {
  const payload = collectionPayload();
  payload.CSV = 'Artist,Title,release_id,Format,Label,CollectionFolder,Released,Recording Year Start,Recording Year End,Recording Date Status\n' +
    'Timeline Artist,Later Recording,777011,LP + CD,Label A,Jazz,2001,1964,1965,user\n' +
    'Timeline Artist,Unknown Recording,777012,CD,,Jazz,1990,,,unknown\n' +
    'Timeline Artist,Earlier Recording,777013,LP,Label B,Jazz,2020,1958,1958,user\n' +
    'Other Artist,Guest Appearance,777014,LP,Label C,Jazz,2022,1960,1960,user\n';
  payload.EXTRA = { credits: { '777014': { pers: [{ n: 'Timeline Artist', r: 'piano' }, { n: 'Guest Only', r: 'bass' }] } }, summaries: {}, bios: {}, dgArtists: {} };
  payload.COVERS = {}; payload.PORTRAITS = {};
  await mockCloud(page, { payload });
  await page.goto('/hosted.html');
  await page.locator('#out .tile').filter({ hasText: 'Earlier Recording' }).click();
  await page.locator('#dlg [data-artist]').first().click();
  const timeline = page.locator('#artist-dlg .recording-timeline .ev');
  await expect(timeline.locator('.yr')).toHaveText(['1958', '1964–1965', '—']);
  await expect(timeline.locator('.tlink')).toHaveText(['Earlier Recording', 'Later Recording', 'Unknown Recording']);
  await expect(timeline.locator('.what')).toHaveText(['Earlier Recording · Label B', 'Later Recording · Label A (CD)', 'Unknown Recording (CD)']);
  const guest = page.locator('#artist-dlg .a-work').filter({ hasText: 'Guest Appearance' });
  await expect(guest).toBeVisible();
  await expect(guest.locator('xpath=../..').locator('h3')).toHaveText('Also appears on');
  await expect(page.locator('#artist-dlg')).toContainText('Recording years');
  await expect(page.locator('#artist-dlg .a-work').filter({ hasText: 'Earlier Recording' })).toContainText('2020');
  await guest.click();
  await page.locator('#dlg summary').filter({ hasText: 'Credits & tracks' }).click();
  await page.locator('#dlg .credits button[data-artist]').filter({ hasText: 'Guest Only' }).click();
  await expect(page.locator('#artist-dlg .recording-timeline')).toHaveCount(0);
  await expect(page.locator('#artist-dlg .a-work').filter({ hasText: 'Guest Appearance' })).toBeVisible();
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
  await expect(page.locator('.record-shop-shelf svg')).toBeVisible();
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

test('Artists view uses live cloud records, CDs, credited guests and cloud portraits', async ({ page }) => {
  const payload = collectionPayload(), requests = [];
  payload.CSV = 'Artist,Title,release_id,Format,CollectionFolder\n' +
    'Cloud Test Artist,Cloud Vinyl,999123,LP,Jazz\n' +
    'CD Only Artist,Cloud CD,999124,CD,Jazz\n' +
    'CD Only Artist,Another CD,999125,CD,Jazz\n';
  payload.EXTRA.credits['999123'].pers.push({ n: 'Guest Musician', r: 'saxophone' });
  await mockCloud(page, { payload, onAssets: hashes => requests.push(...hashes) });
  await page.goto('/hosted.html#view=artists');
  await expect(page.locator('#cloud-status')).toContainText('Cloud collection loaded.');
  await expect(page.locator('#vartists')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#artists-view-grid .artists-view-card')).toHaveCount(3);
  await expect(page.locator('#artists-view-grid')).toContainText('CD Only Artist');
  await expect(page.locator('#artists-view-grid')).toContainText('Guest Musician');
  await page.locator('#artists-view-sort').selectOption('count');
  await expect(page.locator('.artists-view-card').first().locator('.artists-view-name')).toHaveText('CD Only Artist');
  const cloudArtist = page.locator('.artists-view-card').filter({ hasText: 'Cloud Test Artist' });
  await cloudArtist.scrollIntoViewIfNeeded();
  await expect(cloudArtist.locator('img')).toHaveAttribute('src', IMAGE);
  expect(requests).toContain(PORTRAIT_HASH);
  await page.locator('#artists-view-search').fill('Guest Musician');
  await page.locator('.artists-view-card').click();
  await expect(page.locator('#artist-dlg h2')).toHaveText('Guest Musician');
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
  await page.setViewportSize({ width: 390, height: 844 });
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
  await page.locator('#vartists').click();
  await page.locator('#artists-view-search').fill('Cloud Test Artist');
  await page.locator('#mobile-more > summary').click();
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
  expect(html).toContain('class="record-shop-shelf"');
  expect(html).not.toContain('data-controls-ready=""');
  await page.goto(pathToFileURL(backupPath).href);
  await expect(page.locator('#cloud-status')).toContainText('Local file mode.');
  await expect(page.locator('#out .tile')).toHaveCount(1);
  await expect(page.locator('#out')).toContainText('Cloud Test Album');
  await expect(page.locator('#out .tile img')).toHaveAttribute('src', IMAGE);
  await expect(page.locator('.record-shop-shelf svg')).toBeVisible();
  await expect(page.locator('#mobile-more')).toHaveCount(1);
  await expect(page.locator('.seg button:visible')).toHaveText(['Sleeves', 'CDs', 'Artists']);
  await expect(page.locator('#filters-body #chips')).toHaveCount(1);
  await page.setViewportSize({ width: 1152, height: 900 });
  await expect(page.locator('.bar > #chips')).toBeVisible();
  await expect(page.locator('.seg #vjazz')).toBeVisible();
  await expect(page.locator('.listening-row #random')).toBeVisible();
  await expect(page.locator('#mobile-more')).toBeHidden();
});
