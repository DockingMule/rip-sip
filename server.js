const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8 * 1024 * 1024 });
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_AMOUNT_CENTS = 100000000000000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ROOM_IMAGE_BYTES = 64 * 1024 * 1024;
const ROUND_SECONDS = 30;

app.use(express.static('public'));

app.get('/api/images/:code/:id', (request, response) => {
  const image = rooms.get(request.params.code)?.images.get(request.path);
  if (!image) return response.sendStatus(404);
  response.set({ 'Content-Type': image.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  response.send(image.data);
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
    hostId: room.hostId,
    venmoLink: room.venmoLink,
    players: [...room.players.values()].map(({ id, name, connected, wins }) => ({ id, name, connected, wins })),
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

function resetRoundTimer(room) {
  clearTimeout(room.timer);
  room.endsAt = Date.now() + ROUND_SECONDS * 1000;
  room.timer = setTimeout(() => finishRound(room), ROUND_SECONDS * 1000);
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
  room.history.unshift({ lot: room.lot, amount: room.leaderName ? room.bid : 0, winner: room.leaderName });
  room.history = room.history.slice(0, 10);
  publish(room);
}

function validName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 20) : '';
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
    player.connected = true;
    player.socketId = socket.id;
    socket.join(room.code);
    publish(room);
  }

  socket.on('room:create', ({ name, venmoLink } = {}, callback) => {
    name = validName(name);
    if (!name) return respond(callback, 'Enter your name to create a room.');
    if (socket.data.code) return respond(callback, 'Leave your current room first.');
    venmoLink = validVenmoLink(venmoLink);
    if (venmoLink === null) return respond(callback, 'Enter a valid https://venmo.com link.');
    const id = crypto.randomUUID();
    const room = { code: makeCode(), hostId: id, venmoLink, players: new Map(), images: new Map(), phase: 'lobby', lot: null, bid: 0, leaderId: null, leaderName: null, endsAt: null, history: [], round: 0 };
    const player = { id, name, connected: true, wins: 0 };
    room.players.set(id, player);
    rooms.set(room.code, room);
    attach(room, player);
    respond(callback, null, { code: room.code, playerId: id });
  });

  socket.on('room:join', ({ name, code, playerId } = {}, callback) => {
    code = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) return respond(callback, 'Room not found. Check the code and try again.');
    if (socket.data.code) return respond(callback, 'Leave your current room first.');
    const existing = typeof playerId === 'string' && room.players.get(playerId);
    if (existing) {
      if (existing.socketId && existing.socketId !== socket.id) io.sockets.sockets.get(existing.socketId)?.disconnect(true);
      attach(room, existing);
      return respond(callback, null, { code, playerId: existing.id });
    }
    name = validName(name);
    if (!name) return respond(callback, 'Enter your name to join.');
    if (room.players.size >= 20) return respond(callback, 'This room is full.');
    if ([...room.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase())) return respond(callback, 'That name is already in this room.');
    const player = { id: crypto.randomUUID(), name, connected: true, wins: 0 };
    room.players.set(player.id, player);
    attach(room, player);
    respond(callback, null, { code, playerId: player.id });
  });

  socket.on('image:upload', ({ data } = {}, callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId) return respond(callback, 'Only the host can upload an image.');
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

  socket.on('round:prepare', ({ name, description, image, startingBid, increment = 10, autoEnd = true } = {}, callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId) return respond(callback, 'Only the host can prepare an auction.');
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
    room.lot = { name, description, image, startingBid: startingCents / 100, increment: incrementCents / 100, autoEnd };
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
    if (!room || socket.data.playerId !== room.hostId) return respond(callback, 'Only the host can start an auction.');
    if (room.phase !== 'ready') return respond(callback, 'Prepare an item before starting the auction.');
    room.round += 1;
    room.phase = 'live';
    if (room.lot.autoEnd) resetRoundTimer(room);
    publish(room);
    respond(callback);
  });

  socket.on('round:end', (callback) => {
    const room = getRoom();
    if (!room || socket.data.playerId !== room.hostId) return respond(callback, 'Only the host can end an auction.');
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
    if (room.lot.autoEnd) resetRoundTimer(room);
    publish(room);
    respond(callback);
  });

  socket.on('room:leave', (callback) => {
    const room = getRoom();
    const playerId = socket.data.playerId;
    if (!room || !room.players.has(playerId)) return respond(callback, 'You are not in a room.');
    room.players.delete(playerId);
    socket.leave(room.code);
    delete socket.data.code;
    delete socket.data.playerId;
    if (room.players.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
    } else {
      if (room.hostId === playerId) room.hostId = ([...room.players.values()].find((player) => player.connected) || room.players.values().next().value).id;
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

module.exports = { server, io, rooms };