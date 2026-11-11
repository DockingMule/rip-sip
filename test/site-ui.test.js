const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.hidden = true;
    this.value = '';
    this.checked = false;
    this.textContent = '';
  }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  setAttribute(name, value) { this[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function dom() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelector(selector) { return this.getElementById(selector.slice(1)); },
    createElement() { return new Element(); }
  };
}

function run(file, context) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
}

test('site announcement is rendered as text and updates on refresh', async () => {
  const document = dom();
  let interval;
  let settings = { banner: '<img src=x onerror=alert(1)>', maintenance: true };
  run('site.js', {
    document,
    fetch: async () => ({ ok: true, json: async () => settings }),
    setInterval(callback) { interval = callback; },
    console
  });
  await new Promise((resolve) => setImmediate(resolve));
  const notice = document.getElementById('site-notice');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /^<img src=x onerror=alert\(1\)>/);
  assert.match(notice.textContent, /maintenance mode/i);
  assert.equal(notice.children.length, 0);
  settings = { banner: '', maintenance: false };
  await interval();
  assert.equal(notice.hidden, true);
});

test('administration is shown only for administrators and sends settings and access changes', async () => {
  const document = dom();
  const requests = [];
  let confirmed = false;
  const data = {
    banner: 'Old notice', bannerEnabled: true, registrationOpen: true, maintenance: false,
    users: [{ email: 'host@example.com', enabled: 1, registered: 1 }],
    stats: { accounts: 2, activeRooms: 1, connectedPlayers: 2, savedLots: 3 }
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url === '/api/auth/session' ? { user: { isAdmin: true } } : url === '/api/admin' ? data : { ok: true } };
  };
  run('admin.js', { document, fetch, window: { confirm: () => confirmed } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.getElementById('admin-panel').hidden, false);
  assert.equal(document.getElementById('admin-banner').value, 'Old notice');
  document.getElementById('admin-banner').value = 'New notice';
  document.getElementById('admin-maintenance').checked = true;
  await document.getElementById('admin-settings-form').listeners.submit({ preventDefault() {} });
  const saved = requests.find((entry) => entry.url === '/api/admin/settings');
  assert.deepEqual(JSON.parse(saved.options.body), { banner: 'New notice', bannerEnabled: true, registrationOpen: true, maintenance: true });

  const button = document.getElementById('admin-users').children[0].children[1].children[0];
  await button.listeners.click();
  assert.equal(requests.filter((entry) => entry.url === '/api/admin/access').length, 0);
  confirmed = true;
  await button.listeners.click();
  const access = requests.find((entry) => entry.url === '/api/admin/access');
  assert.deepEqual(JSON.parse(access.options.body), { email: 'host@example.com', enabled: false });
  assert.equal(document.getElementById('admin-banner').value, 'New notice');

  const guestDocument = dom();
  run('admin.js', {
    document: guestDocument,
    fetch: async () => ({ ok: true, json: async () => ({ user: { email: 'host@example.com' } }) }),
    window: {}
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guestDocument.getElementById('admin-panel').hidden, true);
});

test('administrators can display and replace a single-use invitation code', async () => {
  const document = dom();
  const requests = [];
  let confirmed = false;
  const data = {
    banner: '', bannerEnabled: false, registrationOpen: true, maintenance: false,
    users: [{ email: 'invitee@example.com', enabled: 1, registered: 0 }],
    stats: { accounts: 1, activeRooms: 0, connectedPlayers: 0, savedLots: 0 }
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const body = url === '/api/auth/session' ? { user: { isAdmin: true } }
      : url === '/api/admin' ? data
        : { ok: true, invitation: { code: 'new-private-code', expiresAt: 2000000000000 } };
    return { ok: true, json: async () => body };
  };
  run('admin.js', { document, fetch, window: { confirm: () => confirmed } });
  await new Promise((resolve) => setImmediate(resolve));
  const newCode = document.getElementById('admin-users').children[0].children[1].children[0];
  await newCode.listeners.click();
  assert.equal(requests.filter(({ url }) => url === '/api/admin/access').length, 0);
  confirmed = true;
  await newCode.listeners.click();
  assert.equal(document.getElementById('admin-invite-result').hidden, false);
  assert.equal(document.getElementById('admin-invite-code').value, 'new-private-code');
  assert.match(document.getElementById('admin-invite-detail').textContent, /invitee@example\.com/);
  assert.deepEqual(JSON.parse(requests.find(({ url }) => url === '/api/admin/access').options.body),
    { email: 'invitee@example.com', enabled: true });
});

test('registration asks for and submits an invitation code, but sign-in does not', async () => {
  const document = dom();
  const form = new Element();
  const authSubmit = document.getElementById('auth-submit');
  authSubmit.firstChild = { textContent: '' };
  for (const id of ['auth-login-mode', 'auth-register-mode']) {
    document.getElementById(id).classList = { toggle() {} };
  }
  const requests = [];
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const start = source.indexOf('function setAuthMode(');
  const end = source.indexOf("$('#auth-logout').addEventListener", start);
  const context = {
    $: (selector) => document.querySelector(selector), authForm: form, authMode: 'login',
    errorAt() {},
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: false, json: async () => ({ error: 'Test failure' }) };
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.setAuthMode('register');
  assert.equal(document.getElementById('auth-invite-wrap').hidden, false);
  assert.equal(document.getElementById('auth-invite-code').required, true);
  document.getElementById('auth-email').value = 'host@example.com';
  document.getElementById('auth-password').value = 'a-sufficiently-long-password';
  document.getElementById('auth-invite-code').value = ' private-code ';
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(requests[0].url, '/api/auth/register');
  assert.equal(requests[0].body.invitationCode, 'private-code');
  context.setAuthMode('login');
  assert.equal(document.getElementById('auth-invite-wrap').hidden, true);
  assert.equal(document.getElementById('auth-invite-code').required, false);
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(requests[1].url, '/api/auth/login');
  assert.equal('invitationCode' in requests[1].body, false);
});
