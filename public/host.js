const $ = (selector) => document.querySelector(selector);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let profile = null;
let auctions = [];

function showError(message) {
  $('#page-error').textContent = message;
}

function avatarInitials() {
  return profile?.displayName.trim().slice(0, 1).toUpperCase() || '?';
}

function renderAvatar() {
  const initials = avatarInitials();
  $('#avatar-initials').textContent = initials;
  const image = $('#avatar-image');
  image.hidden = !profile?.hasAvatar;
  $('#avatar-initials').hidden = !!profile?.hasAvatar;
  $('#remove-avatar').hidden = !profile?.hasAvatar;
  const headerAvatar = $('#host-profile-avatar');
  headerAvatar.replaceChildren();
  if (!profile?.hasAvatar) {
    headerAvatar.textContent = initials;
    return;
  }
  const headerImage = document.createElement('img');
  headerImage.alt = '';
  headerImage.src = '/api/host/profile/avatar';
  headerImage.onerror = () => { headerAvatar.textContent = initials; };
  headerAvatar.append(headerImage);
  image.src = '/api/host/profile/avatar';
  image.onerror = () => {
    image.hidden = true;
    $('#avatar-initials').hidden = false;
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function filePart(value) {
  return String(value).normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'auction';
}

function downloadCsv(auctionList = auctions, filename = 'going-once-hosted-lots.csv') {
  const rows = [['Item', 'Description', 'Image', 'Room code', 'Round', 'Ended at', 'Starting bid', 'Bid increment', 'Winner', 'Winning bid']];
  auctionList.forEach((auction) => auction.lots.forEach((lot) => {
    rows.push([
      auction.name,
      lot.lot_name,
      lot.description,
      lot.image,
      lot.room_code,
      lot.round,
      new Date(lot.ended_at).toISOString(),
      lot.starting_bid.toFixed(2),
      lot.increment.toFixed(2),
      lot.winner || 'No bids',
      lot.winner ? lot.winning_bid.toFixed(2) : ''
    ]);
  }));
  rows[0] = ['Auction name', ...rows[0]];
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderLots() {
  const groups = $('#auction-groups');
  groups.replaceChildren();
  const lotCount = auctions.reduce((total, auction) => total + auction.lots.length, 0);
  $('#download-lots').disabled = lotCount === 0;
  $('#lots-empty').hidden = lotCount > 0;
  auctions.forEach((auction) => {
    const section = document.createElement('section');
    section.className = 'auction-history';
    const heading = document.createElement('div');
    heading.className = 'auction-history-heading';
    const title = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = auction.name;
    const detail = document.createElement('p');
    detail.textContent = `Room ${auction.roomCode} · ${auction.lots.length} ${auction.lots.length === 1 ? 'lot' : 'lots'}`;
    title.append(name, detail);
    const download = document.createElement('button');
    download.className = 'button auction-download';
    download.type = 'button';
    download.textContent = 'Download CSV';
    download.setAttribute('aria-label', `Download ${auction.name} data as CSV`);
    download.addEventListener('click', () => {
      downloadCsv([auction], `going-once-${filePart(auction.name)}-${filePart(auction.roomCode)}.csv`);
    });
    const remove = document.createElement('button');
    remove.className = 'button auction-delete';
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${auction.name} auction history`);
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete your saved lots for "${auction.name}"? This cannot be undone. If the auction is still running, future completed lots will appear again.`)) return;
      remove.disabled = true;
      showError('');
      try {
        const response = await fetch(`/api/host/auctions/${encodeURIComponent(auction.id)}`, { method: 'DELETE' });
        if (!response.ok) {
          showError('Could not delete the auction history. Please refresh and try again.');
          return;
        }
        auctions = auctions.filter((item) => item.id !== auction.id);
        renderLots();
      } catch {
        showError('Could not reach the server. Please try again.');
      } finally {
        remove.disabled = false;
      }
    });
    const actions = document.createElement('div');
    actions.className = 'auction-history-actions';
    actions.append(download, remove);
    heading.append(title, actions);
    section.append(heading);

    const tableWrap = document.createElement('div');
    tableWrap.className = 'lots-table-wrap';
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>LOT</th><th>ENDED</th><th>STARTING</th><th>WINNER</th><th>WINNING BID</th></tr></thead>';
    const body = document.createElement('tbody');
    auction.lots.forEach((lot) => {
      const row = document.createElement('tr');
      const values = [
        lot.lot_name,
        new Date(lot.ended_at).toLocaleString(),
        money.format(lot.starting_bid),
        lot.winner || 'No bids',
        lot.winner ? money.format(lot.winning_bid) : '—'
      ];
      values.forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      body.append(row);
    });
    table.append(body);
    tableWrap.append(table);
    section.append(tableWrap);
    groups.append(section);
  });
}

async function loadPage() {
  try {
    const sessionResponse = await fetch('/api/auth/session');
    if (!sessionResponse.ok) throw new Error('Could not check your sign-in status.');
    const session = await sessionResponse.json();
    if (!session.user) {
      location.replace('/?host=1');
      return;
    }
    $('#account-email').textContent = session.user.email;

    const [profileResponse, auctionsResponse] = await Promise.all([
      fetch('/api/host/profile'),
      fetch('/api/host/lots')
    ]);
    if (!profileResponse.ok || !auctionsResponse.ok) throw new Error('Could not load your host preferences. Please refresh.');
    profile = await profileResponse.json();
    const history = await auctionsResponse.json();
    if (Array.isArray(history.auctions)) auctions = history.auctions;
    else if (Array.isArray(history.lots) && history.lots.length === 0) auctions = [];
    else throw new Error('Unexpected auction history response. Restart the app server and refresh this page.');
    $('#display-name').value = profile.displayName;
    $('#venmo-link').value = profile.venmoLink;
    renderAvatar();
    renderLots();
  } catch (error) {
    showError(error.message || 'Could not load your host preferences. Please try again.');
  }
}

$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#profile-status').textContent = '';
  $('#save-profile').disabled = true;
  try {
    const response = await fetch('/api/host/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: $('#display-name').value, venmoLink: $('#venmo-link').value })
    });
    const result = await response.json();
    if (!response.ok) {
      $('#profile-status').textContent = result.error || 'Could not save your preferences.';
      return;
    }
    profile = { ...profile, ...result };
    $('#profile-status').textContent = 'Preferences saved.';
    renderAvatar();
  } catch {
    $('#profile-status').textContent = 'Could not reach the server. Please try again.';
  } finally {
    $('#save-profile').disabled = false;
  }
});

$('#avatar-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  $('#avatar-status').textContent = '';
  if (!file) return;
  if (file.size > MAX_AVATAR_BYTES) {
    $('#avatar-status').textContent = 'Choose an image no larger than 5 MB.';
    event.target.value = '';
    return;
  }
  $('#avatar-status').textContent = 'Uploading picture...';
  try {
    const response = await fetch('/api/host/profile/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer()
    });
    const result = response.ok ? {} : await response.json();
    if (!response.ok) {
      $('#avatar-status').textContent = result.error || 'Could not upload the picture.';
      return;
    }
    profile.hasAvatar = true;
    renderAvatar();
    $('#avatar-status').textContent = 'Profile picture updated.';
  } catch {
    $('#avatar-status').textContent = 'Could not reach the server. Please try again.';
  }
});

$('#remove-avatar').addEventListener('click', async () => {
  $('#avatar-status').textContent = '';
  try {
    const response = await fetch('/api/host/profile/avatar', { method: 'DELETE' });
    if (!response.ok) {
      $('#avatar-status').textContent = 'Could not remove the picture. Please try again.';
      return;
    }
    profile.hasAvatar = false;
    renderAvatar();
    $('#avatar-file').value = '';
    $('#avatar-status').textContent = 'Profile picture removed.';
  } catch {
    $('#avatar-status').textContent = 'Could not reach the server. Please try again.';
  }
});

$('#download-lots').addEventListener('click', () => downloadCsv());
$('#host-signout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) return showError('Could not sign out. Please try again.');
    location.assign('/');
  } catch {
    showError('Could not reach the server. Please try again.');
  }
});

loadPage();
