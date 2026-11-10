const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io, rooms } = require('../server');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function prepareAndStart(socket, lot) {
  const prepared = await emit(socket, 'round:prepare', lot);
  if (prepared.error) return prepared;
  return new Promise((resolve) => socket.emit('round:start', resolve));
}

test('players can join, bid, settle a round, and transfer hosting', async (context) => {
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  const host = connect(url);
  const guest = connect(url);
  context.after(() => {
    host.disconnect();
    guest.disconnect();
    for (const room of rooms.values()) clearTimeout(room.timer);
    rooms.clear();
    io.close();
  });
  await Promise.all([host, guest].map((socket) => new Promise((resolve) => socket.on('connect', resolve))));

  const created = await emit(host, 'room:create', { name: 'Host' });
  assert.equal(created.code.length, 5);
  const room = rooms.get(created.code);
  assert.equal(room.phase, 'lobby');
  assert.equal('balance' in room.players.get(created.playerId), false);
  assert.equal(room.endsAt, null);
  assert.equal((await emit(host, 'round:prepare', { name: 'Chair', startingBid: 50 })).ok, true);
  assert.equal(room.phase, 'ready');
  assert.equal(room.endsAt, null);
  assert.match((await emit(guest, 'room:join', { name: 'Guest', code: 'WRONG' })).error, /not found/i);
  let joined = await emit(guest, 'room:join', { name: 'Guest', code: created.code.toLowerCase() });
  assert.ok(joined.playerId);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
  assert.match((await emit(guest, 'image:upload', { data: png })).error, /host/i);
  assert.match((await emit(host, 'image:upload', { data: Buffer.from('not an image') })).error, /JPEG/i);
  assert.match((await emit(host, 'image:upload', { data: Buffer.alloc(5 * 1024 * 1024 + 1) })).error, /5 MB/i);
  const uploaded = await emit(host, 'image:upload', { data: png });
  assert.ok(uploaded.url.startsWith(`/api/images/${created.code}/`));
  const imageResponse = await fetch(url + uploaded.url);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.equal((await fetch(url + uploaded.url.replace(created.code, 'WRONG'))).status, 404);
  assert.equal((await emit(host, 'round:prepare', { name: 'Chair', startingBid: 50, image: uploaded.url })).ok, true);
  assert.equal(room.lot.image, uploaded.url);
  assert.equal(room.phase, 'ready');
  assert.match((await emit(guest, 'bid:place', { amount: 50 })).error, /not accepting/i);
  assert.match((await new Promise((resolve) => guest.emit('round:start', resolve))).error, /host/i);
  assert.equal((await new Promise((resolve) => host.emit('round:start', resolve))).ok, true);
  assert.equal(room.phase, 'live');
  assert.ok(room.endsAt > Date.now());
  room.endsAt = Date.now() + 1000;
  assert.equal((await emit(guest, 'bid:place', { amount: 50 })).ok, true);
  assert.ok(room.endsAt > Date.now() + 28000);
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
  assert.equal((await prepareAndStart(host, { name: 'Unchallenged bid', startingBid: 10, increment: 1, autoEnd: false })).ok, true);
  assert.equal((await emit(guest, 'bid:place', { amount: 15 })).ok, true);
  assert.equal((await new Promise((resolve) => guest.emit('room:leave', resolve))).ok, true);
  assert.equal((await new Promise((resolve) => host.emit('round:end', resolve))).ok, true);
  assert.equal(room.history[0].amount, 15);
  assert.equal(room.history[0].winner, 'Guest');

  joined = await emit(guest, 'room:join', { name: 'Guest', code: created.code });
  const left = await new Promise((resolve) => host.emit('room:leave', resolve));
  assert.equal(left.ok, true);
  assert.equal(room.hostId, joined.playerId);
  assert.equal((await prepareAndStart(guest, { name: 'Lamp', startingBid: 10 })).ok, true);
});