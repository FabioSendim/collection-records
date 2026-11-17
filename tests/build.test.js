const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script } = require('node:vm');
const { execFileSync } = require('node:child_process');
const { buildHostedHTML } = require('../scripts/build.js');

const sourcePath = join(__dirname, '..', 'index.html');
const source = readFileSync(sourcePath, 'utf8');

function block(html, name) {
  const start = '/*<DATA:' + name + '>*/';
  const end = '/*</DATA:' + name + '>*/';
  return html.slice(html.indexOf(start) + start.length, html.indexOf(end));
}

test('hosted build removes collection snapshots and images while preserving export placeholders', () => {
  const html = buildHostedHTML(source);
  assert.equal(block(html, 'META'), 'var DATA_META={"hostedShell":true};');
  assert.equal(block(html, 'CSV'), 'var CSV="";');
  assert.equal(block(html, 'EXTRA'), 'var EXTRA={};');
  assert.equal(block(html, 'COVERS'), 'var EMBEDDED_COVERS={};');
  assert.equal(block(html, 'PORTRAITS'), 'var EMBEDDED_PORTRAITS={};');
  assert.ok(Buffer.byteLength(html) < 500_000);
  assert.ok(Buffer.byteLength(html) < Buffer.byteLength(source) / 10);
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(() => new Script(match[1]));
  }
  assert.equal(readFileSync(sourcePath, 'utf8'), source);
});

test('hosted build rejects missing, duplicate and reversed data markers', () => {
  for (const name of ['META', 'CSV', 'EXTRA', 'COVERS', 'PORTRAITS']) {
    const start = '/*<DATA:' + name + '>*/';
    const end = '/*</DATA:' + name + '>*/';
    for (const invalid of [
      source.replace(start, ''),
      source.replace(end, ''),
      source + start,
      source + end,
      end + source.replace(end, '')
    ]) {
      assert.throws(() => buildHostedHTML(invalid), new RegExp(name + ' data block'));
    }
  }
});

test('build includes the brand logo in the Netlify publish directory', () => {
  const root = join(__dirname, '..');
  execFileSync(process.execPath, [join(root, 'scripts', 'build.js')]);
  assert.deepEqual(
    readFileSync(join(root, 'dist', 'assets', 'the-crate-vinyl-logo.png')),
    readFileSync(join(root, 'assets', 'the-crate-vinyl-logo.png'))
  );
});
