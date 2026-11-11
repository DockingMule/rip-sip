const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('individual auction deletion confirms, preserves other history, and updates downloads', async () => {
  class Element {
    constructor() {
      this.children = [];
      this.listeners = {};
      this.hidden = false;
      this.disabled = false;
    }

    addEventListener(event, listener) { this.listeners[event] = listener; }
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    click() { this.clicked = true; }
    remove() {}
  }

  const elements = new Map();
  const body = new Element();
  const document = {
    body,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement() { return new Element(); }
  };
  const lot = (name) => ({
    lot_name: name, description: '', image: '', room_code: 'ABCDE', round: 1,
    ended_at: 1700000000000, starting_bid: 10, increment: 1, winner: null, winning_bid: 0
  });
  const history = [
    { id: 'first', name: 'First sale', roomCode: 'ABCDE', lots: [lot('Chair')] },
    { id: 'second', name: 'Second sale', roomCode: 'FGHJK', lots: [lot('Lamp')] }
  ];
  const requests = [];
  let confirmed = false;
  let failDelete = false;
  let downloadedBlob;
  const fetch = async (url, options) => {
    if (options?.method === 'DELETE') {
      requests.push(url);
      return { ok: !failDelete };
    }
    const data = url === '/api/auth/session' ? { user: { email: 'host@example.com' } }
      : url === '/api/host/profile' ? { displayName: 'Host', venmoLink: '', hasAvatar: false }
        : { auctions: history };
    return { ok: true, json: async () => data };
  };
  const context = {
    document, fetch, Blob, Intl,
    URL: { createObjectURL(blob) { downloadedBlob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    confirm: () => confirmed,
    setTimeout() {},
    location: { replace() {}, assign() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/host.js'), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));

  const groups = document.querySelector('#auction-groups');
  assert.equal(groups.children.length, 2);
  const firstActions = groups.children[0].children[0].children[1].children;
  firstActions[0].listeners.click();
  const firstCsv = await downloadedBlob.text();
  assert.match(firstCsv, /Chair/);
  assert.doesNotMatch(firstCsv, /Lamp/);
  await firstActions[1].listeners.click();
  assert.equal(requests.length, 0);

  confirmed = true;
  failDelete = true;
  await firstActions[1].listeners.click();
  assert.equal(groups.children.length, 2);
  assert.match(document.querySelector('#page-error').textContent, /could not delete/i);
  failDelete = false;
  await firstActions[1].listeners.click();
  assert.deepEqual(requests, ['/api/host/auctions/first', '/api/host/auctions/first']);
  assert.equal(groups.children.length, 1);
  document.querySelector('#download-lots').listeners.click();
  const remainingCsv = await downloadedBlob.text();
  assert.match(remainingCsv, /Lamp/);
  assert.doesNotMatch(remainingCsv, /Chair/);
  await groups.children[0].children[0].children[1].children[1].listeners.click();
  assert.equal(groups.children.length, 0);
  assert.equal(document.querySelector('#lots-empty').hidden, false);
  assert.equal(document.querySelector('#download-lots').disabled, true);
});
