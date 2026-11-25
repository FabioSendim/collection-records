const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

const CLOUD_ORIGIN = 'https://jrrhnegaokissvkrkted.supabase.co';
const CLOUD_PATH = '/rest/v1/collection_state';
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'apikey, content-type, authorization'
};
const EMPTY_CLOUD_STATE = [{ version: 1, payload: null }];

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
});

async function mockCloud(page, { status = 200, message = '' } = {}) {
  await page.route(CLOUD_ORIGIN + '/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    if (url.pathname !== CLOUD_PATH) {
      await route.fulfill({ status: 404, headers: CORS_HEADERS, body: '' });
      return;
    }
    const body = status === 200 ? EMPTY_CLOUD_STATE : { message };
    await route.fulfill({
      status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  });
}

async function openCollection(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#cloud-status')).not.toHaveClass(/is-loading/);
}

function shownCount(text) {
  const match = text.match(/Showing (\d+) of/);
  return match ? Number(match[1]) : NaN;
}

test('search and reset update the visible collection', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  const initialCount = await page.locator('#out .tile').count();
  expect(initialCount).toBeGreaterThan(0);

  await page.locator('#q').fill('e2e-no-matching-record-91827');
  await expect(page.locator('#out .empty')).toBeVisible();
  await expect(page.locator('#count')).toContainText('Showing 0 of');

  await page.locator('#reset-filters-btn').click();
  await expect(page.locator('#out .tile')).toHaveCount(initialCount);
});

test('folder chips filter the collection', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  const initialCount = shownCount(await page.locator('#count').innerText());
  const chips = page.locator('#chips button[data-folder]');
  let selectedChip;

  for (let index = 1; index < await chips.count(); index++) {
    const chip = chips.nth(index);
    const folderCount = Number(await chip.locator('.n').innerText());
    if (folderCount > 0 && folderCount < initialCount) {
      selectedChip = chip;
      break;
    }
  }

  expect(selectedChip).toBeTruthy();
  const folder = await selectedChip.getAttribute('data-folder');
  await selectedChip.click();
  await expect(selectedChip).toHaveAttribute('aria-pressed', 'true');
  await expect(selectedChip).toBeFocused();
  await expect(page.locator('#count')).toContainText('Folder: ' + folder);
  expect(shownCount(await page.locator('#count').innerText())).toBeLessThan(initialCount);
});

test('an unreadable saved import is reported and can be recovered without deleting it', async ({ page }, testInfo) => {
  const csv = 'Artist,Title,release_id,Recording Year Start,Recording Date Status\nRecovery artist,Broken recording date,999991,not-a-year,user\n';
  await mockCloud(page);
  await page.addInitScript(csv => {
    localStorage.setItem('rcImportedCSV', csv);
    localStorage.setItem('rcImportedAt', '2099-01-01T00:00:00.000Z');
  }, csv);
  await openCollection(page);
  await expect(page.locator('#notice-message')).toContainText('Could not load the saved CSV import');
  await expect(page.locator('#notice-message')).toContainText('original is kept');
  expect(await page.locator('#out .tile').count()).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem('rcImportedCSV'))).toBe(csv);
  expect(await page.evaluate(() => localStorage.getItem('rcImportedAt'))).toBe('2099-01-01T00:00:00.000Z');
  await page.locator('#collection-tools > summary').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#recover-import-btn').click();
  const path = testInfo.outputPath('recovered.csv');
  await (await downloaded).saveAs(path);
  expect(readFileSync(path, 'utf8')).toBe(csv);
});

test('newer local CD comments win duplicate merging without clearing legacy fields', async ({ page }) => {
  await mockCloud(page);
  await page.addInitScript(() => {
    if (localStorage.getItem('merge-fixture-seeded')) return;
    localStorage.setItem('merge-fixture-seeded', '1');
    localStorage.setItem('rcImportedCSV',
      'Artist,Title,release_id,Format,App Last Modified,CD Comments\n' +
      'Merge artist,New comments CD,999991,CD,2026-01-01T00:00:00.000Z,Old comments\n' +
      'Merge artist,Cleared comments CD,999992,CD,2026-01-01T00:00:00.000Z,Old comments\n' +
      'Merge artist,Legacy local CD,999993,CD,2026-01-01T00:00:00.000Z,Keep these comments\n');
    localStorage.setItem('rcImportedAt', '2099-01-01T00:00:00.000Z');
    localStorage.setItem('fs-user-records-v4', JSON.stringify([
      { id: 999991, key: 'id:999991', mt: '2099-01-01T00:00:00.000Z', cdComments: 'New comments' },
      { id: 999992, key: 'id:999992', mt: '2099-01-01T00:00:00.000Z', cdComments: '' },
      { id: 999993, key: 'id:999993', mt: '2099-01-01T00:00:00.000Z' }
    ]));
  });
  await openCollection(page);
  await page.locator('#vcd').click();
  for (const [title, comments] of [
    ['New comments CD', 'New comments'],
    ['Cleared comments CD', ''],
    ['Legacy local CD', 'Keep these comments']
  ]) {
    await page.locator('#out .cd-item').filter({ hasText: title }).click();
    await expect(page.getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue(comments);
    await page.locator('#dlg .x').click();
  }
  await expect(page).toHaveURL(/view=cd/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fs-state-v4')).view)).toBe('cd');
  await page.reload();
  await page.locator('#out .cd-item').filter({ hasText: 'New comments CD' }).click();
  await expect(page.getByRole('textbox', { name: 'Comments', exact: true })).toHaveValue('New comments');
});

test('Records and CDs retain independent sorting across switches, reloads and URL navigation', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  await page.locator('#sort').selectOption('score');
  await page.locator('#dir').click();
  await page.locator('#vcd').click();
  await expect(page.locator('#sort')).toHaveValue('added');
  await page.locator('#sort').selectOption('title');
  await page.locator('#dir').click();
  await page.locator('#vgrid').click();
  await expect(page.locator('#sort')).toHaveValue('score');
  await expect(page.locator('#dir')).toHaveAttribute('aria-label', 'Sort direction: ascending');
  await page.locator('#vtable').click();
  await expect(page.locator('#sort')).toHaveValue('score');
  await page.locator('#vcd').click();
  await expect(page.locator('#sort')).toHaveValue('title');
  await expect(page.locator('#dir')).toHaveAttribute('aria-label', 'Sort direction: descending');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fs-state-v4')).mediaSort.cd.sort)).toBe('title');
  await expect(page).toHaveURL(/view=cd/);
  await page.reload();
  await expect(page.locator('#sort')).toHaveValue('title');
  await page.keyboard.press('g');
  await expect(page.locator('#sort')).toHaveValue('score');
  await expect(page.locator('#dir')).toHaveAttribute('aria-label', 'Sort direction: ascending');
  await page.evaluate(() => { location.hash = 'sort=artist&dir=1&view=cd'; });
  await expect(page.locator('#sort')).toHaveValue('artist');
  await expect(page.locator('#dir')).toHaveAttribute('aria-label', 'Sort direction: ascending');
  await page.locator('#vgrid').click();
  await expect(page.locator('#sort')).toHaveValue('score');
  await page.locator('#vcd').click();
  await expect(page.locator('#sort')).toHaveValue('artist');
});

test('searching reuses unchanged folder and queue controls', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  const chips = await page.locator('#chips button').first().elementHandle();
  const queue = await page.locator('#queue-list li').first().elementHandle();
  await page.locator('#q').fill('miles');
  await expect(page.locator('#count')).toContainText('Search: miles');
  expect(await chips.evaluate(node => node.isConnected)).toBe(true);
  expect(await queue.evaluate(node => node.isConnected)).toBe(true);
  await page.locator('#vcd').click();
  expect(await chips.evaluate(node => node.isConnected)).toBe(false);
  await page.locator('#q').fill('');
  await expect(page.locator('#count')).not.toContainText('Search:');
  const cdCount = await page.locator('#out .cd-item').count();
  await expect(page.locator('#chips button').first().locator('.n')).toHaveText(String(cdCount));
});

test('switches between sleeves, table, and jazz styles', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  await expect(page.locator('#out .grid')).toBeVisible();

  await page.locator('#vtable').click();
  await expect(page.locator('#out .tablewrap')).toBeVisible();
  await expect(page.locator('#vtable')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#vjazz').click();
  await expect(page.locator('#out .jazz-styles')).toBeVisible();
  await expect(page.locator('#vjazz')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#jazz-map .jazz-era')).toHaveCount(6);
  await expect(page.locator('#jazz-learning .jazz-path')).toHaveCount(4);
  await expect(page.locator('#jazz-index a')).toHaveCount(19);
  expect(await page.locator('#jazz-map .jazz-map-link').evaluateAll((links) => new Set(links.map((link) => link.dataset.jazzJump)).size)).toBe(18);
  await expect(page.locator('#jazz-style-vocal > summary')).toContainText('Jazz led by a singer');
  expect(await page.locator('#jazz-style-vocal').evaluate((group) => group.open)).toBe(false);
  await page.locator('#jazz-map .jazz-map-link').filter({ hasText: 'Traditional / New Orleans' }).click();
  expect(await page.locator('#jazz-style-traditional').evaluate((group) => group.open)).toBe(true);
  await page.locator('#jazz-style-vocal > summary').click();
  await expect(page.locator('#jazz-style-vocal')).toContainText('What to listen for');
  await expect(page.locator('#jazz-style-vocal')).toContainText('Key listening');
  await expect(page.locator('#jazz-style-vocal')).toContainText('In your collection');
  const modalKeyRecord = page.locator('#jazz-style-modal .jazz-key-match').filter({ hasText: /kind of blue/i });
  expect(await modalKeyRecord.count()).toBeGreaterThan(0);
  await expect(modalKeyRecord.first().locator('.jazz-evidence')).not.toBeEmpty();
  await expect(page.locator('#jazz-style-modal .jazz-card .record-title').filter({ hasText: /birth of the blue/i })).toHaveCount(1);
  await expect(page.locator('#jazz-style-vocal .jazz-card .jazz-evidence').first()).not.toBeEmpty();
  for (const id of ['traditional', 'swing', 'vocal', 'bebop', 'contemporary', 'crossover', 'nu-jazz']) {
    await page.locator('#jazz-style-' + id).evaluate((group) => { group.open = true; });
  }
  await expect(page.locator('#jazz-style-vocal')).toContainText('Scat is wordless improvisation');
  await expect(page.locator('#jazz-style-swing')).toContainText('head arrangements');
  await expect(page.locator('#jazz-style-bebop')).toContainText('Donna Lee');
  await expect(page.locator('#jazz-style-contemporary')).toContainText('post-1980 jazz');
  await expect(page.locator('#jazz-style-crossover')).toContainText('Third Stream');
  await expect(page.locator('#jazz-style-traditional')).toContainText('two-beat feel');
  await expect(page.locator('#jazz-style-nu-jazz')).toContainText('producer-led');
  await expect(page.locator('#jazz-style-vocal')).toContainText('Frank Sinatra sits in the gray zone');

  await page.locator('#vgrid').click();
  await expect(page.locator('#out .grid')).toBeVisible();
  await expect(page.locator('#vgrid')).toHaveAttribute('aria-pressed', 'true');
});

test('CD view includes shared releases in its total without adding duplicate records', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  const initialCount = await page.locator('#out .tile').count();

  await page.locator('#vcd').click();
  await expect(page.locator('#out .cd-collection')).toBeVisible();
  await expect(page.locator('#vcd')).toHaveAttribute('aria-pressed', 'true');
  const cdCount = await page.locator('#out .cd-item').count();
  expect(cdCount).toBeGreaterThan(0);
  expect(cdCount).toBeLessThan(initialCount);
  await expect(page.locator('#record-count')).toHaveText(String(initialCount));
  await expect(page.locator('#cd-count')).toHaveText(String(cdCount));
  await expect(page.locator('#stats')).not.toContainText(/bonus CDs/i);
  await expect(page.locator('#fmt')).toBeHidden();
  await page.locator('#q').fill('e2e-no-matching-cd-91827');
  await expect(page.locator('#out .cd-item')).toHaveCount(0);
  await expect(page.locator('#out .empty')).toContainText(cdCount ? 'No CDs match' : 'No CDs in your collection yet');
  await page.locator('#reset-filters-btn').click();
  await expect(page.locator('#out .cd-item')).toHaveCount(cdCount);

  await page.locator('#vgrid').click();
  await expect(page.locator('#out .tile')).toHaveCount(initialCount);
});

test('mobile browsing uses two rows, More actions and removable genre filters', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCloud(page);
  await openCollection(page);
  const total = await page.locator('#out .tile').count();
  await expect(page.locator('#vtable')).toBeHidden();
  await expect(page.locator('.seg button:visible')).toHaveText(['Sleeves', 'CDs']);
  await expect(page.locator('.search kbd')).toBeHidden();
  await expect(page.locator('#q')).toHaveAttribute('placeholder', 'Search collection');
  await expect(page.locator('#queue-btn')).toBeHidden();
  await expect(page.locator('#chips')).toBeHidden();
  const search = await page.locator('.search').boundingBox();
  const filters = await page.locator('#filters-btn').boundingBox();
  expect(Math.abs(search.y - filters.y)).toBeLessThan(1);
  expect(search.width).toBeGreaterThan(filters.width);

  await page.locator('#mobile-more > summary').click();
  for (const id of ['random', 'discovery-btn', 'vjazz', 'collection-tools']) {
    await expect(page.locator('#mobile-more #' + id)).toBeVisible();
  }
  await page.locator('#random').click();
  await expect(page.locator('#random-dlg')).toBeVisible();
  await expect(page.locator('#mobile-more')).not.toHaveAttribute('open', '');
  await page.locator('#random-close').click();
  await page.locator('#mobile-more > summary').click();
  await page.locator('#discovery-btn').click();
  await expect(page.locator('#discovery-dlg')).toBeVisible();
  await page.locator('#discovery-close').click();
  await page.locator('#mobile-more > summary').click();
  await page.locator('#vjazz').click();
  await expect(page.locator('#mobile-more')).toHaveAttribute('data-view', 'jazz');
  await expect(page.locator('#mobile-more')).not.toHaveAttribute('open', '');
  await page.locator('#vgrid').click();

  await page.locator('#filters-btn').click();
  const jazz = page.locator('#filters-body #chips button[data-folder="Jazz"]');
  const jazzCount = Number(await jazz.locator('.n').innerText());
  await jazz.click();
  await page.locator('#filters-show').click();
  await expect(page.locator('#count > span').first()).toHaveText(jazzCount + ' records');
  await expect(page.locator('[data-clear-filter="folder"]')).toHaveText('Jazz ✕');
  await expect(page.locator('#out .tile')).toHaveCount(jazzCount);
  await page.locator('[data-clear-filter="folder"]').click();
  await expect(page.locator('#out .tile')).toHaveCount(total);
  await expect(page.locator('[data-clear-filter="folder"]')).toHaveCount(0);

  await page.locator('#q').fill('Miles Davis');
  await expect(page.locator('[data-clear-filter="q"]')).toBeVisible();
  await page.locator('#mobile-more > summary').click();
  await page.locator('#mobile-more > summary').press('Escape');
  await expect(page.locator('#q')).toHaveValue('Miles Davis');
});

test('mobile queue badge reflects additions, reloads and removal of the final item', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCloud(page);
  await openCollection(page);
  for (let index = 0; index < 3; index++) {
    await page.locator('#out .tile').nth(index).click();
    await page.locator('#dlg [data-queue-add]').click();
    await page.locator('#dlg .x').click();
  }
  const badge = page.locator('.results-row #queue-btn');
  await expect(badge).toHaveText('Play next · 3');
  await page.reload();
  await expect(badge).toHaveText('Play next · 3');
  await page.locator('#queue-btn').click();
  for (let index = 0; index < 3; index++) {
    await page.locator('#queue-list [data-queue-action="remove"]').first().click();
  }
  await page.locator('#queue-close').click();
  await expect(badge).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rcQueue_v1')))).toEqual([]);
});

test('responsive header stays compact with visible artwork and restores desktop controls', async ({ page }) => {
  await mockCloud(page);
  await openCollection(page);
  for (const width of [320, 390, 600, 601, 1152, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.locator('#mobile-more').evaluate(el => el.hidden)).toBe(width > 600);
    const layout = await page.evaluate(() => {
      const title = document.querySelector('.record-shop h1'), range = document.createRange();
      range.selectNodeContents(title);
      return {
        overflow: document.documentElement.scrollWidth > innerWidth,
        headerHeight: document.querySelector('.record-shop').offsetHeight,
        toolbarHeight: document.querySelector('.bar').offsetHeight,
        titleRight: range.getBoundingClientRect().right,
        artLeft: document.querySelector('.record-shop-shelf svg').getBoundingClientRect().left
      };
    });
    expect(layout.overflow).toBe(false);
    await expect(page.locator('.record-shop-shelf svg')).toBeVisible();
    if (width <= 600) {
      expect(layout.headerHeight).toBeLessThanOrEqual(230);
      expect(layout.toolbarHeight).toBeLessThanOrEqual(135);
      expect(layout.titleRight).toBeLessThanOrEqual(layout.artLeft);
      await expect(page.locator('#filters-body #chips')).toHaveCount(1);
    } else {
      await expect(page.locator('.bar > #chips')).toBeVisible();
      await expect(page.locator('.seg #vjazz')).toBeVisible();
      await expect(page.locator('.listening-row #queue-btn')).toBeVisible();
    }
  }
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.record-shop-shelf svg')).toBeVisible();
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.addStyleTag({ content: '.record-shop h1{font-family:Arial,sans-serif}' });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.locator('.record-shop').evaluate(el => el.offsetHeight)).toBeLessThanOrEqual(230);
  await expect(page.locator('.record-shop-shelf svg')).toBeVisible();
});

test('shows the record and skeletons while cloud loading is pending', async ({ page }) => {
  let requestStarted;
  let releaseResponse;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const responseGate = new Promise((resolve) => { releaseResponse = resolve; });

  await page.route(CLOUD_ORIGIN + '/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    if (url.pathname !== CLOUD_PATH) {
      await route.fulfill({ status: 404, headers: CORS_HEADERS, body: '' });
      return;
    }
    requestStarted();
    await responseGate;
    await route.fulfill({
      status: 200,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(EMPTY_CLOUD_STATE)
    });
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  try {
    await started;
    await expect(page.locator('#cloud-status')).toHaveClass(/is-loading/);
    await expect(page.locator('#loading-skeleton')).toBeVisible();
    await expect(page.locator('#loading-skeleton .loading-card')).toHaveCount(6);
  } finally {
    releaseResponse();
  }

  await expect(page.locator('#cloud-status')).not.toHaveClass(/is-loading/);
  await expect(page.locator('#loading-skeleton')).toBeHidden();
});

test('shows the local collection when cloud loading fails', async ({ page }) => {
  await mockCloud(page, { status: 503, message: 'Test cloud outage' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#cloud-status')).toContainText('Cloud unavailable. Showing a local backup');
  await expect(page.locator('#loading-skeleton')).toBeHidden();
  await expect(page.locator('#out .tile').first()).toBeVisible();
});
