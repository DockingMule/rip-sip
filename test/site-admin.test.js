const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { io: connect } = require('socket.io-client');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'going-once-admin-test-'));
const databasePath = path.join(directory, 'test.sqlite');
const initialDatabase = new Database(databasePath);
initialDatabase.exec(`CREATE TABLE accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
)`);
const password = 'a-sufficiently-long-password';
const salt = crypto.randomBytes(16).toString('hex');
initialDatabase.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)')
  .run('administrator', 'admin@example.com', salt, crypto.scryptSync(password, salt, 64).toString('hex'), Date.now());
initialDatabase.close();
process.env.DATABASE_PATH = databasePath;
process.env.HOST_INVITE_EMAILS = 'host@example.com';
process.env.SITE_ADMIN_EMAIL = 'admin@example.com';
const { server, io, rooms, database } = require('../server');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function call(socket, event) {
  return new Promise((resolve) => socket.emit(event, resolve));
}

test('administrator controls access, maintenance and persistent site settings', async (context) => {
  const sockets = [];
  context.after(() => {
    sockets.forEach((socket) => socket.disconnect());
    for (const room of rooms.values()) clearTimeout(room.timer);
    io.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  async function request(route, { method = 'GET', cookie, body, origin = url } = {}) {
    return fetch(url + route, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  }
  async function auth(route, email, invitationCode) {
    const response = await request(`/api/auth/${route}`, { method: 'POST', body: { email, password, invitationCode } });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function socket(cookie) {
    const client = connect(url, cookie ? { extraHeaders: { Cookie: cookie } } : {});
    sockets.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    return client;
  }
  const admin = await auth('login', 'admin@example.com');
  assert.equal(admin.response.status, 200);
  assert.equal((await auth('register', 'host@example.com')).response.status, 403);
  const hostInvite = await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'host@example.com', enabled: true } });
  const host = await auth('register', 'host@example.com', (await hostInvite.json()).invitation.code);
  assert.equal(host.response.status, 200);
  assert.deepEqual(await (await request('/api/auth/session', { cookie: admin.cookie })).json(),
    { user: { email: 'admin@example.com', isAdmin: true } });
  assert.equal((await request('/api/admin')).status, 401);
  assert.equal((await request('/api/admin', { cookie: host.cookie })).status, 403);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', cookie: host.cookie, body: {} })).status, 403);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: host.cookie, body: { email: 'other@example.com', enabled: true } })).status, 403);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, origin: 'https://other.example', body: { email: 'other@example.com', enabled: true } })).status, 403);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'admin@example.com', enabled: false } })).status, 400);

  const hostSocket = await socket(host.cookie);
  const guestSocket = await socket();
  const created = await emit(hostSocket, 'room:create', { auctionName: 'Existing auction' });
  assert.ok(created.code);
  const joined = await emit(guestSocket, 'room:join', { name: 'Guest', code: created.code });
  assert.ok(joined.rejoinToken);
  assert.equal((await emit(hostSocket, 'round:prepare', { name: 'Chair', startingBid: 10, autoEnd: false })).ok, true);
  assert.equal((await call(hostSocket, 'round:start')).ok, true);

  const settings = { banner: '<b>Maintenance soon</b>', bannerEnabled: true, registrationOpen: false, maintenance: true };
  assert.equal((await request('/api/admin/settings', { method: 'PUT', cookie: admin.cookie, body: settings })).status, 200);
  assert.deepEqual(await (await request('/api/site')).json(), { banner: settings.banner, maintenance: true });
  const newInvite = await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'new@example.com', enabled: true } });
  assert.equal(newInvite.status, 200);
  const { code: newCode, expiresAt } = (await newInvite.json()).invitation;
  assert.match(newCode, /^[\da-f]{64}$/);
  assert.ok(expiresAt > Date.now() + 6 * 24 * 60 * 60 * 1000 && expiresAt <= Date.now() + 7 * 24 * 60 * 60 * 1000);
  const storedInvitation = database.prepare('SELECT token_hash FROM host_invitations WHERE email = ?').get('new@example.com');
  assert.equal(storedInvitation.token_hash, crypto.createHash('sha256').update(newCode).digest('hex'));
  assert.notEqual(storedInvitation.token_hash, newCode);
  assert.equal(JSON.stringify(await (await request('/api/admin', { cookie: admin.cookie })).json()).includes(newCode), false);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'other@example.com', enabled: true } })).status, 200);
  assert.equal((await auth('register', 'new@example.com', newCode)).response.status, 403);
  assert.equal((await auth('login', 'host@example.com')).response.status, 200);

  const anotherHost = await socket(host.cookie);
  const stranger = await socket();
  assert.match((await emit(anotherHost, 'room:create', { auctionName: 'Blocked' })).error, /maintenance/i);
  assert.match((await emit(stranger, 'room:join', { name: 'New guest', code: created.code })).error, /maintenance/i);
  assert.match((await emit(stranger, 'room:join', { code: created.code, playerId: joined.playerId })).error, /maintenance/i);
  assert.equal((await emit(guestSocket, 'bid:place', { amount: 10 })).ok, true);
  const reconnected = await socket();
  assert.equal((await emit(reconnected, 'room:join', { code: created.code, playerId: joined.playerId, rejoinToken: joined.rejoinToken })).ok, true);
  assert.equal((await call(hostSocket, 'round:end')).ok, true);
  const adminSocket = await socket(admin.cookie);
  assert.ok((await emit(adminSocket, 'room:create', { auctionName: 'Admin room' })).code);
  const stats = await (await request('/api/admin', { cookie: admin.cookie })).json();
  assert.equal(stats.stats.accounts, 2);
  assert.equal(stats.stats.activeRooms, 2);
  assert.equal(stats.stats.connectedPlayers, 3);
  assert.equal(stats.stats.savedLots, 1);

  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'host@example.com', enabled: false } })).status, 200);
  assert.equal((await request('/api/host/profile', { cookie: host.cookie })).status, 401);
  assert.equal((await auth('login', 'host@example.com')).response.status, 401);
  assert.match((await emit(hostSocket, 'round:prepare', { name: 'Blocked', startingBid: 1 })).error, /signed-in host/i);
  assert.match((await emit(anotherHost, 'room:join', { code: created.code, playerId: created.playerId, rejoinToken: created.rejoinToken })).error, /sign in/i);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'host@example.com', enabled: true } })).status, 200);
  assert.equal((await request('/api/host/profile', { cookie: host.cookie })).status, 401);
  assert.equal((await auth('login', 'host@example.com')).response.status, 200);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'host@example.com', enabled: false } })).status, 200);

  const restart = spawnSync(process.execPath, ['-e', "const s = require('./server'); console.log(JSON.stringify({ access: s.database.prepare('SELECT enabled FROM host_access WHERE email = ?').get('host@example.com'), settings: s.database.prepare('SELECT banner, maintenance FROM site_settings').get() })); s.database.close();"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
    encoding: 'utf8'
  });
  assert.equal(restart.status, 0, restart.stderr);
  assert.deepEqual(JSON.parse(restart.stdout), { access: { enabled: 0 }, settings: { banner: settings.banner, maintenance: 1 } });
  const missingAdmin = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SITE_ADMIN_EMAIL: 'missing@example.com' },
    encoding: 'utf8'
  });
  assert.notEqual(missingAdmin.status, 0);
  assert.match(missingAdmin.stderr, /existing registered account/i);

  assert.equal((await request('/api/admin/settings', { method: 'PUT', cookie: admin.cookie, body: { ...settings, bannerEnabled: false, registrationOpen: true, maintenance: false } })).status, 200);
  assert.deepEqual(await (await request('/api/site')).json(), { banner: '', maintenance: false });
  assert.equal((await auth('register', 'new@example.com')).response.status, 403);
  assert.equal((await auth('register', 'new@example.com', '0'.repeat(64))).response.status, 403);
  assert.equal((await auth('register', 'other@example.com', newCode)).response.status, 403);
  database.prepare('UPDATE host_invitations SET expires_at = ? WHERE email = ?').run(Date.now() - 1, 'new@example.com');
  assert.equal((await auth('register', 'new@example.com', newCode)).response.status, 403);
  const reissued = await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'new@example.com', enabled: true } });
  const reissuedCode = (await reissued.json()).invitation.code;
  assert.notEqual(reissuedCode, newCode);
  assert.equal((await auth('register', 'new@example.com', newCode)).response.status, 403);
  assert.equal((await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'new@example.com', enabled: false } })).status, 200);
  assert.equal((await auth('register', 'new@example.com', reissuedCode)).response.status, 403);
  const finalInvite = await request('/api/admin/access', { method: 'PUT', cookie: admin.cookie, body: { email: 'new@example.com', enabled: true } });
  const finalCode = (await finalInvite.json()).invitation.code;
  const results = await Promise.all([auth('register', 'new@example.com', finalCode), auth('register', 'new@example.com', finalCode)]);
  assert.equal(results.filter(({ response }) => response.status === 200).length, 1);
  assert.ok(results.some(({ response }) => response.status === 403 || response.status === 409));
  assert.equal(database.prepare('SELECT email FROM host_invitations WHERE email = ?').get('new@example.com'), undefined);
  assert.equal((await auth('register', 'host@example.com')).response.status, 403);
  assert.ok((await emit(stranger, 'room:join', { name: 'New guest', code: created.code })).playerId);

  const bootstrapPath = path.join(directory, 'bootstrap.sqlite');
  const bootstrap = spawnSync(process.execPath, ['scripts/create-host-invite.js', 'bootstrap@example.com'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_PATH: bootstrapPath, SITE_ADMIN_EMAIL: '', HOST_INVITE_EMAILS: '' },
    encoding: 'utf8'
  });
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  const bootstrapCode = bootstrap.stdout.match(/^[\da-f]{64}$/m)?.[0];
  assert.ok(bootstrapCode);
  const bootstrapDb = new Database(bootstrapPath, { readonly: true });
  assert.equal(bootstrapDb.prepare('SELECT token_hash FROM host_invitations WHERE email = ?').get('bootstrap@example.com').token_hash,
    crypto.createHash('sha256').update(bootstrapCode).digest('hex'));
  bootstrapDb.close();
});
