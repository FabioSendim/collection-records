const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'netlify', 'functions', 'discogs.js'), 'utf8');
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const formats = html.slice(html.indexOf('  function hasCdFormat('), html.indexOf('  function scoreLetter('));
const barcode = html.slice(html.indexOf('  function normalizedBarcode('), html.indexOf('  function stopBarcodeCamera('));

function proxy(token = 'test-token') {
  const requests = [];
  const context = {
    exports: {}, process: { env: { DISCOGS_TOKEN: token } }, URL, Buffer,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, ok: true, headers: new Headers(), text: async () => '{"results":[]}' };
    }
  };
  runInNewContext(source, context);
  return { handler: context.exports.handler, requests };
}

test('barcode proxy searches only CD releases, preserves leading zeroes and supports pagination', async () => {
  const { handler, requests } = proxy();
  const response = await handler({ queryStringParameters: { barcode: '0077774615225', page: '2' } });
  assert.equal(response.statusCode, 200);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/database/search');
  assert.equal(url.searchParams.get('type'), 'release');
  assert.equal(url.searchParams.get('format'), 'CD');
  assert.equal(url.searchParams.get('barcode'), '0077774615225');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('per_page'), '10');
  assert.equal(requests[0].options.headers.Authorization, 'Discogs token=test-token');
  assert.ok(!response.body.includes('test-token'));
});

test('invalid barcode or page and missing token fail before calling Discogs', async () => {
  const { handler, requests } = proxy();
  for (const barcode of ['abc123456789', '12345', '123456789012345', '123456789012&format=Vinyl']) {
    assert.equal((await handler({ queryStringParameters: { barcode } })).statusCode, 400);
  }
  for (const page of ['0', '-1', '1.5', '1001', '2&format=Vinyl']) {
    assert.equal((await handler({ queryStringParameters: { barcode: '4006381333931', page } })).statusCode, 400);
  }
  assert.equal(requests.length, 0);
  const anonymous = proxy('');
  assert.equal((await anonymous.handler({ queryStringParameters: { barcode: '4006381333931' } })).statusCode, 401);
  assert.equal(anonymous.requests.length, 0);
});

test('CD classification uses the main medium, including multi-disc and CD-R releases', () => {
  const context = {};
  runInNewContext(formats + barcode, context);
  for (const format of ['CD, Album', '2xCD, Compilation', 'Box Set, 5xCD', 'CD + DVD', 'CD + Vinyl', 'All Media; CD; Album', 'CD-R, Album']) {
    assert.equal(context.isCdFormat(format), true, format);
    assert.equal(context.fmtGroup(format), 'CD', format);
  }
  for (const format of ['LP', 'LP + CD', 'Vinyl, LP, Album, CD', 'Box Set, 2xLP, CD', '2xLP, Album', 'DVD + CD', 'SACD + CD', 'CD-ROM', 'Not CD', '']) {
    assert.equal(context.isCdFormat(format), false, format);
  }
  assert.equal(context.fmtGroup('LP, Stereo'), 'LP');
  assert.equal(context.fmtGroup('2xLP, Stereo'), '2xLP');
  assert.equal(context.fmtGroup('LP + CD'), 'LP');
  for (const format of ['LP + CD', '2x12", Album + CD', 'Box + DVD-V + Blu-ray + 2xCD + LP', 'CD + DVD', 'Box Set, 5xCD']) {
    assert.equal(context.hasCdFormat(format), true, format);
  }
  for (const format of ['LP', 'SACD', 'CD-ROM', 'Not CD']) {
    assert.equal(context.hasCdFormat(format), false, format);
  }
  context.state = { view: 'grid' };
  assert.equal(context.isCdCatalogue({ f: 'LP + CD' }), false);
  context.state.view = 'cd';
  assert.equal(context.isCdCatalogue({ f: 'LP + CD' }), true);
  assert.equal(context.isCdCatalogue({ f: 'LP' }), false);
  assert.equal(context.normalizedBarcode('0 07777-4615225'), '0077774615225');
  assert.equal(context.normalizedBarcode('4006381333931'), '4006381333931');
  assert.equal(context.normalizedBarcode('abc4006381333931'), '');
});
