(() => {
  const get = (id) => document.getElementById(id);
  const panel = get('admin-panel');
  const error = get('admin-error');

  async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || `Request failed (${response.status}).`);
    }
    return response.json();
  }

  function showInvitation(invitation, email) {
    const result = get('admin-invite-result');
    result.hidden = !invitation;
    get('admin-invite-code').value = invitation?.code || '';
    get('admin-invite-detail').textContent = invitation
      ? `Share this code privately with ${email}. It can be used once and expires ${new Date(invitation.expiresAt).toLocaleString()}. Generating another code invalidates this one.`
      : '';
  }

  function showUsers(users) {
    const list = get('admin-users');
    list.replaceChildren();
    users.forEach((user) => {
      const item = document.createElement('li');
      const info = document.createElement('div');
      const email = document.createElement('strong');
      const details = document.createElement('small');
      email.textContent = user.email;
      details.textContent = `${user.registered ? 'Registered account' : 'Invitation'} · ${user.enabled ? 'Enabled' : 'Disabled'}`;
      info.append(email, details);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button auction-download';
      button.textContent = user.enabled ? 'Disable' : 'Enable';
      button.setAttribute('aria-label', `${button.textContent} ${user.email}`);
      button.addEventListener('click', async () => {
        if (user.enabled && !window.confirm(`Disable access for ${user.email}? An existing account will be signed out.`)) return;
        button.disabled = true;
        try {
          const result = await setAccess(user.email, !user.enabled);
          showInvitation(result.invitation, user.email);
          get('admin-access-status').textContent = `Access ${user.enabled ? 'disabled' : 'enabled'} for ${user.email}.`;
          await refresh();
        } catch (err) {
          get('admin-access-status').textContent = err.message;
          button.disabled = false;
        }
      });
      const actions = document.createElement('div');
      if (user.enabled && !user.registered) {
        const newCode = document.createElement('button');
        newCode.type = 'button';
        newCode.className = 'button auction-download';
        newCode.textContent = 'New code';
        newCode.setAttribute('aria-label', `Generate a new code for ${user.email}`);
        newCode.addEventListener('click', async () => {
          if (!window.confirm(`Generate a new code for ${user.email}? The previous code will stop working.`)) return;
          newCode.disabled = true;
          try {
            const result = await setAccess(user.email, true);
            showInvitation(result.invitation, user.email);
            get('admin-access-status').textContent = `New invitation code generated for ${user.email}.`;
            await refresh();
          } catch (err) {
            get('admin-access-status').textContent = err.message;
            newCode.disabled = false;
          }
        });
        actions.append(newCode);
      }
      actions.append(button);
      item.append(info, actions);
      list.append(item);
    });
  }

  function showStats(stats) {
    const statsElement = get('admin-stats');
    statsElement.replaceChildren();
    for (const [label, value] of [
      ['Registered hosts', stats.accounts],
      ['Active rooms', stats.activeRooms],
      ['Connected players', stats.connectedPlayers],
      ['Saved lots', stats.savedLots]
    ]) {
      const line = document.createElement('div');
      line.textContent = `${label}: ${value}`;
      statsElement.append(line);
    }
  }

  async function refresh(loadSettings = false) {
    const data = await request('/api/admin', { cache: 'no-store' });
    if (loadSettings) {
      get('admin-banner').value = data.banner;
      get('admin-banner-enabled').checked = data.bannerEnabled;
      get('admin-registration').checked = data.registrationOpen;
      get('admin-maintenance').checked = data.maintenance;
    }
    showUsers(data.users);
    showStats(data.stats);
    error.textContent = '';
  }

  function setAccess(email, enabled) {
    return request('/api/admin/access', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, enabled })
    });
  }

  get('admin-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = get('admin-settings-status');
    status.textContent = '';
    try {
      await request('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          banner: get('admin-banner').value,
          bannerEnabled: get('admin-banner-enabled').checked,
          registrationOpen: get('admin-registration').checked,
          maintenance: get('admin-maintenance').checked
        })
      });
      status.textContent = 'Site settings saved. The notice updates within 15 seconds.';
    } catch (err) {
      status.textContent = err.message;
    }
  });

  get('admin-access-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = get('admin-email');
    const status = get('admin-access-status');
    status.textContent = '';
    try {
      const result = await setAccess(input.value, true);
      showInvitation(result.invitation, input.value.trim());
      status.textContent = `Access enabled for ${input.value.trim()}.`;
      input.value = '';
      await refresh();
    } catch (err) {
      status.textContent = err.message;
    }
  });

  get('admin-refresh').addEventListener('click', () => {
    refresh().catch((err) => { error.textContent = err.message; });
  });

  request('/api/auth/session', { cache: 'no-store' }).then(async ({ user }) => {
    if (!user?.isAdmin) return;
    await refresh(true);
    panel.hidden = false;
  }).catch((err) => {
    get('page-error').textContent = `Could not load site administration: ${err.message}`;
  });
})();
