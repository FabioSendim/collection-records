const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const names = html.slice(html.indexOf('  function stripDiscogsSuffix('), html.indexOf('  /* The key format used by earlier versions'));
const labelKey = html.slice(html.indexOf('  function labelKey('), html.indexOf('\n', html.indexOf('  function labelKey(')));
const splitLabels = html.slice(html.indexOf('  function splitLabels('), html.indexOf('  function cleanLabel('));
const phono = html.slice(html.indexOf('  var PHONO_GUIDE ='), html.indexOf('  function renderDetail('));
const context = {
  el: (tag, className, textContent) => ({
    tag, className, textContent, children: [],
    append(...children) { this.children.push(...children); }
  })
};
runInNewContext(names + labelKey + splitLabels + phono, context);

function record(patch = {}) {
  return { l: 'Blue Note', y: 2024, f: 'LP, Reissue, Mono', ...patch };
}
function text(node) {
  return [node.textContent || '', ...node.children.map(text)].join('\n');
}

test('modern Blue Note reissues use RIAA and Enhanced comparison, never historical AES', () => {
  const advice = context.phonoAdvice(record());
  assert.equal(advice.enhanced, true);
  assert.equal(advice.matches[0].rule.page, 5);
  assert.equal(advice.alternatives.length, 0);
  assert.match(advice.summary, /RIAA \/ Enhanced/);
  const note = text(context.phonoNote(record()));
  assert.match(note, /not confirmation/);
  assert.match(note, /500 Hz turnover \/ R shelf \(\+20 dB\) \/ -13.7 dB/);
  assert.doesNotMatch(note, /AES/);
});

test('modern reissue overrides historical family suggestions across the collection labels', () => {
  for (const label of ['Philips', 'Riverside Records', 'Mercury', 'Decca', 'Capitol Records',
    'Contemporary Records', 'Pacific Jazz', 'Deutsche Grammophon', 'RCA Victor', 'Epic']) {
    const advice = context.phonoAdvice(record({ l: label }));
    assert.ok(advice.matches.length, label);
    assert.equal(advice.enhanced, true, label);
    assert.equal(advice.alternatives.length, 0, label);
  }
});

test('known standard label family allows comparison for a non-early pressing', () => {
  const advice = context.phonoAdvice(record({ l: 'Atlantic', y: 1969, f: 'LP, Stereo' }));
  assert.equal(advice.enhanced, true);
  assert.equal(advice.alternatives[0].curve, 'nab');
  assert.match(advice.alternatives[0].when, /produced by MGM/);
});

test('ECM year does not establish a Deutsche Grammophon pressing', () => {
  const old = context.phonoAdvice(record({ l: 'ECM Records', y: 1972 }));
  assert.equal(old.enhanced, false);
  assert.equal(old.needsCheck, true);
  assert.equal(old.alternatives[0].curve, 'teldec');
  assert.match(old.alternatives[0].when, /made by Deutsche Grammophon/);
  assert.match(old.alternatives[0].when, /date alone is insufficient/);
  assert.equal(context.phonoAdvice(record({ l: 'ECM Records', y: 2025 })).alternatives.length, 0);
});

test('missing release year never falls back to recording year or artist biography', () => {
  for (const y of [0, '', null, undefined, 'unknown', 3000]) {
    const advice = context.phonoAdvice(record({ y, recording: { start: 1959 } }));
    assert.equal(advice.knownYear, false);
    assert.equal(advice.enhanced, false);
    assert.match(advice.summary, /verify pressing/);
    assert.match(text(context.phonoNote(record({ y }))), /year is unknown/);
  }
  const advice = context.phonoAdvice(record({ y: 2024, recording: { start: 1959 } }));
  assert.equal(advice.modern, true);
  assert.equal(advice.alternatives.length, 0);
});

test('pre-1960 issues expose conditional alternatives rather than a claimed cutting curve', () => {
  const advice = context.phonoAdvice(record({ y: 1953 }));
  assert.equal(advice.enhanced, false);
  assert.equal(advice.alternatives[0].curve, 'aes');
  assert.match(text(context.phonoNote(record({ y: 1953 }))), /not selected automatically/);
});

test('unknown labels clearly distinguish modern guidance from an exact guide match', () => {
  const modern = context.phonoAdvice(record({ l: 'We Release Jazz' }));
  assert.equal(modern.matches.length, 0);
  assert.equal(modern.enhanced, true);
  const note = text(context.phonoNote(record({ l: 'We Release Jazz' })));
  assert.match(note, /No exact label entry is mapped/);
  assert.match(note, /modern pressings/);
  const old = context.phonoAdvice(record({ l: 'Unknown Label', y: 1983 }));
  assert.equal(old.enhanced, false);
  assert.equal(old.summary, 'RIAA reference');
});

test('matches explicit aliases and Discogs suffixes without substring family guesses', () => {
  const matched = context.phonoAdvice(record({ l: 'Rhino Records (2), Atlantic, Atlantic' }));
  assert.equal(matched.matches.length, 2);
  assert.equal(context.phonoAdvice(record({ l: 'Verve Forecast' })).matches.length, 0);
  assert.equal(context.phonoAdvice(record({ l: 'Not Blue Note' })).matches.length, 0);
});

test('78 rpm and non-vinyl formats do not receive ordinary modern LP advice', () => {
  const shellac = context.phonoAdvice(record({ y: 1950, f: 'Shellac, 10", 78 RPM' }));
  assert.equal(shellac.enhanced, false);
  assert.equal(shellac.summary, 'Verify 78 rpm EQ');
  assert.match(text(context.phonoNote(record({ f: '78 RPM', y: 2024 }))), /Do not assume RIAA/);
  for (const f of ['CD', 'SACD', 'Cassette', 'File, FLAC', 'DVD']) {
    assert.equal(context.phonoAdvice(record({ f })).applicable, false, f);
    assert.match(text(context.phonoNote(record({ f }))), /does not use a phono stage/);
  }
  assert.equal(context.phonoAdvice(record({ f: 'LP, CD' })).applicable, true);
  assert.equal(context.phonoAdvice(record({ f: '7", 45 RPM' })).applicable, true);
});

test('every configured alternative has verified parameters and a valid source page', () => {
  const keys = new Set();
  for (const rule of context.PHONO_LABELS) {
    assert.ok(rule.page >= 4 && rule.page <= 17);
    for (const alias of rule.names) {
      const key = context.phonoLabelKey(alias);
      assert.equal(keys.has(key), false, alias);
      keys.add(key);
    }
    for (const alternative of rule.alternatives || []) {
      assert.ok(context.PHONO_CURVES[alternative.curve], alternative.curve);
      assert.ok(alternative.when);
    }
  }
  assert.equal(context.phonoParameters(context.PHONO_CURVES.aes),
    '400 Hz turnover / N shelf (Null) / -12.3 dB treble cut at 10 kHz');
});

test('phono notes link to the guide page, remain collapsed and never mutate personal notes', () => {
  const original = record({ n: 'My listening notes', x: 'My other notes' });
  const before = JSON.stringify(original), note = context.phonoNote(original);
  assert.equal(note.tag, 'details');
  assert.equal(note.open, undefined);
  const link = note.children.find((n) => n.tag === 'a');
  assert.equal(link.href, 'https://www.goldnote.it/download/media/PH-1000_EQ_Curves.pdf#page=5');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(JSON.stringify(original), before);
  assert.match(html, /body\.append\(phonoNote\(r\)\)/);
});

test('every embedded record gets a phono note without altering its saved data', () => {
  const data = {};
  runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1], data);
  const parser = html.slice(html.indexOf('  function parseCSV('), html.indexOf('  /* Columns are found by header name'));
  runInNewContext(parser, context);
  const rows = context.parseCSV(data.CSV), headers = rows.shift();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const r = record({
      l: row[headers.indexOf('Label')], y: row[headers.indexOf('Released')],
      f: row[headers.indexOf('Format')], n: row[headers.indexOf('Collection Revision Notes')]
    });
    const before = JSON.stringify(r), note = context.phonoNote(r);
    assert.equal(note.tag, 'details', row[headers.indexOf('release_id')]);
    assert.match(note.children[0].textContent, /^Phono stage/);
    assert.equal(JSON.stringify(r), before);
    if (+r.y >= 2000 && context.phonoAdvice(r).applicable) {
      assert.equal(context.phonoAdvice(r).alternatives.length, 0);
    }
  }
});
