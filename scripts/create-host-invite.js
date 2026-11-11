const { database, io, updateHostAccess, validEmail } = require('../server');

const email = (process.argv[2] || '').trim().toLowerCase();
if (process.argv.length !== 3 || !validEmail(email)) {
  console.error('Usage: node scripts/create-host-invite.js host@example.com');
  process.exitCode = 1;
} else if (database.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) {
  console.error('This email already has an account. Use site administration to manage its access.');
  process.exitCode = 1;
} else {
  const invitation = updateHostAccess(email, true);
  console.log(`Share this single-use code privately with ${email}:`);
  console.log(invitation.code);
  console.log(`Expires: ${new Date(invitation.expiresAt).toISOString()}`);
}
io.close();
database.close();
