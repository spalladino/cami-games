# Cami Driving

A tiny driving game for a 4-year-old. The game runs on the computer; the phone is the steering wheel.

## Run

```sh
npm install   # once
npm start
```

The server prints a banner (and a QR code):

- **Computer:** open <http://localhost:8080>
- **Phone:** open <https://spalladino.github.io/cami-games/driving/controller.html> in Chrome. The game's waiting screen shows a QR code for it.

The phone steers over **Bluetooth Low Energy**: the computer advertises itself as `Cami` and the page, loaded from GitHub Pages, connects to it with Web Bluetooth. No Wi-Fi connection between phone and computer is needed. (Override the URL shown with `CONTROLLER_URL=… npm start`.)

## Connect the phone (dad)

1. Bluetooth on, on both the phone and the computer. Nothing needs to be paired.
2. Open the controller URL in Chrome (scan the QR code on the game screen, or type it).
3. Tap **Start**. Chrome shows a Bluetooth list; pick **Cami**. The first time, Android asks for the *Nearby devices* permission: allow it. The game notices the phone as soon as steering arrives.
4. The page goes fullscreen, locks to landscape and keeps the screen awake.
5. Hand over the phone sideways, screen facing her, like a steering wheel. Turning it clockwise steers right. Full lock is about 38°, with a small dead zone around straight.

The old Wi-Fi path still works as a fallback: the banner lists `https://<computer-ip>:8443/controller` URLs (self-signed certificate; accept the warning once).

"Straight" means the phone is level (absolute, no calibration). To make a different position count as straight, **long-press the ⚙ in the top-right corner**. You get *Set straight = current position*, *Reset: straight = level*, a fullscreen button, and live sensor readings.

The tiny dot in the top-left corner shows the status: green means connected and steering, yellow means connecting, red means disconnected (it reconnects by itself). The ⚙ panel also shows the transport, device, writes/s and last error, and has *Choose Bluetooth device…*.

## Troubleshooting

- **"Cami" doesn't show up in the Bluetooth list.** Check the server log: it says `[ble] advertising as "Cami" on hci0` when ready, or prints a `[ble] WARNING` with the reason (Bluetooth off, bluetooth service not running, no adapter). It re-registers by itself when Bluetooth is turned back on or the bluetooth service restarts. Check with `bluetoothctl show`: `ActiveInstances` should be at least 1. If the phone was paired with the computer before and acts oddly, remove the pairing on both sides.
- **The car stops reacting / the game shows the waiting screen.** The game counts the Bluetooth phone as connected while steering keeps arriving; after 1.5 s of silence (screen off, Chrome in the background, out of range) it drops it. Bring Chrome back to the front and tap Start again if needed.
- **Wi-Fi fallback: the phone can't open the page.** Check that both devices are on the same Wi-Fi, and try the other URLs from the banner. Make sure the firewall allows TCP 8443, e.g. `sudo ufw allow 8443/tcp`. Some guest networks isolate devices from each other.
- **"Steering sensor not working" message.** The page must be opened over `https` (the GitHub Pages URL, or the `https://…:8443` fallback); plain `http` won't work. In Chrome go to **⋮ → Settings → Site settings → Motion sensors**, allow it, and make sure the site isn't in the Blocked list. Then reload.
- **The wheel works but the car doesn't move.** Check that the game tab on the computer is open at `http://localhost:8080`; its status should show the controller as connected. If the phone screen turns off, the game sees the controller drop within a few seconds. Turn the screen back on and tap the wheel once to go fullscreen again.
- **Steering is reversed or off-center.** Long-press ⚙ and use *Reset: straight = level*. If the screen didn't rotate to landscape, enable auto-rotate on the phone or tap the wheel to re-enter fullscreen.
- **Wi-Fi fallback: the computer's IP changed.** Restart the server. It regenerates the certificate when the set of LAN IPs changes, so you'll have to accept the warning again on the phone.
- **Ports.** Override them with `HTTP_PORT=… HTTPS_PORT=… npm start`. The controller page assumes 8443 only for its "open via https" hint.

## Layout

- `server.js`: HTTP :8080 and HTTPS :8443 serving `public/`, the WebSocket relay at `/ws`, `/info` and `/qr.svg`. The certificate lives in `certs/`, which is gitignored.
- `ble.js`: the Bluetooth LE peripheral (GATT service + advertisement) through BlueZ on the system D-Bus, using `dbus-next`. No root needed.
- `public/controller.html`: the phone steering wheel (also published to GitHub Pages).
- `public/js/net.js`: the game's connection to the server (`Net.connect(onSteer, onControllerStatus)`).
- `public/index.html` and `public/js/{game,art,sounds}.js`: the game.
- `docs/ARCHITECTURE.md` has the protocol; `docs/GAME_DESIGN.md` has the game.
