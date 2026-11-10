const socket = io();
const $ = (selector) => document.querySelector(selector);
const welcome = $('#welcome');
const game = $('#game');
const entryForm = $('#entry-form');
const lotForm = $('#lot-form');
const savedKey = 'going-once-player';
let mode = 'join';
let identity = null;
let room = null;
let timerInterval;
let editingLot = false;
let lastResult = null;
let lastImageDefault = null;
let uploadVersion = 0;
let uploadingImage = false;
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const stockImages = [
  { name: 'Camera', photo: 'photo-1516035069371-29a1b244cc32' },
  { name: 'Sports card', photo: 'photo-1607310073276-9f48dec47340' },
  { name: 'Watch', photo: 'photo-1523170335258-f5ed11844a49' },
  { name: 'Chair', photo: 'photo-1503602642458-232111445657' },
  { name: 'Guitar', photo: 'photo-1510915361894-db8b60106cb1' },
  { name: 'Artwork', photo: 'photo-1579783902614-a3fb3927b6a5' },
  { name: 'Sneakers', photo: 'photo-1542291026-7eec264c27ff' }
];

try { identity = JSON.parse(localStorage.getItem(savedKey)); } catch { localStorage.removeItem(savedKey); }

function icons() {
  if (window.lucide) window.lucide.createIcons();
}

function errorAt(selector, message = '') {
  $(selector).textContent = message;
}

function saveIdentity(data) {
  identity = { code: data.code, playerId: data.playerId };
  localStorage.setItem(savedKey, JSON.stringify(identity));
  render();
}

function resetRoom() {
  identity = null;
  room = null;
  editingLot = false;
  lastResult = null;
  lastImageDefault = null;
  cancelImageUpload();
  lotForm.reset();
  syncStockSelection();
  updateImagePreview();
  if ($('#result-dialog').open) $('#result-dialog').close();
  if ($('#leave-dialog').open) $('#leave-dialog').close();
  localStorage.removeItem(savedKey);
  clearInterval(timerInterval);
  welcome.hidden = false;
  game.hidden = true;
  $('#room-code').value = '';
}

function updateConnection(connected) {
  $('.connection').classList.toggle('offline', !connected);
  $('#connection-label').textContent = connected ? 'Online' : 'Reconnecting';
}

socket.on('connect', () => {
  updateConnection(true);
  if (identity) {
    socket.emit('room:join', identity, (response) => {
      if (response.error) {
        resetRoom();
        errorAt('#entry-error', 'Your room is no longer available. Start or join another game.');
      } else saveIdentity(response);
    });
  }
});
socket.on('disconnect', () => updateConnection(false));
socket.on('room:update', (data) => {
  room = data;
  render();
});

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  mode = tab.dataset.mode;
  document.querySelectorAll('.tab').forEach((item) => {
    item.classList.toggle('active', item === tab);
    item.setAttribute('aria-selected', String(item === tab));
  });
  $('#code-field').hidden = mode === 'create';
  $('#room-code').required = mode === 'join';
  $('#entry-label').textContent = mode === 'join' ? 'Join the room' : 'Create a room';
  errorAt('#entry-error');
}));

entryForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!socket.connected) return errorAt('#entry-error', 'Connecting to the server. Please try again.');
  errorAt('#entry-error');
  const button = entryForm.querySelector('button[type="submit"]');
  button.disabled = true;
  const payload = { name: $('#player-name').value.trim(), code: $('#room-code').value.trim() };
  socket.timeout(5000).emit(mode === 'create' ? 'room:create' : 'room:join', payload, (error, response) => {
    button.disabled = false;
    if (error) return errorAt('#entry-error', 'Could not reach the server. Please try again.');
    if (response.error) return errorAt('#entry-error', response.error);
    saveIdentity(response);
  });
});

lotForm.addEventListener('submit', (event) => {
  event.preventDefault();
  errorAt('#host-error');
  if (!socket.connected) return errorAt('#host-error', 'Not connected to the server. Please try again.');
  const button = $('#prepare-button');
  button.disabled = true;
  socket.timeout(5000).emit('round:prepare', { name: $('#item-name').value, description: $('#item-description').value, image: $('#item-image').value, startingBid: $('#starting-bid').value, increment: $('#bid-step').value, autoEnd: $('#auto-end').checked }, (error, response) => {
    button.disabled = false;
    if (error) return errorAt('#host-error', 'The server did not respond. Refresh the page and try again.');
    if (response.error) return errorAt('#host-error', response.error);
    editingLot = false;
    render();
  });
});

$('#start-auction-button').addEventListener('click', () => {
  errorAt('#start-error');
  socket.emit('round:start', (response) => {
    if (response.error) return errorAt('#start-error', response.error);
    editingLot = false;
    cancelImageUpload();
    lotForm.reset();
    syncStockSelection();
    updateImagePreview();
  });
});

$('#edit-lot-button').addEventListener('click', () => {
  editingLot = true;
  $('#item-name').value = room.lot.name;
  $('#item-description').value = room.lot.description;
  $('#item-image').value = room.lot.image;
  syncStockSelection();
  updateImagePreview();
  $('#starting-bid').value = room.lot.startingBid;
  $('#bid-step').value = room.lot.increment;
  $('#auto-end').checked = room.lot.autoEnd;
  render();
});

$('#end-button').addEventListener('click', () => {
  errorAt('#end-error');
  socket.emit('round:end', (response) => {
    if (response.error) errorAt('#end-error', response.error);
  });
});

$('#bid-button').addEventListener('click', () => {
  errorAt('#bid-error');
  socket.emit('bid:place', { amount: $('#bid-input').value }, (response) => {
    if (response.error) errorAt('#bid-error', response.error);
  });
});

$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(room.code);
    $('#copy-feedback').textContent = 'Code copied!';
  } catch {
    $('#copy-feedback').textContent = 'Share the code shown above';
  }
});

function confirmLeave() {
  errorAt('#leave-error');
  const isHost = room?.hostId === identity?.playerId;
  $('#leave-detail').textContent = isHost && room.players.length > 1
    ? 'Another player will become the host when you leave.'
    : isHost ? 'The lobby will close when you leave.' : 'You will leave this lobby.';
  if (!$('#leave-dialog').open) $('#leave-dialog').showModal();
}

$('.brand').addEventListener('click', (event) => {
  if (!identity) return;
  event.preventDefault();
  confirmLeave();
});

$('#leave-button').addEventListener('click', confirmLeave);
$('#cancel-leave').addEventListener('click', () => $('#leave-dialog').close());
$('#confirm-leave').addEventListener('click', () => {
  errorAt('#leave-error');
  if (!socket.connected) return errorAt('#leave-error', 'Not connected. Please reconnect before leaving.');
  const button = $('#confirm-leave');
  button.disabled = true;
  socket.timeout(5000).emit('room:leave', (error, response) => {
    button.disabled = false;
    if (error) return errorAt('#leave-error', 'Could not leave the lobby. Please try again.');
    if (response.error) return errorAt('#leave-error', response.error);
    resetRoom();
  });
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function syncStockSelection() {
  document.querySelectorAll('.stock-image').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.url === $('#item-image').value.trim()));
  });
}

function updateImagePreview() {
  const preview = $('#image-preview');
  const url = $('#item-image').value.trim();
  preview.hidden = true;
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/api/images/')) {
    preview.removeAttribute('src');
    return;
  }
  preview.onload = () => { preview.hidden = false; };
  preview.onerror = () => { preview.hidden = true; };
  if (preview.getAttribute('src') === url && preview.complete && preview.naturalWidth) preview.hidden = false;
  else preview.src = url;
}

function cancelImageUpload() {
  uploadVersion += 1;
  if (uploadingImage) $('#prepare-button').disabled = false;
  uploadingImage = false;
  $('#upload-status').textContent = '';
}

stockImages.forEach(({ name, photo }) => {
  const url = `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=1200&q=85`;
  const button = element('button', 'stock-image');
  button.type = 'button';
  button.dataset.url = url;
  button.setAttribute('aria-label', `Use ${name.toLowerCase()} image`);
  button.setAttribute('aria-pressed', 'false');
  const image = element('img');
  image.src = `https://images.unsplash.com/${photo}?auto=format&fit=crop&w=300&q=75`;
  image.alt = '';
  image.loading = 'lazy';
  button.append(image, element('span', '', name));
  button.addEventListener('click', () => {
    cancelImageUpload();
    $('#item-upload').value = '';
    $('#item-image').value = $('#item-image').value.trim() === url ? '' : url;
    syncStockSelection();
    updateImagePreview();
  });
  $('#stock-images').append(button);
});
$('#item-image').addEventListener('input', () => {
  cancelImageUpload();
  $('#item-upload').value = '';
  syncStockSelection();
});
$('#item-image').addEventListener('change', updateImagePreview);

$('#item-upload').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  cancelImageUpload();
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return errorAt('#upload-status', 'Choose an image no larger than 5 MB.');
  if (!socket.connected) return errorAt('#upload-status', 'Not connected. Please reconnect before uploading.');
  const version = uploadVersion;
  uploadingImage = true;
  $('#prepare-button').disabled = true;
  $('#upload-status').textContent = 'Uploading image...';
  try {
    const data = await file.arrayBuffer();
    if (version !== uploadVersion) return;
    socket.timeout(15000).emit('image:upload', { data }, (error, response) => {
      if (version !== uploadVersion) return;
      uploadingImage = false;
      $('#prepare-button').disabled = false;
      if (error) return errorAt('#upload-status', 'Upload failed. Please try again.');
      if (response.error) return errorAt('#upload-status', response.error);
      $('#item-image').value = response.url;
      $('#upload-status').textContent = `Uploaded: ${file.name}`;
      syncStockSelection();
      updateImagePreview();
    });
  } catch {
    if (version !== uploadVersion) return;
    uploadingImage = false;
    $('#prepare-button').disabled = false;
    errorAt('#upload-status', 'Could not read the image. Please try again.');
  }
});

function renderPlayers() {
  const list = $('#players-list');
  list.replaceChildren();
  $('#player-count').textContent = room.players.length;
  room.players.forEach((player) => {
    const row = element('div', 'player-row');
    const avatar = element('div', 'player-avatar', player.name.slice(0, 1).toUpperCase());
    const info = element('div', 'player-info');
    info.append(element('div', 'player-name', player.name + (player.id === identity.playerId ? ' (you)' : '')));
    const roles = [];
    if (player.id === room.hostId) roles.push('Host');
    if (!player.connected) roles.push('Away');
    roles.push(`${player.wins} ${player.wins === 1 ? 'win' : 'wins'}`);
    info.append(element('div', 'player-role', roles.join(' · ')));
    const status = element('span', `player-status${player.connected ? '' : ' away'}`);
    status.title = player.connected ? 'Online' : 'Away';
    row.append(avatar, info, status);
    list.append(row);
  });
}

function renderHistory() {
  const list = $('#history-list');
  list.replaceChildren();
  if (!room.history.length) {
    list.append(element('p', 'empty-history', 'The good stuff is still to come.'));
    return;
  }
  room.history.forEach((entry) => {
    const item = element('div', 'history-item');
    const details = element('div');
    details.append(element('strong', '', entry.lot.name), element('small', '', entry.winner ? `Won by ${entry.winner}` : 'No bids'));
    item.append(details, element('span', 'history-amount', entry.winner ? money.format(entry.amount) : '—'));
    list.append(item);
  });
}

function updateTimer() {
  const seconds = Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000));
  $('#timer span').textContent = `00:${String(seconds).padStart(2, '0')}`;
}

function showResult() {
  const dialog = $('#result-dialog');
  if (room.phase !== 'result') {
    if (dialog.open) dialog.close();
    return;
  }
  const key = `${room.code}:${room.round}`;
  if (lastResult === key) return;
  const result = room.history[0];
  if (!result) return;
  if (dialog.open) dialog.close();
  if (!result.winner) {
    $('#result-title').textContent = 'No bids this time';
    $('#result-detail').textContent = `${result.lot.name} ended without a winner.`;
  } else if (room.leaderId === identity.playerId) {
    $('#result-title').textContent = 'You won!';
    $('#result-detail').textContent = `You won ${result.lot.name} for ${money.format(result.amount)}.`;
  } else {
    $('#result-title').textContent = "You didn't win";
    $('#result-detail').textContent = `${result.winner} won ${result.lot.name} for ${money.format(result.amount)}.`;
  }
  lastResult = key;
  dialog.showModal();
}

function render() {
  if (!room || !identity || room.code !== identity.code) return;
  const me = room.players.find((player) => player.id === identity.playerId);
  if (!me) return;
  const host = me.id === room.hostId;
  const resultKey = `${room.code}:${room.round}`;
  if (host && room.phase === 'result' && lastImageDefault !== resultKey) {
    $('#item-image').value = room.lot.image;
    syncStockSelection();
    updateImagePreview();
    lastImageDefault = resultKey;
  }
  welcome.hidden = true;
  game.hidden = false;
  $('#display-code').textContent = room.code;
  $('#host-panel').hidden = !host || room.phase === 'live' || (room.phase === 'ready' && !editingLot);
  $('#ready-host-actions').hidden = !host || room.phase !== 'ready' || editingLot;
  $('#ready-note').hidden = room.phase !== 'ready' || host;
  $('#live-host-actions').hidden = !host || room.phase !== 'live';
  $('#host-heading').textContent = room.phase === 'ready' ? 'Edit the item' : room.phase === 'result' ? 'Ready for another?' : 'Put something up for bid';
  $('#lobby-message').textContent = host ? 'Get your friends in the room, then put the first item up for bid.' : 'Your host is getting the first item ready. Grab your friends and settle in.';
  $('#lobby-view').hidden = room.phase !== 'lobby';
  $('#auction-view').hidden = room.phase === 'lobby';
  const phaseLabel = $('#phase-label');
  phaseLabel.classList.toggle('live', room.phase === 'live');
  phaseLabel.lastChild.textContent = room.phase === 'live' ? ' LIVE AUCTION' : room.phase === 'result' ? ' AUCTION CLOSED' : ' WAITING ROOM';
  renderPlayers();
  renderHistory();
  clearInterval(timerInterval);
  if (room.phase !== 'lobby') {
    $('#lot-number').textContent = `LOT ${String(room.round + (room.phase === 'ready' ? 1 : 0)).padStart(2, '0')}`;
    $('#lot-name').textContent = room.lot.name;
    $('#lot-description').textContent = room.lot.description;
    const image = $('#lot-image');
    const placeholder = $('#image-placeholder');
    image.hidden = !room.lot.image;
    placeholder.hidden = !!room.lot.image;
    image.onerror = () => { image.hidden = true; placeholder.hidden = false; };
    if (room.lot.image && image.getAttribute('src') !== room.lot.image) image.src = room.lot.image;
    $('#timer').hidden = room.phase !== 'live' || room.endsAt === null;
    if (room.phase === 'live' && room.endsAt !== null) { updateTimer(); timerInterval = setInterval(updateTimer, 250); }
    const leader = room.players.find((player) => player.id === room.leaderId);
    const leaderName = room.leaderName || leader?.name;
    $('#bid-label').textContent = room.leaderId ? 'CURRENT BID' : 'STARTING BID';
    $('#bid-amount').textContent = money.format(room.bid);
    $('#bid-leader').textContent = room.phase === 'ready' ? 'Bidding has not started yet.' : leaderName ? `${leaderName} ${room.leaderId === me.id ? '(you) ' : !leader ? '(left the room) ' : ''}is in the lead.` : 'Be the first to make a move.';
    $('#bid-increment').textContent = `Bid increment: ${money.format(room.lot.increment)}`;
    $('#bid-controls').hidden = room.phase !== 'live';
    const minimum = (Math.round(room.bid * 100) + (room.leaderId ? Math.round(room.lot.increment * 100) : 0)) / 100;
    const bidInput = $('#bid-input');
    bidInput.min = minimum;
    bidInput.step = room.lot.increment;
    if (document.activeElement !== bidInput || Number(bidInput.value) < minimum) bidInput.value = minimum;
    $('#bid-button').disabled = room.leaderId === me.id;
    $('#bid-button').title = room.leaderId === me.id ? 'You are already in the lead' : 'Place bid';
    $('#result-message').hidden = room.phase !== 'result';
    if (room.phase === 'result') $('#result-message').textContent = room.history[0]?.winner ? `Sold to ${room.history[0].winner} for ${money.format(room.history[0].amount)}!` : 'No bids this time. On to the next find.';
    errorAt('#bid-error');
  }
  icons();
  showResult();
}

icons();