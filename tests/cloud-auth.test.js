const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const sessionKey = 'collection-owner-session';
const helpers = html.slice(html.indexOf('  function cloudClearSession('), html.indexOf('  async function cloudDecode('));
const startup = html.slice(html.indexOf('  async function cloudStart('), html.indexOf('  function cloudSnapshot('));
const login = html.slice(html.indexOf("  $('cloud-login-form').addEventListener("), html.indexOf("  $('cloud-save-btn').addEventListener("));
const logout = html.slice(html.indexOf("  $('cloud-logout-btn').addEventListener("), html.indexOf("  window.addEventListener('beforeunload'"));

function storage() {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  };
}

function session(patch = {}) {
  return { user: { id: 'owner' }, access_token: 'access', refresh_token: 'refresh', expires_in: 3600, ...patch };
}

function app(localStorage = storage(), sessionStorage = storage()) {
  const elements = new Map();
  const requests = [];
  const notices = [];
  const context = {
    cloud: { owner: 'owner', enabled: true, session: null, rememberSession: false },
    localStorage, sessionStorage,
    DATA: {},
    location: { reload() { context.reloaded = true; } },
    $: id => {
      if (!elements.has(id)) {
        elements.set(id, {
          value: '', checked: false,
          addEventListener(event, callback) { this[event] = callback; }
        });
      }
      return elements.get(id);
    },
    cloudRequest: async (path, options) => {
      requests.push({ path, options });
      if (path === '/auth/v1/user') return { id: 'owner' };
      if (path.startsWith('/rest/')) return [{ version: 0, payload: null }];
      return session();
    },
    cloudStatus() {},
    htmlBackupStore: async () => null,
    notify: message => notices.push(message),
    flushNotes() {}
  };
  runInNewContext(helpers + startup + login + logout, context);
  return { context, elements, requests, notices };
}

async function signIn(context, remember = false) {
  context.$('cloud-email').value = 'owner@example.test';
  context.$('cloud-password').value = 'test-password';
  context.$('cloud-remember').checked = remember;
  await context.$('cloud-login-form').submit({ preventDefault() {} });
}

test('default sign-in stays temporary and preserves existing tab sessions', async () => {
  const { context } = app();
  await signIn(context);
  assert.equal(context.reloaded, true);
  assert.equal(context.localStorage.getItem(sessionKey), null);
  assert.ok(context.sessionStorage.getItem(sessionKey));
  assert.equal(context.$('cloud-password').value, '');

  const sameTab = app(context.localStorage, context.sessionStorage).context;
  await sameTab.cloudStart();
  assert.equal(sameTab.cloud.session.user.id, 'owner');
  assert.equal(sameTab.cloud.rememberSession, false);

  const reopened = app(context.localStorage).context;
  await reopened.cloudStart();
  assert.equal(reopened.cloud.session, null);
});

test('remembered sign-in survives reopening and saves refreshed tokens persistently', async () => {
  const { context } = app();
  context.sessionStorage.setItem(sessionKey, JSON.stringify(session()));
  await signIn(context, true);
  assert.equal(context.reloaded, true);
  assert.equal(context.sessionStorage.getItem(sessionKey), null);
  const saved = JSON.parse(context.localStorage.getItem(sessionKey));
  assert.equal(saved.password, undefined);
  saved.expires_at = 0;
  context.localStorage.setItem(sessionKey, JSON.stringify(saved));

  const { context: reopened, requests } = app(context.localStorage);
  reopened.cloudRequest = async (path, options) => {
    requests.push({ path, options });
    if (path.includes('grant_type=refresh_token')) return session({ refresh_token: 'rotated' });
    if (path === '/auth/v1/user') return { id: 'owner' };
    return [{ version: 0, payload: null }];
  };
  await reopened.cloudStart();
  assert.equal(reopened.cloud.session.user.id, 'owner');
  assert.equal(reopened.cloud.rememberSession, true);
  assert.equal(JSON.parse(reopened.localStorage.getItem(sessionKey)).refresh_token, 'rotated');
  assert.equal(reopened.sessionStorage.getItem(sessionKey), null);
  assert.equal(JSON.parse(requests[0].options.body).refresh_token, 'refresh');
});

test('choosing temporary sign-in removes a previously remembered session', async () => {
  const { context } = app();
  context.localStorage.setItem(sessionKey, JSON.stringify(session()));
  await signIn(context);
  assert.equal(context.localStorage.getItem(sessionKey), null);
  assert.ok(context.sessionStorage.getItem(sessionKey));
});

test('sign-out removes both saved sessions and leaves reopened app signed out', async () => {
  const { context, requests } = app();
  await signIn(context, true);
  context.sessionStorage.setItem(sessionKey, JSON.stringify(session()));
  await context.$('cloud-logout-btn').click();
  assert.equal(requests.at(-1).path, '/auth/v1/logout');
  assert.equal(context.cloud.session, null);
  assert.equal(context.localStorage.getItem(sessionKey), null);
  assert.equal(context.sessionStorage.getItem(sessionKey), null);
  const reopened = app(context.localStorage).context;
  await reopened.cloudStart();
  assert.equal(reopened.cloud.session, null);
});

test('rejected remembered refresh clears credentials and reports the error', async () => {
  const { context, notices } = app();
  context.localStorage.setItem(sessionKey, JSON.stringify(session({ expires_at: 0 })));
  const request = context.cloudRequest;
  context.cloudRequest = async (path, options) => {
    if (path.includes('grant_type=refresh_token')) throw new Error('Refresh token revoked');
    return request(path, options);
  };
  await context.cloudStart();
  assert.equal(context.cloud.session, null);
  assert.equal(context.localStorage.getItem(sessionKey), null);
  assert.equal(context.sessionStorage.getItem(sessionKey), null);
  assert.match(notices[0], /Refresh token revoked/);
  assert.equal(context.cloud.ready, true);
});

test('remembered sign-in still rejects non-owner accounts', async () => {
  const { context } = app();
  context.cloudRequest = async () => session({ user: { id: 'visitor' } });
  await signIn(context, true);
  assert.match(context.$('cloud-login-status').textContent, /not the collection owner/);
  assert.equal(context.reloaded, undefined);
  assert.equal(context.localStorage.getItem(sessionKey), null);
});

test('persistent storage failure is shown instead of claiming sign-in succeeded', async () => {
  const { context } = app();
  context.localStorage.setItem = () => { throw new Error('Storage unavailable'); };
  await signIn(context, true);
  assert.match(context.$('cloud-login-status').textContent, /Storage unavailable/);
  assert.equal(context.reloaded, undefined);
  assert.equal(context.cloud.session, null);
});
