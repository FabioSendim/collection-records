const { cpSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function buildHostedHTML(html) {
  const blocks = {
    META: 'var DATA_META={"hostedShell":true};',
    CSV: 'var CSV="";',
    EXTRA: 'var EXTRA={};',
    COVERS: 'var EMBEDDED_COVERS={};',
    PORTRAITS: 'var EMBEDDED_PORTRAITS={};'
  };
  for (const [name, replacement] of Object.entries(blocks)) {
    const start = '/*<DATA:' + name + '>*/';
    const end = '/*</DATA:' + name + '>*/';
    const first = html.indexOf(start);
    const last = html.indexOf(end);
    if (first < 0 || last < first + start.length ||
        html.indexOf(start, first + start.length) !== -1 || html.indexOf(end, last + end.length) !== -1) {
      throw new Error('Missing, duplicate or invalid ' + name + ' data block.');
    }
    html = html.slice(0, first + start.length) + replacement + html.slice(last);
  }
  return html;
}

if (require.main === module) {
  const root = join(__dirname, '..');
  const html = buildHostedHTML(readFileSync(join(root, 'index.html'), 'utf8'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'index.html'), html);
  cpSync(join(root, 'assets'), join(root, 'dist', 'assets'), { recursive: true });
  console.log('Built hosted app shell: ' + Buffer.byteLength(html) + ' bytes.');
}

module.exports = { buildHostedHTML };
