(() => {
  const notice = document.querySelector('#site-notice');
  async function refreshNotice() {
    try {
      const response = await fetch('/api/site', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Site status request failed (${response.status}).`);
      const { banner, maintenance } = await response.json();
      const messages = [];
      if (banner) messages.push(banner);
      if (maintenance) messages.push('Maintenance mode is on. New rooms and joins are temporarily unavailable except for administrators.');
      notice.textContent = messages.join('\n');
      notice.hidden = messages.length === 0;
    } catch (error) {
      console.error('Could not refresh the site notice:', error);
    }
  }
  refreshNotice();
  setInterval(refreshNotice, 15000);
})();
