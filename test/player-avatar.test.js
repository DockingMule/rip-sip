const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { io: connect } = require('socket.io-client');

process.env.DATABASE_PATH = ':memory:';
process.env.HOST_INVITE_EMAILS = 'host@example.com,player@example.com';
delete process.env.SITE_ADMIN_EMAIL;
const { server, io, rooms, database, updateHostAccess } = require('../server');

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextUpdate(socket, predicate) {
  return new Promise((resolve) => {
    function onUpdate(room) {
      if (!predicate(room)) return;
      socket.off('room:update', onUpdate);
      resolve(room);
    }
    socket.on('room:update', onUpdate);
  });
}

test('room pictures follow signed-in players and profile changes', async (context) => {
  const sockets = [];
  context.after(() => {
    sockets.forEach((socket) => socket.disconnect());
    for (const room of rooms.values()) clearTimeout(room.timer);
    io.close();
    database.close();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  async function register(email) {
    const invitationCode = updateHostAccess(email, true).code;
    const response = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-sufficiently-long-password', invitationCode })
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
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
  async function avatar(cookie, body) {
    return fetch(`${url}/api/host/profile/avatar`, {
      method: body ? 'POST' : 'DELETE',
      headers: { Origin: url, Cookie: cookie, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
      ...(body ? { body } : {})
    });
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
  const otherPng = Buffer.concat([png, Buffer.from('different')]);
  const hostCookie = await register('host@example.com');
  const playerCookie = await register('player@example.com');
  assert.equal((await avatar(hostCookie, png)).status, 200);
  assert.equal((await avatar(playerCookie, png)).status, 200);
  const host = await socket(hostCookie);
  const guest = await socket();
  const signedPlayer = await socket(playerCookie);
  const created = await emit(host, 'room:create', { auctionName: 'Profile pictures' });
  const guestRoomUpdate = nextUpdate(guest, (room) => room.players.length === 2);
  const joined = await emit(guest, 'room:join', { code: created.code, name: 'Guest' });
  const guestRoom = await guestRoomUpdate;
  const hostPublic = guestRoom.players.find((player) => player.id === created.playerId);
  assert.ok(hostPublic.avatarUrl);
  assert.equal(guestRoom.players.find((player) => player.id === joined.playerId).avatarUrl, null);
  assert.equal('accountId' in hostPublic, false);
  const image = await fetch(url + hostPublic.avatarUrl);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.equal((await fetch(`${url}/api/rooms/${created.code}/players/${joined.playerId}/avatar`)).status, 404);
  assert.equal((await fetch(`${url}/api/rooms/WRONG/players/${created.playerId}/avatar`)).status, 404);

  const joinedUpdate = nextUpdate(guest, (room) => room.players.length === 3);
  const signedJoined = await emit(signedPlayer, 'room:join', { code: created.code, name: 'Signed player' });
  const signedPublic = (await joinedUpdate).players.find((player) => player.id === signedJoined.playerId);
  assert.ok(signedPublic.avatarUrl);
  assert.deepEqual(Buffer.from(await (await fetch(url + signedPublic.avatarUrl)).arrayBuffer()), png);

  const replacementUpdate = nextUpdate(guest, (room) => {
    const player = room.players.find((entry) => entry.id === signedJoined.playerId);
    return player?.avatarUrl && player.avatarUrl !== signedPublic.avatarUrl;
  });
  assert.equal((await avatar(playerCookie, otherPng)).status, 200);
  const replacementUrl = (await replacementUpdate).players.find((player) => player.id === signedJoined.playerId).avatarUrl;
  assert.deepEqual(Buffer.from(await (await fetch(url + replacementUrl)).arrayBuffer()), otherPng);
  const removedUpdate = nextUpdate(guest, (room) => room.players.find((player) => player.id === signedJoined.playerId)?.avatarUrl === null);
  assert.equal((await avatar(playerCookie)).status, 200);
  await removedUpdate;
  assert.equal((await fetch(url + replacementUrl)).status, 404);

  const restoredUpdate = nextUpdate(guest, (room) => Boolean(room.players.find((player) => player.id === signedJoined.playerId)?.avatarUrl));
  assert.equal((await avatar(playerCookie, png)).status, 200);
  const restoredUrl = (await restoredUpdate).players.find((player) => player.id === signedJoined.playerId).avatarUrl;
  const anonymousReconnect = await socket();
  const anonymousUpdate = nextUpdate(guest, (room) => room.players.find((player) => player.id === signedJoined.playerId)?.avatarUrl === null);
  assert.equal((await emit(anonymousReconnect, 'room:join', { code: created.code, playerId: signedJoined.playerId, rejoinToken: signedJoined.rejoinToken })).ok, true);
  await anonymousUpdate;
  assert.equal((await fetch(url + restoredUrl)).status, 404);
  const signedReconnect = await socket(playerCookie);
  const signedUpdate = nextUpdate(guest, (room) => Boolean(room.players.find((player) => player.id === signedJoined.playerId)?.avatarUrl));
  assert.equal((await emit(signedReconnect, 'room:join', { code: created.code, playerId: signedJoined.playerId, rejoinToken: signedJoined.rejoinToken })).ok, true);
  const signedUrl = (await signedUpdate).players.find((player) => player.id === signedJoined.playerId).avatarUrl;
  assert.ok(signedUrl);

  const logoutUpdate = nextUpdate(guest, (room) => room.players.find((player) => player.id === signedJoined.playerId)?.avatarUrl === null);
  assert.equal((await fetch(`${url}/api/auth/logout`, { method: 'POST', headers: { Origin: url, Cookie: playerCookie } })).status, 200);
  await logoutUpdate;
  assert.equal((await fetch(url + signedUrl)).status, 404);
  const login = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'player@example.com', password: 'a-sufficiently-long-password' })
  });
  assert.equal(login.status, 200);
  const loggedInAgain = await socket(login.headers.get('set-cookie').split(';')[0]);
  const restoredAfterLogin = nextUpdate(guest, (room) => Boolean(room.players.find((player) => player.id === signedJoined.playerId)?.avatarUrl));
  assert.equal((await emit(loggedInAgain, 'room:join', { code: created.code, playerId: signedJoined.playerId, rejoinToken: signedJoined.rejoinToken })).ok, true);
  await restoredAfterLogin;

  const hostRemoval = nextUpdate(guest, (room) => !room.players.some((player) => player.id === created.playerId));
  assert.equal((await new Promise((resolve) => host.emit('room:leave', resolve))).ok, true);
  await hostRemoval;
  assert.equal((await fetch(url + hostPublic.avatarUrl)).status, 404);
});

test('player list renders photos and keeps initials as a fallback', () => {
  class Element {
    constructor(tag, className = '', text = '') {
      this.tag = tag;
      this.className = className;
      this.textContent = text;
      this.children = [];
      this.parentElement = null;
    }
    append(...children) {
      for (const child of children) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      this.children.forEach((child) => { child.parentElement = null; });
      this.children = [];
      this.append(...children);
    }
    remove() {
      if (!this.parentElement) return;
      const parent = this.parentElement;
      parent.children = parent.children.filter((child) => child !== this);
      this.parentElement = null;
    }
  }
  const list = new Element('div');
  const count = new Element('span');
  const room = {
    hostId: 'host',
    players: [
      { id: 'host', name: 'Host', connected: true, wins: 0, avatarUrl: '/avatar?v=1' },
      { id: 'guest', name: 'Guest', connected: true, wins: 0, avatarUrl: null }
    ]
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const render = source.slice(source.indexOf('function renderPlayers()'), source.indexOf('\nfunction csvCell', source.indexOf('function renderPlayers()')));
  const context = {
    room, identity: { playerId: 'guest' }, playerPictures: new Map(),
    $: (selector) => selector === '#players-list' ? list : count,
    element: (tag, className, text) => new Element(tag, className, text)
  };
  vm.runInNewContext(render, context);
  context.renderPlayers();
  const photo = list.children[0].children[0].children[0];
  assert.equal(photo.src, '/avatar?v=1');
  assert.equal(photo.alt, '');
  assert.equal(list.children[1].children[0].textContent, 'G');
  context.renderPlayers();
  assert.equal(list.children[0].children[0].children[0], photo);
  photo.onerror();
  assert.equal(list.children[0].children[0].textContent, 'H');
  assert.equal(list.children[0].children[0].children.length, 0);
  context.renderPlayers();
  assert.equal(list.children[0].children[0].children.length, 0);
  room.players[0].avatarUrl = '/avatar?v=2';
  context.renderPlayers();
  assert.equal(list.children[0].children[0].children[0].src, '/avatar?v=2');
});
