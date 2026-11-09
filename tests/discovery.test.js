const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script, runInNewContext } = require('node:vm');
const { handler } = require('../netlify/functions/summary');

const albums = Array.from({ length: 12 }, (_, i) => ({
  artist: 'Artist ' + i, title: 'Album ' + i, reason: 'Matches your jazz clue.'
}));
const event = (body) => ({
  httpMethod: 'POST', headers: { host: 'crate.test', origin: 'https://crate.test' },
  body: JSON.stringify(body)
});
const answer = (items = albums, finishReason = 'STOP') => ({
  candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ recommendations: items }) }] } }]
});
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

async function withAI(run) {
  const originalFetch = global.fetch, originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async () => response(answer());
  try { await run(); } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
}

test('all inline application scripts parse', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  let count = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/type=["']application\/json/.test(match[1]) || /\bsrc=/.test(match[1])) continue;
    new Script(match[2]);
    count++;
  }
  assert.ok(count > 0);
});

test('interface separates browsing, listening and administration without duplicating controls', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const browsing = html.slice(html.indexOf('<div class="row1">'), html.indexOf('<div class="listening-row"'));
  const listening = html.slice(html.indexOf('<div class="listening-row"'), html.indexOf('<p id="cloud-status"'));
  const tools = browsing.slice(browsing.indexOf('<details class="tools"'));
  for (const id of ['random', 'discovery-btn', 'queue-btn']) {
    assert.ok(listening.includes('id="' + id + '"'));
    assert.ok(!browsing.includes('id="' + id + '"'));
  }
  for (const id of ['q', 'vgrid', 'vtable', 'vjazz', 'filters-btn']) {
    assert.ok(browsing.includes('id="' + id + '"'));
  }
  assert.ok(tools.includes('id="add-btn"'));
  for (const id of ['q', 'random', 'discovery-btn', 'queue-btn', 'add-btn']) {
    assert.equal(html.split('id="' + id + '"').length - 1, 1);
  }
});

test('Discovery keeps caveats in a collapsed disclosure after the results', () => {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const dialog = html.slice(html.indexOf('<dialog id="discovery-dlg"'), html.indexOf('<dialog id="jazz-fetch-dlg"'));
  const about = dialog.slice(dialog.indexOf('<details class="fold" id="discovery-about"'));
  assert.ok(dialog.indexOf('id="discovery-results"') < dialog.indexOf('id="discovery-about"'));
  assert.ok(about.includes('<summary>About Discovery</summary>'));
  assert.ok(!about.split('>')[0].includes('open'));
  for (const text of ['Only your clues are sent', 'not verified album pages', 'Clearing browser storage', 'filters do not apply']) {
    assert.ok(about.includes(text));
    assert.ok(!dialog.slice(0, dialog.indexOf('id="discovery-results"')).includes(text));
  }
});

test('summaries and discovery use independent defaults and model overrides', async () => withAI(async () => {
  const originalModel = process.env.GEMINI_MODEL;
  const originalDiscoveryModel = process.env.GEMINI_DISCOVERY_MODEL;
  try {
    for (const [model, discoveryModel] of [
      [undefined, undefined],
      ['gemini-3.1-flash-lite', undefined],
      [undefined, 'gemini-3.6-flash'],
      ['gemini-3.1-flash-lite', 'gemini-3.6-flash']
    ]) {
      if (model === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = model;
      if (discoveryModel === undefined) delete process.env.GEMINI_DISCOVERY_MODEL;
      else process.env.GEMINI_DISCOVERY_MODEL = discoveryModel;
      for (const body of [{ keys: ['jazz'] }, { artist: 'Miles Davis', title: 'Kind of Blue' }]) {
        global.fetch = async (url, options) => {
          const expectedModel = body.keys ? discoveryModel || 'gemini-3.8-flash' : model || 'gemini-3.5-flash-lite';
          assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/' +
            expectedModel + ':generateContent');
          assert.equal(JSON.parse(options.body).tools, undefined);
          return response(body.keys ? answer() : { candidates: [{ content: { parts: [{ text: 'Album summary.' }] } }] });
        };
        assert.equal((await handler(event(body))).statusCode, 200);
      }
    }
  } finally {
    if (originalModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = originalModel;
    if (originalDiscoveryModel === undefined) delete process.env.GEMINI_DISCOVERY_MODEL;
    else process.env.GEMINI_DISCOVERY_MODEL = originalDiscoveryModel;
  }
}));

test('discovery accepts one to three clues and requests a structured candidate pool', async () => withAI(async () => {
  for (const keys of [[' jazz '], ['Kind of Blue', 'Bill Evans', 'modal jazz']]) {
    global.fetch = async (url, options) => {
      assert.match(url, /:generateContent$/);
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.generationConfig.responseSchema.properties.recommendations.minItems, 12);
      assert.ok(body.contents[0].parts[0].text.includes(JSON.stringify(keys.map((x) => x.trim()))));
      assert.ok(options.signal);
      return response(answer());
    };
    const result = await handler(event({ keys }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body).recommendations, albums);
    assert.equal(result.headers['Cache-Control'], 'no-store');
  }
}));

test('rejects invalid request shapes and clues without calling AI', async () => withAI(async () => {
  global.fetch = async () => { assert.fail('AI should not be called'); };
  for (const body of [null, [], { keys: [] }, { keys: [' '] }, { keys: [1] },
    { keys: 'jazz' }, { keys: ['a', 'b', 'c', 'd'] }, { keys: ['x'.repeat(201)] }]) {
    assert.equal((await handler(event(body))).statusCode, 400);
  }
  assert.equal((await handler({ ...event({}), body: '{' })).statusCode, 400);
}));

test('preserves origin, method and missing-configuration errors', async () => withAI(async () => {
  assert.equal((await handler({ ...event({ keys: ['jazz'] }), httpMethod: 'GET' })).statusCode, 405);
  assert.equal((await handler({ ...event({ keys: ['jazz'] }), headers: { host: 'crate.test', origin: 'https://other.test' } })).statusCode, 403);
  delete process.env.GEMINI_API_KEY;
  assert.equal((await handler(event({ keys: ['jazz'] }))).statusCode, 501);
}));

test('surfaces upstream rate limits and service errors', async () => withAI(async () => {
  for (const status of [429, 500]) {
    global.fetch = async () => response({ error: { message: 'Upstream error' } }, status);
    const result = await handler(event({ keys: ['jazz'] }));
    assert.equal(result.statusCode, status === 429 ? 429 : 502);
    assert.equal(JSON.parse(result.body).error, 'Upstream error');
  }
}));

test('rejects incomplete, malformed, empty and duplicate recommendations', async () => withAI(async () => {
  const invalid = [
    answer(albums, 'MAX_TOKENS'),
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'bad JSON' }] } }] },
    answer(albums.slice(0, 3)),
    answer([...albums.slice(0, 11), albums[0]]),
    answer(albums.map((x, i) => i ? x : { ...x, reason: '' })),
    answer(albums.map((x, i) => i ? x : { ...x, artist: 123 })),
    answer(albums.map((x, i) => i ? x : { ...x, reason: 'x'.repeat(601) })),
    { candidates: [] }
  ];
  for (const data of invalid) {
    global.fetch = async () => response(data);
    const result = await handler(event({ keys: ['jazz'] }));
    assert.equal(result.statusCode, 502);
    assert.ok(JSON.parse(result.body).error);
    assert.equal(JSON.parse(result.body).recommendations, undefined);
  }
}));

test('surfaces network and timeout failures', async () => withAI(async () => {
  for (const name of ['Error', 'TimeoutError']) {
    global.fetch = async () => { const err = new Error('Network unavailable'); err.name = name; throw err; };
    const result = await handler(event({ keys: ['jazz'] }));
    assert.equal(result.statusCode, 502);
    assert.match(JSON.parse(result.body).error, name === 'TimeoutError' ? /timed out/ : /Network unavailable/);
  }
}));

test('existing album summary requests preserve their response shape', async () => withAI(async () => {
  global.fetch = async () => response({ candidates: [{ content: { parts: [{ text: 'A short album summary.' }] } }] });
  const result = await handler(event({ artist: 'Miles Davis', title: 'Kind of Blue', year: 1959 }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { text: 'A short album summary.', styles: [] });
}));

function wishlistContext(storage = new Map()) {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const helpers = html.slice(html.indexOf('  function stripDiscogsSuffix('), html.indexOf('  /* The key format used by earlier versions'));
  const wishlist = html.slice(html.indexOf('  var discoveryController ='), html.indexOf('  function renderDiscoveryLists('));
  const notices = [];
  const context = {
    LS_WISHLIST: 'rcDiscoveryWishlist_v1', notices,
    localStorage: { getItem: (key) => storage.has(key) ? storage.get(key) : null },
    lsSet: (key, value) => { storage.set(key, JSON.stringify(value)); return true; },
    notify: (...args) => notices.push(args), renderDiscoveryLists: () => {},
    fmtDate: (date) => date.slice(0, 10),
    el: (tag, className, textContent) => ({
      tag, className, textContent, children: [], dataset: {}, attributes: {},
      append(...nodes) { this.children.push(...nodes); },
      setAttribute(key, value) { this.attributes[key] = value; }
    })
  };
  runInNewContext(helpers + wishlist, context);
  return context;
}

const savedAlbum = () => ({
  artist: 'Bill Evans', title: 'Waltz for Debby', reason: 'Piano jazz with a relaxed mood.',
  keys: ['Kind of Blue', 'piano'], savedAt: '2026-11-09T08:00:00.000Z'
});

test('wishlist persists album, reason, original clues and date across reloads', () => {
  const storage = new Map(), first = wishlistContext(storage);
  assert.equal(first.loadDiscoveryWishlist(), true);
  assert.equal(first.discoveryWishlist.length, 0);
  assert.equal(first.setDiscoveryWishlist([savedAlbum()]), true);
  const reloaded = wishlistContext(storage);
  assert.equal(reloaded.loadDiscoveryWishlist(), true);
  assert.equal(JSON.stringify(reloaded.discoveryWishlist[0]), JSON.stringify(savedAlbum()));
});

test('wishlist rejects malformed and duplicate data without overwriting it', () => {
  for (const raw of ['bad JSON', 'null', '{}',
    JSON.stringify([{ ...savedAlbum(), keys: [] }]),
    JSON.stringify([{ ...savedAlbum(), savedAt: 'invalid' }]),
    JSON.stringify([{ ...savedAlbum(), reason: 'x'.repeat(601) }]),
    JSON.stringify([savedAlbum(), { ...savedAlbum(), artist: 'BILL EVANS (2)' }])]) {
    const storage = new Map([['rcDiscoveryWishlist_v1', raw]]), context = wishlistContext(storage);
    assert.equal(context.loadDiscoveryWishlist(), false);
    assert.equal(context.wishlistReady, false);
    assert.equal(storage.get('rcDiscoveryWishlist_v1'), raw);
    assert.equal(context.notices.at(-1)[2], true);
  }
});

test('wishlist reports unavailable or full browser storage without success state', () => {
  const context = wishlistContext();
  context.localStorage.getItem = () => { throw new Error('Storage blocked'); };
  assert.equal(context.loadDiscoveryWishlist(), false);
  assert.match(context.notices.at(-1)[0], /Storage blocked/);
  context.discoveryWishlist = [savedAlbum()];
  context.lsSet = () => false;
  assert.equal(context.setDiscoveryWishlist([]), false);
  assert.equal(context.discoveryWishlist.length, 1);
  assert.equal(context.notices.at(-1)[2], true);
});

test('discovery album identity handles accents, punctuation and Discogs suffixes', () => {
  const context = wishlistContext();
  assert.equal(context.discoveryAlbum('Björk (2)', 'It’s Oh So Quiet'),
    context.discoveryAlbum('BJORK', "It's Oh So Quiet"));
  assert.notEqual(context.discoveryAlbum('Artist One', 'Album'), context.discoveryAlbum('Artist Two', 'Album'));
});

test('discovery and saved cards provide encoded YouTube, Qobuz and Discogs links', () => {
  const context = wishlistContext();
  context.wishlistReady = true;
  const album = { ...savedAlbum(), title: 'Album & More / <script>' };
  context.discoveryWishlist = [album];
  for (const saved of [false, true]) {
    const card = context.discoveryCard(album, saved);
    const actions = card.children.at(-1), links = actions.children.filter((n) => n.tag === 'a');
    assert.equal(links.length, 3);
    const query = encodeURIComponent(album.artist + ' ' + album.title);
    assert.equal(links[0].href, 'https://www.youtube.com/results?search_query=' + query);
    assert.equal(links[1].href, 'https://play.qobuz.com/search/all?searchEntry=' + query);
    assert.equal(links[2].href, 'https://www.discogs.com/search/?type=master&q=' + query);
    links.forEach((link) => {
      assert.equal(link.target, '_blank');
      assert.equal(link.rel, 'noopener noreferrer');
    });
    assert.equal(actions.children.at(-1).disabled, !saved);
    assert.equal(actions.children.at(-1).dataset.wishlistAction, saved ? 'remove' : 'save');
    assert.equal(card.children[0].textContent, album.title);
  }
});
