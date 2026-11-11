const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
process.env.HOST_INVITE_EMAILS = 'host@example.com,takeover@example.com';
process.env.DATABASE_PATH = ':memory:';
delete process.env.SITE_ADMIN_EMAIL;
const { server, io, rooms, database, updateHostAccess } = require('../server');
const invitationCodes = new Map([
  ['host@example.com', updateHostAccess('host@example.com', true).code],
  ['takeover@example.com', updateHostAccess('takeover@example.com', true).code]
]);

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function register(url, email) {
  const response = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ email, password: 'a-sufficiently-long-password', invitationCode: invitationCodes.get(email) })
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function updateProfile(url, cookie, profile) {
  return fetch(`${url}/api/host/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
    body: JSON.stringify(profile)
  });
}

async function prepareAndStart(socket, lot) {
  const prepared = await emit(socket, 'round:prepare', lot);
  if (prepared.error) return prepared;
  return new Promise((resolve) => socket.emit('round:start', resolve));
}

test('players can join, bid, settle a round, and transfer hosting', async (context) => {
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  const refused = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ email: 'not-invited@example.com', password: 'a-sufficiently-long-password' })
  });
  assert.equal(refused.status, 403);
  const tooShort = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ email: 'host@example.com', password: 'short' })
  });
  assert.equal(tooShort.status, 400);
  const hostAccount = await register(url, 'host@example.com');
  assert.equal(hostAccount.response.status, 200);
  assert.ok(hostAccount.cookie);
  const duplicate = await register(url, 'host@example.com');
  assert.equal(duplicate.response.status, 409);
  const wrongPassword = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ email: 'host@example.com', password: 'incorrect-password' })
  });
  assert.equal(wrongPassword.status, 401);
  const session = await fetch(`${url}/api/auth/session`, { headers: { Cookie: hostAccount.cookie } });
  assert.deepEqual(await session.json(), { user: { email: 'host@example.com' } });
  const anonymousProfile = await fetch(`${url}/api/host/profile`);
  assert.equal(anonymousProfile.status, 401);
  assert.equal((await updateProfile(url, hostAccount.cookie, { displayName: 'Host', venmoLink: 'https://venmo.com.evil.example/u/host' })).status, 400);
  assert.equal((await updateProfile(url, hostAccount.cookie, { displayName: 'Host', venmoLink: 'http://venmo.com/u/host' })).status, 400);
  const savedProfile = await updateProfile(url, hostAccount.cookie, { displayName: 'Host', venmoLink: 'https://venmo.com/u/host' });
  assert.equal(savedProfile.status, 200);
  assert.deepEqual(await savedProfile.json(), { displayName: 'Host', venmoLink: 'https://venmo.com/u/host' });
  const takeoverAccount = await register(url, 'takeover@example.com');
  const hostAccountId = database.prepare('SELECT id FROM accounts WHERE email = ?').get('host@example.com').id;
  const takeoverAccountId = database.prepare('SELECT id FROM accounts WHERE email = ?').get('takeover@example.com').id;

  const host = connect(url, { extraHeaders: { Cookie: hostAccount.cookie } });
  const guest = connect(url);
  const takeover = connect(url, { extraHeaders: { Cookie: takeoverAccount.cookie } });
  context.after(() => {
    host.disconnect();
    guest.disconnect();
    takeover.disconnect();
    for (const room of rooms.values()) clearTimeout(room.timer);
    rooms.clear();
    io.close();
    database.close();
  });
  await Promise.all([host, guest, takeover].map((socket) => new Promise((resolve) => socket.on('connect', resolve))));

  assert.match((await emit(guest, 'room:create', { auctionName: 'Unauthorized' })).error, /sign in/i);
  assert.match((await emit(host, 'room:create', {})).error, /auction name/i);
  const created = await emit(host, 'room:create', { auctionName: 'Summer Sale' });
  assert.equal(created.code.length, 5);
  const room = rooms.get(created.code);
  assert.equal(room.auctionName, 'Summer Sale');
  assert.equal(room.venmoLink, 'https://venmo.com/u/host');
  assert.equal(room.players.get(created.playerId).name, 'Host');
  assert.equal(room.phase, 'lobby');
  assert.equal('balance' in room.players.get(created.playerId), false);
  assert.equal(room.endsAt, null);
  assert.equal((await emit(host, 'round:prepare', { name: 'Default lot' })).ok, true);
  assert.equal(room.lot.startingBid, 1);
  assert.equal(room.lot.increment, 1);
  assert.equal((await emit(host, 'round:prepare', { name: 'Chair', startingBid: 50, increment: 10 })).ok, true);
  assert.equal(room.phase, 'ready');
  assert.equal(room.endsAt, null);
  assert.match((await emit(guest, 'room:join', { name: 'Guest', code: 'WRONG' })).error, /not found/i);
  const guestUpdate = new Promise((resolve) => guest.once('room:update', resolve));
  let joined = await emit(guest, 'room:join', { name: 'Guest', code: created.code.toLowerCase() });
  assert.ok(joined.playerId);
  const joinedRoom = await guestUpdate;
  assert.equal(joinedRoom.venmoLink, 'https://venmo.com/u/host');
  assert.equal(joinedRoom.auctionName, 'Summer Sale');
  assert.match((await emit(guest, 'round:prepare', { name: 'Intrusion', startingBid: 1 })).error, /signed-in host/i);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
  const invalidAvatar = await fetch(`${url}/api/host/profile/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: url, Cookie: hostAccount.cookie },
    body: Buffer.from('not an image')
  });
  assert.equal(invalidAvatar.status, 400);
  const uploadedAvatar = await fetch(`${url}/api/host/profile/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Origin: url, Cookie: hostAccount.cookie },
    body: png
  });
  assert.equal(uploadedAvatar.status, 200);
  const avatarResponse = await fetch(`${url}/api/host/profile/avatar`, { headers: { Cookie: hostAccount.cookie } });
  assert.equal(avatarResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await avatarResponse.arrayBuffer()), png);
  const emptyHistory = await fetch(`${url}/api/host/lots`, { headers: { Cookie: hostAccount.cookie } });
  assert.equal(emptyHistory.status, 200);
  assert.deepEqual(await emptyHistory.json(), { auctions: [] });
  assert.match((await emit(guest, 'image:upload', { data: png })).error, /host/i);
  assert.match((await emit(host, 'image:upload', { data: Buffer.from('not an image') })).error, /JPEG/i);
  assert.match((await emit(host, 'image:upload', { data: Buffer.alloc(5 * 1024 * 1024 + 1) })).error, /5 MB/i);
  const uploaded = await emit(host, 'image:upload', { data: png });
  assert.ok(uploaded.url.startsWith(`/api/images/${created.code}/`));
  const imageResponse = await fetch(url + uploaded.url);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.equal((await fetch(url + uploaded.url.replace(created.code, 'WRONG'))).status, 404);
  assert.equal((await emit(host, 'round:prepare', { name: 'Chair', startingBid: 50, increment: 10, image: uploaded.url })).ok, true);
  assert.equal(room.lot.image, uploaded.url);
  assert.equal(room.phase, 'ready');
  assert.match((await emit(guest, 'bid:place', { amount: 50 })).error, /not accepting/i);
  assert.match((await new Promise((resolve) => guest.emit('round:start', resolve))).error, /host/i);
  assert.equal((await new Promise((resolve) => host.emit('round:start', resolve))).ok, true);
  assert.equal(room.phase, 'live');
  assert.ok(room.endsAt > Date.now());
  room.endsAt = Date.now() + 1000;
  assert.equal((await emit(guest, 'bid:place', { amount: 50 })).ok, true);
  assert.ok(room.endsAt > Date.now() + 8000);
  const deadline = room.endsAt;
  assert.match((await emit(host, 'bid:place', { amount: 55 })).error, /at least \$60/i);
  assert.equal(room.endsAt, deadline);
  assert.equal((await emit(host, 'bid:place', { amount: 1010 })).ok, true);
  assert.match((await new Promise((resolve) => guest.emit('round:end', resolve))).error, /host/i);

  room.timer._onTimeout();
  assert.equal(room.phase, 'result');
  assert.equal(room.history[0].amount, 1010);
  assert.equal(room.history[0].winner, 'Host');
  assert.match((await emit(guest, 'bid:place', { amount: 70 })).error, /not accepting/i);

  assert.match((await emit(host, 'round:prepare', { name: 'Timer', startingBid: 10, startSeconds: 25 })).error, /start time/i);
  assert.match((await emit(host, 'round:prepare', { name: 'Timer', startingBid: 10, addSeconds: 3 })).error, /bid time/i);
  assert.equal((await prepareAndStart(host, { name: 'Timer', startingBid: 10, startSeconds: 15, addSeconds: 7 })).ok, true);
  assert.ok(room.endsAt > Date.now() + 14000 && room.endsAt <= Date.now() + 15000);
  room.endsAt = Date.now() + 8000;
  const unchanged = room.endsAt;
  assert.equal((await emit(guest, 'bid:place', { amount: 10 })).ok, true);
  assert.equal(room.endsAt, unchanged);
  room.endsAt = Date.now() + 6000;
  assert.equal((await emit(host, 'bid:place', { amount: 20 })).ok, true);
  assert.ok(room.endsAt > Date.now() + 6500 && room.endsAt <= Date.now() + 7000);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);

  assert.match((await emit(host, 'round:prepare', { name: 'Clock', startingBid: 10, increment: 0 })).error, /increment/i);
  assert.match((await emit(host, 'round:prepare', { name: 'Clock', startingBid: 10, increment: 0.001 })).error, /increment/i);
  assert.equal((await prepareAndStart(host, { name: 'Clock', startingBid: 10, increment: 0.1, autoEnd: false })).ok, true);
  assert.equal(room.endsAt, null);
  assert.equal((await emit(guest, 'bid:place', { amount: 10 })).ok, true);
  assert.match((await emit(host, 'bid:place', { amount: 10.15 })).error, /steps/i);
  assert.equal((await emit(host, 'bid:place', { amount: 10.1 })).ok, true);
  assert.equal((await emit(guest, 'bid:place', { amount: 10.2 })).ok, true);
  assert.equal(room.endsAt, null);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  assert.equal(room.phase, 'result');
  assert.equal(room.history[0].amount, 10.2);
  assert.equal(room.history[0].winner, 'Guest');
  assert.match((await new Promise((resolve) => host.emit('round:end', resolve))).error, /no live auction/i);

  assert.equal((await prepareAndStart(host, { name: 'Test', startingBid: 10, increment: 1, autoEnd: false })).ok, true);
  assert.equal((await emit(guest, 'bid:place', { amount: 10 })).ok, true);
  assert.equal((await emit(host, 'bid:place', { amount: 11 })).ok, true);
  assert.equal(room.bid, 11);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);

  assert.equal((await prepareAndStart(host, { name: 'Large lot', startingBid: 5000, increment: 1001, autoEnd: false })).ok, true);
  assert.equal((await emit(guest, 'bid:place', { amount: 5000 })).ok, true);
  assert.equal((await emit(host, 'bid:place', { amount: 6001 })).ok, true);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  assert.equal(room.history[0].amount, 6001);

  assert.equal((await prepareAndStart(host, { name: 'Standing bid', startingBid: 10, increment: 1, autoEnd: false })).ok, true);
  assert.equal((await emit(guest, 'bid:place', { amount: 15 })).ok, true);
  assert.equal((await new Promise((resolve) => guest.emit('room:leave', resolve))).ok, true);
  assert.equal(room.bid, 15);
  assert.equal(room.leaderName, 'Guest');
  assert.equal(room.leaderId, joined.playerId);
  assert.match((await emit(host, 'bid:place', { amount: 15 })).error, /at least \$16/i);
  assert.equal((await emit(host, 'bid:place', { amount: 16 })).ok, true);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  assert.equal(room.history[0].winner, 'Host');

  joined = await emit(guest, 'room:join', { name: 'Guest', code: created.code });
  const takeoverJoined = await emit(takeover, 'room:join', { name: 'Backup host', code: created.code });
  assert.equal((await prepareAndStart(host, { name: 'Unchallenged bid', startingBid: 10, increment: 1, autoEnd: false })).ok, true);
  assert.equal((await emit(guest, 'bid:place', { amount: 15 })).ok, true);
  assert.equal((await new Promise((resolve) => guest.emit('room:leave', resolve))).ok, true);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  assert.equal(room.history[0].amount, 15);
  assert.equal(room.history[0].winner, 'Guest');

  joined = await emit(guest, 'room:join', { name: 'Guest', code: created.code });
  for (let i = 1; i <= 5; i += 1) {
    assert.equal((await prepareAndStart(host, { name: `Extra ${i}`, startingBid: 10, autoEnd: false })).ok, true);
    assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  }
  assert.equal(room.history.length, 12);
  assert.equal(room.history.at(-1).lot.name, 'Chair');
  const changedProfile = await updateProfile(url, hostAccount.cookie, { displayName: 'Host Final', venmoLink: 'https://venmo.com/u/hostfinal' });
  assert.equal(changedProfile.status, 200);
  assert.equal(room.players.get(created.playerId).name, 'Host Final');
  assert.equal(room.venmoLink, 'https://venmo.com/u/hostfinal');
  const left = await new Promise((resolve) => host.emit('room:leave', resolve));
  assert.equal(left.ok, true);
  assert.equal(room.hostId, takeoverJoined.playerId);
  assert.equal(room.players.get(takeoverJoined.playerId).name, 'takeover');
  assert.equal((await prepareAndStart(takeover, { name: 'Lamp', startingBid: 10 })).ok, true);
  assert.equal((await new Promise((resolve) => takeover.emit('round:end', resolve))).ok, true);
  const savedHostLots = database.prepare('SELECT * FROM host_lots WHERE account_id = ? ORDER BY ended_at').all(hostAccountId);
  assert.ok(savedHostLots.some((lot) => lot.lot_name === 'Chair' && lot.winner === 'Host'));
  const historyResponse = await fetch(`${url}/api/host/lots`, { headers: { Cookie: hostAccount.cookie } });
  const history = await historyResponse.json();
  const summerSale = history.auctions.find((auction) => auction.name === 'Summer Sale');
  assert.ok(summerSale?.lots.some((lot) => lot.lot_name === 'Chair'));
  const savedTakeoverLots = database.prepare('SELECT * FROM host_lots WHERE account_id = ?').all(takeoverAccountId);
  assert.ok(savedTakeoverLots.some((lot) => lot.lot_name === 'Lamp' && lot.winner === null));

  assert.equal((await new Promise((resolve) => guest.emit('room:leave', resolve))).ok, true);
  const guestClosed = new Promise((resolve) => guest.once('room:closed', resolve));
  const abandoned = await emit(host, 'room:create', { auctionName: 'Closing Auction' });
  assert.ok(abandoned.code);
  assert.equal((await prepareAndStart(host, { name: 'Other lot', startingBid: 10, autoEnd: false })).ok, true);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  const secondRoom = rooms.get(abandoned.code);
  const deleteHistory = (auctionId, cookie, origin = url) => fetch(`${url}/api/host/auctions/${auctionId}`, {
    method: 'DELETE',
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }
  });
  assert.equal((await deleteHistory(secondRoom.id)).status, 401);
  assert.equal((await deleteHistory(secondRoom.id, takeoverAccount.cookie)).status, 404);
  assert.equal((await deleteHistory(secondRoom.id, hostAccount.cookie, 'https://other.example')).status, 403);
  assert.equal((await deleteHistory(summerSale.id, hostAccount.cookie)).status, 200);
  assert.equal((await deleteHistory(summerSale.id, hostAccount.cookie)).status, 404);
  const remainingHostHistory = await (await fetch(`${url}/api/host/lots`, { headers: { Cookie: hostAccount.cookie } })).json();
  assert.deepEqual(remainingHostHistory.auctions.map((auction) => auction.name), ['Closing Auction']);
  const remainingTakeoverHistory = await (await fetch(`${url}/api/host/lots`, { headers: { Cookie: takeoverAccount.cookie } })).json();
  assert.ok(remainingTakeoverHistory.auctions.some((auction) => auction.id === summerSale.id && auction.lots.some((lot) => lot.lot_name === 'Lamp')));
  assert.equal(room.history.length, 13);
  assert.equal((await prepareAndStart(takeover, { name: 'After deletion', startingBid: 10, autoEnd: false })).ok, true);
  assert.equal((await new Promise((resolve) => takeover.emit('round:end', resolve))).ok, true);
  assert.equal((await emit(guest, 'room:join', { name: 'Guest', code: abandoned.code })).ok, true);
  assert.equal((await new Promise((resolve) => host.emit('room:leave', resolve))).ok, true);
  await guestClosed;
  assert.equal(rooms.has(abandoned.code), false);
  assert.equal((await deleteHistory(secondRoom.id, hostAccount.cookie)).status, 200);
  assert.equal(database.prepare('SELECT id FROM host_auctions WHERE id = ?').get(secondRoom.id), undefined);
});