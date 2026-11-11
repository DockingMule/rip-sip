# Going Once

A real-time auction party game for phones and desktops. One player creates a named auction room and shares its code; the auction name remains visible while it is running. Hosts can set a display name, profile picture, and Venmo link in their preferences; the saved Venmo link is shown to the winner from the result popup. Hosts can review completed lots grouped by auction and download either one auction's data or all lots as CSV. The host prepares an item and sets the starting bid and dollar bid increment (down to $0.01); both default to $1. Players can join and see the item before the host starts the auction. The host can end it at any time. Bids must follow the increment from the starting price. The host can also enable automatic closing with a start time (30, 20, or 15 seconds) and a bid time add (10, 7, or 5 seconds); a bid tops the clock back up to the bid time add only if less time than that remains. The highest bidder wins. The app does not process or verify payments.

## Run locally

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Open http://localhost:3000. To join from another device on the same network, open the host computer's local IP address on port 3000. For players outside your network, deploy the app to a publicly reachable Node.js host with WebSocket support.

Run the integration test with `npm test`.

## Host accounts

Only hosts need an account. Guests can join with a room code and display name without signing in. Creating a host account requires an invitation code for that email address. Codes are single-use, expire after seven days, and must be shared privately with the intended host. The site does not send emails or verify email ownership.

To create an invitation from the server (including for the first administrator), run:

```sh
node scripts/create-host-invite.js host@example.com
```

Run the command with the same `DATABASE_PATH` as the server. It prints a code once; send it through a trusted private channel. Issuing another code for the same address invalidates the previous one. Registration must be open for the code to be used. The app does not provide password resets.

Accounts, invitations, site settings, and sign-in sessions are stored in `data/going-once.sqlite` by default. Set `DATABASE_PATH` to use another SQLite file and keep that file on persistent storage when deploying. Serve the app over HTTPS in production; production session cookies are marked secure. If a host leaves, an invited host in the room can take over; otherwise the room closes so anonymous guests do not gain host controls.

Existing email-only invitations, including addresses seeded by `HOST_INVITE_EMAILS`, cannot be used to register until a code is issued from site administration or the server command above. `HOST_INVITE_EMAILS` still seeds access records but does not issue codes. Existing accounts remain enabled when upgrading unless an administrator disables them; this change cannot verify who originally registered them, so review existing accounts separately.

## Site administration

### First-time administrator setup

On a new server with an empty database:

1. In the project folder, install dependencies, leave `SITE_ADMIN_EMAIL` unset, generate an invitation code for your email, and start the server:

   ```sh
   npm install
   unset SITE_ADMIN_EMAIL
   node scripts/create-host-invite.js admin@email.com
   npm start
   ```

2. Copy the printed code. Open the site, choose **Host a game → Create invited account**, and register with that email, the code, and a strong password. Use HTTPS on a public server.

3. Stop the server with `Ctrl+C`, then set the administrator email and restart:

   ```sh
   export SITE_ADMIN_EMAIL=admin@email.com
   npm start
   ```

Use your own email in both commands. Keep any other required environment variables (including `DATABASE_PATH`) the same when generating the code and starting the server. The server refuses to start if a configured administrator account does not already exist. `HOST_INVITE_EMAILS` is not required; once signed in as administrator, you can create future invitations in Site management.

Because email ownership is not verified by the app, register the account before enabling administration; the email address alone does not grant administrator access. The configured administrator sees Site management below host preferences and can:

- Show or hide a text-only site-wide announcement; open pages refresh it within 15 seconds.
- Invite email addresses with a code, generate replacement codes, re-enable accounts, or disable access. Share displayed codes privately; they are shown only when generated. Disabling an invitation invalidates its code. Disabling an existing account immediately invalidates its sessions and host controls; the account and its saved history remain available if re-enabled. Guests can still participate anonymously. The configured administrator cannot disable their own access.
- Open or close new host registration without affecting existing logins.
- Enable maintenance mode to block new room creation and joins for non-administrators. Connected players can continue an auction, and existing players can reconnect with their saved room credentials. Administrators may create and join rooms while maintenance is enabled.
- View registered-host, active-room, connected-player, and saved-lot counts. Room and player counts are for the running server instance.

The administrator should disable accounts through this page rather than by editing the environment. The banner, access list, registration state, and maintenance mode persist across restarts.

Hosts can upload JPEG, PNG, GIF, or WebP item images up to 5 MB, choose a stock image, or provide an image URL. Signed-in players' profile pictures are visible to everyone in their room; players without pictures use initials. Profile pictures and completed-lot records are stored in SQLite. Rooms and item images are stored in server memory and are cleared when the room closes or the server restarts. Room codes are intended for casual play, not private auctions.

Hosts can delete their saved lots for an auction from Past lots after confirming. This does not affect a live room or another host's records; if the auction is still running, future completed lots will appear again.