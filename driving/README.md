# Cami Driving

A tiny driving game for a 4-year-old. The game runs on the computer; the phone is the steering wheel.

## Run

```sh
npm install   # once
npm start
```

The server prints a banner with the two addresses (and a QR code):

- **Computer:** open <http://localhost:8080>
- **Phone:** open `https://<computer-ip>:8443/controller` in Chrome, e.g. `https://192.168.1.3:8443/controller`.
  It prefers the Wi-Fi address and lists the others in case one doesn't work. The game's waiting screen also shows a QR code for it.

## Connect the phone (dad)

1. Phone and computer on the same Wi-Fi.
2. Open the controller URL in Chrome (scan the QR code or type it).
3. Chrome warns "Your connection is not private". Tap **Advanced → Proceed to … (unsafe)**. The certificate is self-signed and only used on your LAN. HTTPS is needed because Chrome only lets pages read the motion sensors over a secure connection.
4. Tap the big green button. That makes the page fullscreen, locks it to landscape and keeps the screen awake.
5. Hand over the phone sideways, screen facing her, like a steering wheel. Turning it clockwise steers right. Full lock is about 38°, with a small dead zone around straight.

"Straight" means the phone is level (absolute, no calibration). To make a different position count as straight, **long-press the ⚙ in the top-right corner**. You get *Set straight = current position*, *Reset: straight = level*, a fullscreen button, and live sensor readings.

The tiny dot in the top-left corner shows the status: green means connected with sensor data, orange means connected but no sensor data or not started, red means disconnected (it reconnects by itself).

## Troubleshooting

- **The phone can't open the page.** Check that both devices are on the same Wi-Fi, and try the other URLs from the banner. Make sure the firewall allows TCP 8443, e.g. `sudo ufw allow 8443/tcp`. Some guest networks isolate devices from each other.
- **"Steering sensor not working" message.** You must use the `https://…:8443` URL; plain `http` won't work. In Chrome go to **⋮ → Settings → Site settings → Motion sensors**, allow it, and make sure the site isn't in the Blocked list. Then reload.
- **The wheel works but the car doesn't move.** Check that the game tab on the computer is open at `http://localhost:8080`; its status should show the controller as connected. If the phone screen turns off, the game sees the controller drop within about 3 s. Turn the screen back on and tap the wheel once to go fullscreen again.
- **Steering is reversed or off-center.** Long-press ⚙ and use *Reset: straight = level*. If the screen didn't rotate to landscape, enable auto-rotate on the phone or tap the wheel to re-enter fullscreen.
- **The computer's IP changed.** Restart the server. It regenerates the certificate when the set of LAN IPs changes, so you'll have to accept the warning again on the phone.
- **Ports.** Override them with `HTTP_PORT=… HTTPS_PORT=… npm start`. The controller page assumes 8443 only for its "open via https" hint.

## Layout

- `server.js`: HTTP :8080 and HTTPS :8443 serving `public/`, the WebSocket relay at `/ws`, `/info` and `/qr.svg`. The certificate lives in `certs/`, which is gitignored.
- `public/controller.html`: the phone steering wheel.
- `public/js/net.js`: the game's connection to the server (`Net.connect(onSteer, onControllerStatus)`).
- `public/index.html` and `public/js/{game,art,sounds}.js`: the game.
- `docs/ARCHITECTURE.md` has the protocol; `docs/GAME_DESIGN.md` has the game.
