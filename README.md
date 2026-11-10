# Going Once

A real-time auction party game for phones and desktops. One player creates a room and shares its code. The host prepares an item and sets the dollar bid increment (down to $0.01). Players can join and see the item before the host starts the auction. The host can end it at any time. Bids must follow the increment from the starting price. The host can also enable automatic closing after 30 seconds without a bid; the countdown starts when the auction begins and resets after each accepted bid. The highest bidder wins. The app does not process payments.

## Run locally

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Open http://localhost:3000. To join from another device on the same network, open the host computer's local IP address on port 3000. For players outside your network, deploy the app to a publicly reachable Node.js host with WebSocket support.

Run the integration test with `npm test`.

Hosts can upload JPEG, PNG, GIF, or WebP images up to 5 MB, choose a stock image, or provide an image URL. Uploaded images and rooms are stored in server memory and are cleared when the room closes or the server restarts. Room codes are intended for casual play, not private or authenticated sessions.