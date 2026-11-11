# Going Once

A real-time auction party game for phones and desktops. One player creates a room and shares its code. The host can optionally add a Venmo link when creating the room; the winner can open it from the result popup. The host prepares an item and sets the dollar bid increment (down to $0.01). Players can join and see the item before the host starts the auction. The host can end it at any time. Bids must follow the increment from the starting price. The host can also enable automatic closing with a start time (30, 20, or 15 seconds) and a bid time add (10, 7, or 5 seconds); a bid tops the clock back up to the bid time add only if less time than that remains. The highest bidder wins. The app does not process or verify payments.

## Run locally

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Open http://localhost:3000. To join from another device on the same network, open the host computer's local IP address on port 3000. For players outside your network, deploy the app to a publicly reachable Node.js host with WebSocket support.

Run the integration test with `npm test`.

Hosts can upload JPEG, PNG, GIF, or WebP images up to 5 MB, choose a stock image, or provide an image URL. Uploaded images and rooms are stored in server memory and are cleared when the room closes or the server restarts. Room codes are intended for casual play, not private or authenticated sessions.