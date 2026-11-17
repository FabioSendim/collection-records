const { test, expect } = require('@playwright/test');

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
  await expect(page.locator('#count')).toContainText('Folder: ' + folder);
  expect(shownCount(await page.locator('#count').innerText())).toBeLessThan(initialCount);
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

  await page.locator('#vgrid').click();
  await expect(page.locator('#out .grid')).toBeVisible();
  await expect(page.locator('#vgrid')).toHaveAttribute('aria-pressed', 'true');
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
