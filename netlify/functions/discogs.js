// Discogs proxy. The Discogs token lives in the DISCOGS_TOKEN environment variable (Netlify > Site configuration >
// Environment variables) and is never sent to the browser.
//   ?id=<release id>      release JSON
//   ?artist=<artist id>   artist JSON (profile, images)
//   ?search=<name>        artist search (needs the token)
//   ?img=<url>            image from Discogs / Wikimedia / TheAudioDB
//   ?status=1             { discogsToken, ai } so the app knows what is configured

const UA = 'RecordsCollection/2.0';
const IMG_HOSTS = /^(i\.discogs\.com|img\.discogs\.com|upload\.wikimedia\.org|(www\.|r2\.)?theaudiodb\.com)$/i;

exports.handler = async function (event) {
  if (event.httpMethod && event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!sameOrigin(event)) return json(403, { error: 'Forbidden' });

  const p = event.queryStringParameters || {};
  const token = process.env.DISCOGS_TOKEN || '';

  if (p.status) return json(200, { discogsToken: !!token, ai: !!process.env.GEMINI_API_KEY });
  if (p.img) return proxyImage(p.img);

  let path;
  if (p.id) {
    if (!/^\d{1,10}$/.test(p.id)) return json(400, { error: 'Bad release id' });
    path = '/releases/' + p.id;
  } else if (p.artist) {
    if (!/^\d{1,10}$/.test(p.artist)) return json(400, { error: 'Bad artist id' });
    path = '/artists/' + p.artist;
  } else if (p.search) {
    if (!token) return json(401, { error: 'Discogs search needs DISCOGS_TOKEN on the server' });
    path = '/database/search?type=artist&per_page=10&q=' + encodeURIComponent(String(p.search).slice(0, 200));
  } else {
    return json(400, { error: 'Missing id, artist, search or img' });
  }

  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (token) headers.Authorization = 'Discogs token=' + token;

  try {
    const res = await fetch('https://api.discogs.com' + path, { headers });
    const out = { 'Content-Type': 'application/json', 'Cache-Control': res.ok ? 'public, max-age=86400' : 'no-store' };
    const ra = res.headers.get('retry-after');
    if (ra) out['Retry-After'] = ra;
    return { statusCode: res.status, headers: out, body: await res.text() };
  } catch (err) {
    return json(502, { error: String((err && err.message) || err) });
  }
};

async function proxyImage(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return json(400, { error: 'Bad image URL' }); }
  if (u.protocol !== 'https:' || !IMG_HOSTS.test(u.hostname)) return json(400, { error: 'Image host not allowed' });
  try {
    const res = await fetch(u.toString(), { headers: { 'User-Agent': UA } });
    if (!res.ok) return json(res.status, { error: 'Upstream HTTP ' + res.status });
    const ct = res.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(ct)) return json(415, { error: 'Not an image' });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return json(413, { error: 'Image too large' });
    return {
      statusCode: 200,
      headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return json(502, { error: String((err && err.message) || err) });
  }
}

function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return ''; }
}

// Only this site (or localhost during development) may use the proxy, so other sites cannot spend the token's quota.
function sameOrigin(event) {
  const h = event.headers || {};
  const host = h['x-forwarded-host'] || h.host || '';
  const from = hostOf(h.origin || '') || hostOf(h.referer || '');
  if (!from || from === host) return true;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  return local.test(from) && local.test(host);
}

function json(code, obj) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj)
  };
}
