const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024 });
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'going-once.sqlite');
if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const database = new Database(databasePath);
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS host_access (
    email TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  );
  CREATE TABLE IF NOT EXISTS host_invitations (
    email TEXT PRIMARY KEY REFERENCES host_access(email) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS site_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    banner TEXT NOT NULL DEFAULT '',
    banner_enabled INTEGER NOT NULL DEFAULT 0 CHECK (banner_enabled IN (0, 1)),
    registration_open INTEGER NOT NULL DEFAULT 1 CHECK (registration_open IN (0, 1)),
    maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1))
  );
  INSERT OR IGNORE INTO site_settings (id) VALUES (1);
  CREATE TABLE IF NOT EXISTS host_profiles (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    venmo_link TEXT NOT NULL DEFAULT '',
    avatar_type TEXT,
    avatar_data BLOB,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS host_auctions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    room_code TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS host_auctions_owner_date ON host_auctions(account_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS host_lots (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    auction_id TEXT REFERENCES host_auctions(id),
    room_code TEXT NOT NULL,
    round INTEGER NOT NULL,
    lot_name TEXT NOT NULL,
    description TEXT NOT NULL,
    image TEXT NOT NULL,
    starting_bid REAL NOT NULL,
    increment REAL NOT NULL,
    winning_bid REAL NOT NULL,
    winner TEXT,
    ended_at INTEGER NOT NULL,
    UNIQUE(room_id, round)
  );
  CREATE INDEX IF NOT EXISTS host_lots_owner_date ON host_lots(account_id, ended_at DESC);
  INSERT OR IGNORE INTO host_profiles (account_id, display_name, updated_at)
  SELECT id, substr(email, 1, 20), created_at FROM accounts;
`);
const hostLotColumns = new Set(database.pragma('table_info(host_lots)').map(({ name }) => name));
if (!hostLotColumns.has('auction_id')) database.exec('ALTER TABLE host_lots ADD COLUMN auction_id TEXT REFERENCES host_auctions(id)');
database.exec(`
  INSERT OR IGNORE INTO host_auctions (id, account_id, room_code, name, created_at)
  SELECT room_id, account_id, MIN(room_code), 'Auction ' || MIN(room_code), MIN(ended_at)
  FROM host_lots GROUP BY room_id, account_id;
  UPDATE host_lots SET auction_id = room_id WHERE auction_id IS NULL;
`);
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_AMOUNT_CENTS = 100000000000000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ROOM_IMAGE_BYTES = 64 * 1024 * 1024;
const START_SECONDS = [30, 20, 15];
const ADD_SECONDS = [10, 7, 5];
const SESSION_COOKIE = 'going_once_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const seedInvite = database.prepare('INSERT OR IGNORE INTO host_access (email, enabled) VALUES (?, 1)');
for (const email of (process.env.HOST_INVITE_EMAILS || '').split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean)) {
  if (!validEmail(email)) throw new Error('HOST_INVITE_EMAILS contains an invalid email address.');
  seedInvite.run(email);
}
const adminEmail = (process.env.SITE_ADMIN_EMAIL || '').trim().toLowerCase();
const adminAccount = adminEmail && database.prepare('SELECT id FROM accounts WHERE email = ?').get(adminEmail);
if (adminEmail && !adminAccount) throw new Error('SITE_ADMIN_EMAIL must refer to an existing registered account.');
const adminAccountId = adminAccount?.id || null;
const findSession = database.prepare(`
  SELECT s.account_id, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id
  LEFT JOIN host_access h ON h.email = a.email
  WHERE s.token_hash = ? AND s.expires_at > ? AND COALESCE(h.enabled, 1) = 1
`);
const findAccountByEmail = database.prepare(`
  SELECT a.id, a.email, a.password_salt, a.password_hash, COALESCE(h.enabled, 1) AS enabled
  FROM accounts a LEFT JOIN host_access h ON h.email = a.email WHERE a.email = ?
`);
const getSettings = database.prepare('SELECT banner, banner_enabled, registration_open, maintenance FROM site_settings WHERE id = 1');
const findAccess = database.prepare('SELECT enabled FROM host_access WHERE email = ?');
const findInvitation = database.prepare('SELECT email FROM host_invitations WHERE email = ? AND token_hash = ? AND expires_at > ?');
const findHostProfile = database.prepare('SELECT display_name, venmo_link, avatar_type FROM host_profiles WHERE account_id = ?');
const findHostAvatar = database.prepare('SELECT avatar_type, avatar_data FROM host_profiles WHERE account_id = ?');
const findHostLots = database.prepare(`
  SELECT a.id AS auction_id, a.name AS auction_name, a.room_code AS auction_room_code,
    l.id, l.room_code, l.round, l.lot_name, l.description, l.image, l.starting_bid,
    l.increment, l.winning_bid, l.winner, l.ended_at
  FROM host_lots l JOIN host_auctions a ON a.id = l.auction_id
  WHERE l.account_id = ? ORDER BY l.ended_at DESC
`);

app.use(express.static('public'));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionToken(cookieHeader) {
  const pair = (cookieHeader || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return pair ? pair.slice(SESSION_COOKIE.length + 1) : '';
}

function currentSession(token) {
  if (!/^[\da-f]{64}$/.test(token)) return null;
  return findSession.get(hashToken(token), Date.now()) || null;
}

function requireHostAccount(request, response, next) {
  const session = currentSession(sessionToken(request.get('cookie')));
  if (!session) return response.sendStatus(401);
  request.accountId = session.account_id;
  next();
}

function requireAdmin(request, response, next) {
  if (!adminAccountId || request.accountId !== adminAccountId) return response.sendStatus(403);
  next();
}

function socketIsAuthenticated(socket) {
  if (!socket.data.accountId || !socket.data.sessionHash) return false;
  return findSession.get(socket.data.sessionHash, Date.now())?.account_id === socket.data.accountId;
}

function sameOrigin(request, response, next) {
  const origin = request.get('origin');
  if (!origin) return response.sendStatus(403);
  try {
    const originUrl = new URL(origin);
    if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.host.toLowerCase() !== request.get('host').toLowerCase()) {
      return response.sendStatus(403);
    }
  } catch {
    return response.sendStatus(403);
  }
  next();
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function setSessionCookie(response, account) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  database.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), account.id, expiresAt);
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  response.set('Cache-Control', 'no-store');
  response.json({ user: { email: account.email } });
}

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function updateHostAccess(email, enabled) {
  const updateAccess = database.transaction(() => {
    database.prepare('INSERT INTO host_access (email, enabled) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET enabled = excluded.enabled')
      .run(email, Number(enabled));
    if (!enabled) {
      database.prepare('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email = ?)').run(email);
      database.prepare('DELETE FROM host_invitations WHERE email = ?').run(email);
      return null;
    }
    if (findAccountByEmail.get(email)) {
      database.prepare('DELETE FROM host_invitations WHERE email = ?').run(email);
      return null;
    }
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + INVITATION_TTL_MS;
    database.prepare(`
      INSERT INTO host_invitations (email, token_hash, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at
    `).run(email, hashToken(code), expiresAt);
    return { code, expiresAt };
  });
  return updateAccess();
}

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});

app.get('/api/auth/session', (request, response) => {
  const session = currentSession(sessionToken(request.get('cookie')));
  const account = session && database.prepare('SELECT email FROM accounts WHERE id = ?').get(session.account_id);
  const user = account ? { email: account.email } : null;
  if (user && session.account_id === adminAccountId) user.isAdmin = true;
  response.set('Cache-Control', 'no-store').json({ user });
});

app.get('/api/site', (request, response) => {
  const settings = getSettings.get();
  response.set('Cache-Control', 'no-store').json({
    banner: settings.banner_enabled ? settings.banner : '',
    maintenance: Boolean(settings.maintenance)
  });
});

app.get('/api/admin', requireHostAccount, requireAdmin, (request, response) => {
  const settings = getSettings.get();
  const users = database.prepare(`
    SELECT email, enabled, registered FROM (
      SELECT h.email, h.enabled, EXISTS(SELECT 1 FROM accounts a WHERE a.email = h.email) AS registered FROM host_access h
      UNION ALL
      SELECT a.email, 1 AS enabled, 1 AS registered FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM host_access h WHERE h.email = a.email)
    ) ORDER BY email
  `).all();
  const stats = {
    accounts: database.prepare('SELECT COUNT(*) AS count FROM accounts').get().count,
    activeRooms: rooms.size,
    connectedPlayers: [...rooms.values()].reduce((total, room) => total + [...room.players.values()].filter((player) => player.connected).length, 0),
    savedLots: database.prepare('SELECT COUNT(*) AS count FROM host_lots').get().count
  };
  response.set('Cache-Control', 'no-store').json({
    banner: settings.banner,
    bannerEnabled: Boolean(settings.banner_enabled),
    registrationOpen: Boolean(settings.registration_open),
    maintenance: Boolean(settings.maintenance),
    users,
    stats
  });
});

app.put('/api/admin/settings', sameOrigin, requireHostAccount, requireAdmin, express.json({ limit: '4kb' }), (request, response) => {
  const { banner, bannerEnabled, registrationOpen, maintenance } = request.body || {};
  if (typeof banner !== 'string' || banner.length > 500 || typeof bannerEnabled !== 'boolean'
    || typeof registrationOpen !== 'boolean' || typeof maintenance !== 'boolean' || (bannerEnabled && !banner.trim())) {
    return response.status(400).json({ error: 'Enter a banner of up to 500 characters and valid settings.' });
  }
  database.prepare('UPDATE site_settings SET banner = ?, banner_enabled = ?, registration_open = ?, maintenance = ? WHERE id = 1')
    .run(banner.trim(), Number(bannerEnabled), Number(registrationOpen), Number(maintenance));
  response.set('Cache-Control', 'no-store').json({ ok: true });
});

app.put('/api/admin/access', sameOrigin, requireHostAccount, requireAdmin, express.json({ limit: '4kb' }), (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const enabled = request.body?.enabled;
  if (!validEmail(email) || typeof enabled !== 'boolean') return response.status(400).json({ error: 'Enter a valid email address.' });
  if (email === adminEmail && !enabled) return response.status(400).json({ error: 'You cannot disable the configured administrator.' });
  const invitation = updateHostAccess(email, enabled);
  if (!enabled) refreshRoomSessions();
  response.set('Cache-Control', 'no-store').json({ ok: true, invitation });
});

app.get('/api/host/profile', requireHostAccount, (request, response) => {
  const profile = findHostProfile.get(request.accountId);
  if (!profile) return response.sendStatus(404);
  response.set('Cache-Control', 'no-store').json({
    displayName: profile.display_name,
    venmoLink: profile.venmo_link,
    hasAvatar: Boolean(profile.avatar_type)
  });
});

app.put('/api/host/profile', sameOrigin, requireHostAccount, express.json({ limit: '4kb' }), (request, response) => {
  const displayName = validName(request.body?.displayName);
  const venmoLink = validVenmoLink(request.body?.venmoLink);
  if (!displayName) return response.status(400).json({ error: 'Enter a display name.' });
  if (venmoLink === null) return response.status(400).json({ error: 'Enter a valid https://venmo.com link.' });
  database.prepare('UPDATE host_profiles SET display_name = ?, venmo_link = ?, updated_at = ? WHERE account_id = ?')
    .run(displayName, venmoLink, Date.now(), request.accountId);
  for (const room of rooms.values()) {
    if (room.hostAccountId !== request.accountId) continue;
    const host = room.players.get(room.hostId);
    if (host) {
      host.name = displayName;
      if (room.leaderId === host.id) room.leaderName = displayName;
    }
    room.venmoLink = venmoLink;
    publish(room);
  }
  response.set('Cache-Control', 'no-store').json({ displayName, venmoLink });
});

app.get('/api/host/profile/avatar', requireHostAccount, (request, response) => {
  const profile = findHostAvatar.get(request.accountId);
  if (!profile?.avatar_type) return response.sendStatus(404);
  response.set({
    'Content-Type': profile.avatar_type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  }).send(profile.avatar_data);
});

app.post('/api/host/profile/avatar', sameOrigin, requireHostAccount, express.raw({ type: 'application/octet-stream', limit: MAX_IMAGE_BYTES }), (request, response) => {
  const type = imageType(request.body);
  if (!type) return response.status(400).json({ error: 'Choose a JPEG, PNG, GIF, or WebP image up to 5 MB.' });
  database.prepare('UPDATE host_profiles SET avatar_type = ?, avatar_data = ?, updated_at = ? WHERE account_id = ?')
    .run(type, request.body, Date.now(), request.accountId);
  refreshRoomAvatars(request.accountId, true);
  response.set('Cache-Control', 'no-store').json({ ok: true });
});

app.delete('/api/host/profile/avatar', sameOrigin, requireHostAccount, (request, response) => {
  database.prepare('UPDATE host_profiles SET avatar_type = NULL, avatar_data = NULL, updated_at = ? WHERE account_id = ?')
    .run(Date.now(), request.accountId);
  refreshRoomAvatars(request.accountId, false);
  response.set('Cache-Control', 'no-store').json({ ok: true });
});

app.get('/api/host/lots', requireHostAccount, (request, response) => {
  const auctions = new Map();
  for (const row of findHostLots.all(request.accountId)) {
    let auction = auctions.get(row.auction_id);
    if (!auction) {
      auction = { id: row.auction_id, name: row.auction_name, roomCode: row.auction_room_code, lots: [] };
      auctions.set(row.auction_id, auction);
    }
    const { auction_id, auction_name, auction_room_code, ...lot } = row;
    auction.lots.push(lot);
  }
  response.set('Cache-Control', 'no-store').json({ auctions: [...auctions.values()] });
});

app.delete('/api/host/auctions/:id', sameOrigin, requireHostAccount, (request, response) => {
  const deleteHistory = database.transaction(() => {
    const deleted = database.prepare('DELETE FROM host_lots WHERE auction_id = ? AND account_id = ?')
      .run(request.params.id, request.accountId);
    if (deleted.changes && ![...rooms.values()].some((room) => room.id === request.params.id)) {
      deleteUnusedAuction(request.params.id);
    }
    return deleted;
  });
  const deleted = deleteHistory();
  if (!deleted.changes) return response.status(404).json({ error: 'Auction history not found.' });
  response.set('Cache-Control', 'no-store').json({ ok: true });
});

function deleteUnusedAuction(id) {
  database.prepare('DELETE FROM host_auctions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM host_lots WHERE auction_id = ?)')
    .run(id, id);
}

app.post('/api/auth/register', sameOrigin, express.json({ limit: '4kb' }), asyncRoute(async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = request.body?.password;
  const invitationCode = typeof request.body?.invitationCode === 'string' ? request.body.invitationCode.trim() : '';
  if (!validEmail(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
  if (!getSettings.get().registration_open) return response.status(403).json({ error: 'Host registration is currently closed.' });
  if (!findAccess.get(email)?.enabled) return response.status(403).json({ error: 'This email address is not on the host invitation list.' });
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
    return response.status(400).json({ error: 'Use a password with at least 12 characters.' });
  }
  if (findAccountByEmail.get(email)) return response.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  const invitationHash = /^[\da-f]{64}$/.test(invitationCode) ? hashToken(invitationCode) : '';
  if (!findInvitation.get(email, invitationHash, Date.now())) {
    return response.status(403).json({ error: 'Enter a valid, unexpired invitation code for this email.' });
  }

  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = (await scrypt(password, salt)).toString('hex');
  const account = { id, email };
  const createdAt = Date.now();
  const insertAccount = database.transaction(() => {
    if (!getSettings.get().registration_open || !findAccess.get(email)?.enabled || !findInvitation.get(email, invitationHash, Date.now())) return null;
    const inserted = database.prepare('INSERT INTO accounts (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
      .run(id, email, salt, passwordHash, createdAt);
    if (!inserted.changes) return false;
    database.prepare('INSERT INTO host_profiles (account_id, display_name, updated_at) VALUES (?, ?, ?)')
      .run(id, email.split('@')[0].slice(0, 20), createdAt);
    database.prepare('DELETE FROM host_invitations WHERE email = ? AND token_hash = ?').run(email, invitationHash);
    return true;
  });
  const inserted = insertAccount();
  if (inserted === null) return response.status(403).json({ error: 'Registration is no longer available for this email.' });
  if (!inserted) return response.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  setSessionCookie(response, account);
}));

app.post('/api/auth/login', sameOrigin, express.json({ limit: '4kb' }), asyncRoute(async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = request.body?.password;
  if (!validEmail(email) || typeof password !== 'string' || Buffer.byteLength(password) > 1024) {
    return response.status(400).json({ error: 'Enter your email and password.' });
  }
  const account = findAccountByEmail.get(email);
  if (!account || !account.enabled) return response.status(401).json({ error: 'Email or password is incorrect.' });
  const passwordHash = await scrypt(password, account.password_salt);
  if (!crypto.timingSafeEqual(passwordHash, Buffer.from(account.password_hash, 'hex'))) {
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (!findAccountByEmail.get(email)?.enabled) return response.status(401).json({ error: 'Email or password is incorrect.' });
  setSessionCookie(response, account);
}));

app.post('/api/auth/logout', sameOrigin, (request, response) => {
  const token = sessionToken(request.get('cookie'));
  if (/^[\da-f]{64}$/.test(token)) {
    database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    refreshRoomSessions();
  }
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
  response.set('Cache-Control', 'no-store').json({ ok: true });
});

app.get('/api/images/:code/:id', (request, response) => {
  const image = rooms.get(request.params.code)?.images.get(request.path);
  if (!image) return response.sendStatus(404);
  response.set({ 'Content-Type': image.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  response.send(image.data);
});

app.get('/api/rooms/:code/players/:id/avatar', (request, response) => {
  const player = rooms.get(request.params.code)?.players.get(request.params.id);
  if (!player?.accountId || !player.avatarVersion) return response.sendStatus(404);
  const avatar = findHostAvatar.get(player.accountId);
  if (!avatar?.avatar_type) return response.sendStatus(404);
  response.set({ 'Content-Type': avatar.avatar_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  response.send(avatar.avatar_data);
});

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    auctionName: room.auctionName,
    hostId: room.hostId,
    venmoLink: room.venmoLink,
    players: [...room.players.values()].map(({ id, name, connected, wins, avatarVersion }) => ({
      id, name, connected, wins,
      avatarUrl: avatarVersion ? `/api/rooms/${room.code}/players/${id}/avatar?v=${avatarVersion}` : null
    })),
    phase: room.phase,
    lot: room.lot,
    bid: room.bid,
    leaderId: room.leaderId,
    leaderName: room.leaderName,
    endsAt: room.endsAt,
    history: room.history,
    round: room.round
  };
}

function publish(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
}

function refreshRoomAvatars(accountId, hasAvatar) {
  for (const room of rooms.values()) {
    let changed = false;
    for (const player of room.players.values()) {
      if (player.accountId !== accountId) continue;
      player.avatarVersion = hasAvatar ? crypto.randomUUID() : null;
      changed = true;
    }
    if (changed) publish(room);
  }
}

function refreshRoomSessions() {
  for (const room of rooms.values()) {
    let changed = false;
    for (const player of room.players.values()) {
      if (!player.sessionHash || findSession.get(player.sessionHash, Date.now())?.account_id === player.accountId) continue;
      player.accountId = null;
      player.sessionHash = null;
      player.avatarVersion = null;
      changed = true;
    }
    if (changed) publish(room);
  }
}

function setRoundTimer(room, seconds) {
  clearTimeout(room.timer);
  room.endsAt = Date.now() + seconds * 1000;
  room.timer = setTimeout(() => finishRound(room), seconds * 1000);
}

function finishRound(room) {
  if (room.phase !== 'live') return;
  clearTimeout(room.timer);
  const winner = room.players.get(room.leaderId);
  if (winner) {
    winner.wins += 1;
  }
  room.phase = 'result';
  room.endsAt = null;
  const endedAt = Date.now();
  const result = { lot: room.lot, amount: room.leaderName ? room.bid : 0, winner: room.leaderName };
  room.history.unshift(result);
  if (room.roundHostAccountId) {
    database.prepare(`
      INSERT INTO host_lots (id, account_id, room_id, auction_id, room_code, round, lot_name, description, image, starting_bid, increment, winning_bid, winner, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), room.roundHostAccountId, room.id, room.id, room.code, room.round,
      room.lot.name, room.lot.description, room.lot.image, room.lot.startingBid,
      room.lot.increment, result.amount, result.winner, endedAt
    );
  }
  publish(room);
}

function validName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 20) : '';
}

function validAuctionName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 60) : '';
}

function validVenmoLink(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048) return null;
  value = value.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['venmo.com', 'www.venmo.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    return url.href;
  } catch {
    return null;
  }
}

function imageType(data) {
  if (!Buffer.isBuffer(data)) return null;
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function dollarsToCents(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

io.use((socket, next) => {
  const session = currentSession(sessionToken(socket.handshake.headers.cookie));
  if (session) {
    socket.data.accountId = session.account_id;
    socket.data.sessionHash = hashToken(sessionToken(socket.handshake.headers.cookie));
  }
  next();
});

io.on('connection', (socket) => {
  function getRoom() {
    return rooms.get(socket.data.code);
  }

  function respond(callback, error, extra = {}) {
    if (typeof callback === 'function') callback(error ? { error } : { ok: true, ...extra });
  }

  function attach(room, player) {
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    const accountId = socketIsAuthenticated(socket) ? socket.data.accountId : null;
    if (player.accountId !== accountId) {
      player.accountId = accountId;
      player.avatarVersion = accountId && findHostProfile.get(accountId)?.avatar_type ? crypto.randomUUID() : null;
    }
    player.sessionHash = accountId ? socket.data.sessionHash : null;
    player.connected = true;
    player.socketId = socket.id;
    socket.join(room.code);
    publish(room);
  }

  socket.on('room:create', ({ auctionName } = {}, callback) => {
    if (!socketIsAuthenticated(socket)) return respond(callback, 'Sign in with an invited host account to create a room.');
    if (getSettings.get().maintenance && socket.data.accountId !== adminAccountId) return respond(callback, 'New rooms are temporarily unavailable during maintenance.');
    const profile = findHostProfile.get(socket.data.accountId);
    if (!profile?.display_name) return respond(callback, 'Set your host display name in preferences first.');
    const name = validName(profile.display_name);
    if (!name) return respond(callback, 'Enter your name to create a room.');
    if (socket.data.code) return respond(callback, 'Leave your current room first.');
    auctionName = validAuctionName(auctionName);
    if (!auctionName) return respond(callback, 'Enter an auction name.');
    const id = crypto.randomUUID();
    const room = { id: crypto.randomUUID(), code: makeCode(), auctionName, hostId: id, hostAccountId: socket.data.accountId, roundHostAccountId: null, venmoLink: profile.venmo_link, players: new Map(), images: new Map(), phase: 'lobby', lot: null, bid: 0, leaderId: null, leaderName: null, endsAt: null, history: [], round: 0 };
    database.prepare('INSERT INTO host_auctions (id, account_id, room_code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(room.id, room.hostAccountId, room.code, auctionName, Date.now());
    const player = { id, name, connected: true, wins: 0, rejoinToken: crypto.randomBytes(32).toString('hex') };
    room.players.set(id, player);
    rooms.set(room.code, room);
    attach(room, player);
    respond(callback, null, { code: room.code, playerId: id, rejoinToken: player.rejoinToken });
  });

  socket.on('room:join', ({ name, code, playerId, rejoinToken } = {}, callback) => {
    code = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) return respond(callback, 'Room not found. Check the code and try again.');
    if (socket.data.code) return respond(callback, 'Leave your current room first.');
    const existing = typeof playerId === 'string' && room.players.get(playerId);
    const validReconnect = existing && typeof rejoinToken === 'string' && existing.rejoinToken === rejoinToken;
    if (getSettings.get().maintenance && !validReconnect && !(socket.data.accountId === adminAccountId && socketIsAuthenticated(socket))) {
      return respond(callback, 'Joining rooms is temporarily unavailable during maintenance.');
    }
    if (existing) {
      if (!validReconnect) return respond(callback, 'Unable to reconnect to this room.');
      if (existing.id === room.hostId && (socket.data.accountId !== room.hostAccountId || !socketIsAuthenticated(socket))) return respond(callback, 'Sign in with the host account to reconnect to this room.');
      if (existing.socketId && existing.socketId !== socket.id) io.sockets.sockets.get(existing.socketId)?.disconnect(true);
      attach(room, existing);
      return respond(callback, null, { code, playerId: existing.id, rejoinToken: existing.rejoinToken });
    }
    name = validName(name);
    if (!name) return respond(callback, 'Enter your name to join.');
    if (room.players.size >= 20) return respond(callback, 'This room is full.');
    if ([...room.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase())) return respond(callback, 'That name is already in this room.');
    const player = { id: crypto.randomUUID(), name, connected: true, wins: 0, rejoinToken: crypto.randomBytes(32).toString('hex') };
    room.players.set(player.id, player);
    attach(room, player);
    respond(callback, null, { code, playerId: player.id, rejoinToken: player.rejoinToken });
  });

  socket.on('image:upload', ({ data } = {}, callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId || room.hostAccountId !== socket.data.accountId || !socketIsAuthenticated(socket)) return respond(callback, 'Only the signed-in host can upload an image.');
    if (room.phase === 'live') return respond(callback, 'Wait until the current auction ends to upload an image.');
    if (!Buffer.isBuffer(data) || data.length > MAX_IMAGE_BYTES) return respond(callback, 'Choose an image no larger than 5 MB.');
    const type = imageType(data);
    if (!type) return respond(callback, 'Choose a JPEG, PNG, GIF, or WebP image.');
    const usedImages = new Set([room.lot?.image, ...room.history.map((entry) => entry.lot.image)]);
    for (const url of room.images.keys()) {
      if (!usedImages.has(url)) room.images.delete(url);
    }
    const usedBytes = [...room.images.values()].reduce((total, image) => total + image.data.length, 0);
    if (usedBytes + data.length > MAX_ROOM_IMAGE_BYTES) return respond(callback, 'This room has reached its image storage limit.');
    const url = `/api/images/${room.code}/${crypto.randomUUID()}`;
    room.images.set(url, { data, type });
    respond(callback, null, { url });
  });

  socket.on('round:prepare', ({ name, description, image, startingBid = 1, increment = 1, autoEnd = true, startSeconds = 30, addSeconds = 10 } = {}, callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId || room.hostAccountId !== socket.data.accountId || !socketIsAuthenticated(socket)) return respond(callback, 'Only the signed-in host can prepare an auction.');
    if (room.phase === 'live') return respond(callback, 'The current auction is still live.');
    name = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    description = typeof description === 'string' ? description.trim().slice(0, 160) : '';
    image = typeof image === 'string' ? image.trim().slice(0, 1000) : '';
    const startingCents = dollarsToCents(startingBid);
    const incrementCents = dollarsToCents(increment);
    if (!name) return respond(callback, 'Give the item a name.');
    if (startingCents === null || startingCents < 1 || startingCents > MAX_AMOUNT_CENTS) return respond(callback, 'Starting bid must be between $0.01 and $1 trillion, with at most two decimal places.');
    if (incrementCents === null || incrementCents < 1 || incrementCents > MAX_AMOUNT_CENTS) return respond(callback, 'Bid increment must be between $0.01 and $1 trillion, with at most two decimal places.');
    if (image && !/^https?:\/\//i.test(image) && !room.images.has(image)) return respond(callback, 'Use an uploaded image or a URL starting with http:// or https://.');
    if (typeof autoEnd !== 'boolean') return respond(callback, 'Choose a valid auction ending option.');
    if (!START_SECONDS.includes(startSeconds)) return respond(callback, 'Choose a start time of 30, 20, or 15 seconds.');
    if (!ADD_SECONDS.includes(addSeconds)) return respond(callback, 'Choose a bid time add of 10, 7, or 5 seconds.');
    room.lot = { name, description, image, startingBid: startingCents / 100, increment: incrementCents / 100, autoEnd, startSeconds, addSeconds };
    room.bid = room.lot.startingBid;
    room.leaderId = null;
    room.leaderName = null;
    room.phase = 'ready';
    room.endsAt = null;
    publish(room);
    respond(callback);
  });

  socket.on('round:start', (callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId || room.hostAccountId !== socket.data.accountId || !socketIsAuthenticated(socket)) return respond(callback, 'Only the signed-in host can start an auction.');
    if (room.phase !== 'ready') return respond(callback, 'Prepare an item before starting the auction.');
    room.round += 1;
    room.roundHostAccountId = room.hostAccountId;
    room.phase = 'live';
    if (room.lot.autoEnd) setRoundTimer(room, room.lot.startSeconds);
    publish(room);
    respond(callback);
  });

  socket.on('round:end', (callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId || room.hostAccountId !== socket.data.accountId || !socketIsAuthenticated(socket)) return respond(callback, 'Only the signed-in host can end an auction.');
    if (room.phase !== 'live') return respond(callback, 'There is no live auction to end.');
    finishRound(room);
    respond(callback);
  });

  socket.on('bid:place', ({ amount } = {}, callback) => {
    const room = getRoom();
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || room.phase !== 'live' || (room.endsAt !== null && Date.now() >= room.endsAt)) return respond(callback, 'This auction is not accepting bids.');
    if (player.id === room.leaderId) return respond(callback, 'You already have the leading bid.');
    const amountCents = dollarsToCents(amount);
    const startingCents = dollarsToCents(room.lot.startingBid);
    const incrementCents = dollarsToCents(room.lot.increment);
    const minimumCents = dollarsToCents(room.bid) + (room.leaderId ? incrementCents : 0);
    if (amountCents === null || amountCents < minimumCents) return respond(callback, `Bid at least $${(minimumCents / 100).toFixed(2)}, with at most two decimal places.`);
    if (amountCents > MAX_AMOUNT_CENTS) return respond(callback, 'The maximum supported bid is $1 trillion.');
    if ((amountCents - startingCents) % incrementCents !== 0) return respond(callback, `Bids must increase in steps of $${room.lot.increment.toFixed(2)}.`);
    room.bid = amountCents / 100;
    room.leaderId = player.id;
    room.leaderName = player.name;
    // A bid only tops the clock back up to the add time; it never extends beyond it.
    if (room.lot.autoEnd && room.endsAt - Date.now() < room.lot.addSeconds * 1000) setRoundTimer(room, room.lot.addSeconds);
    publish(room);
    respond(callback);
  });

  socket.on('room:leave', (callback) => {
    const room = getRoom();
    const playerId = socket.data.playerId;
    if (!room || !room.players.has(playerId)) return respond(callback, 'You are not in a room.');
    let nextHost = null;
    if (room.hostId === playerId && room.players.size > 1) {
      nextHost = [...room.players.values()].find((candidate) => {
        if (candidate.id === playerId || !candidate.connected) return false;
        const candidateSocket = io.sockets.sockets.get(candidate.socketId);
        return candidateSocket && socketIsAuthenticated(candidateSocket);
      });
      if (!nextHost) {
        clearTimeout(room.timer);
        rooms.delete(room.code);
        deleteUnusedAuction(room.id);
        io.to(room.code).emit('room:closed');
        for (const candidate of room.players.values()) {
          const candidateSocket = io.sockets.sockets.get(candidate.socketId);
          if (!candidateSocket) continue;
          candidateSocket.leave(room.code);
          delete candidateSocket.data.code;
          delete candidateSocket.data.playerId;
        }
        return respond(callback);
      }
    }
    room.players.delete(playerId);
    socket.leave(room.code);
    delete socket.data.code;
    delete socket.data.playerId;
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      deleteUnusedAuction(room.id);
    } else {
      if (nextHost) {
        room.hostId = nextHost.id;
        room.hostAccountId = io.sockets.sockets.get(nextHost.socketId).data.accountId;
        const nextProfile = findHostProfile.get(room.hostAccountId);
        if (nextProfile) {
          nextHost.name = nextProfile.display_name;
          room.venmoLink = nextProfile.venmo_link;
          if (room.leaderId === nextHost.id) room.leaderName = nextProfile.display_name;
        }
      }
      publish(room);
    }
    respond(callback);
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    const player = room?.players.get(socket.data.playerId);
    if (!player || player.socketId !== socket.id) return;
    player.connected = false;
    publish(room);
  });
});

if (require.main === module) server.listen(process.env.PORT || 3000, () => console.log(`Going Once listening on http://localhost:${process.env.PORT || 3000}`));

module.exports = { app, server, io, rooms, database, updateHostAccess, validEmail };