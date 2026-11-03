# Cami Driving — architecture

A tiny driving game for a 4-year-old who has never played a video game.
The game runs in a browser on the computer (big screen). A Google Pixel (Android, Chrome)
is the steering wheel: she holds it like a wheel and tilts/rotates it left and right.
Steering is the ONLY input.

## Pieces

```
 Pixel (Chrome)                    Bluetooth LE (GATT write)
 controller.html from  ─────────────────────────────────────►  Node server (server.js + ble.js)  ──ws://localhost:8080/ws──►  Game page (computer browser)
 GitHub Pages           ──wss://<lan-ip>:8443/ws──► (fallback)  relays steer messages                                        /
```

Primary path: the phone loads `https://spalladino.github.io/cami-games/driving/controller.html`
(GitHub Pages publishes `public/`) and steers over Web Bluetooth. The computer is the BLE
*peripheral*. The Wi-Fi WebSocket path below still works but is a fallback (LAN inbound
connections were blocked on our network).

- `server.js` (Node 24, run with `npm start`):
  - HTTP on port **8080** — the computer opens `http://localhost:8080/` (the game).
  - HTTPS on port **8443** (Wi-Fi fallback) with an auto-generated self-signed cert (SANs include all LAN IPs) —
    the phone opens `https://<lan-ip>:8443/controller`. HTTPS is required because Chrome on Android
    only exposes device orientation/motion sensors in a secure context. The phone shows a cert
    warning once ("Advanced → Proceed").
  - WebSocket endpoint `/ws` on BOTH ports, sharing one hub.
  - Serves static files from `public/`.
  - `GET /info` → `{ "controllerUrl": "<GitHub Pages controller URL>", "controllerUrls": [pages, "https://<lan-ip>:8443/controller", ...], "bluetooth": {...} }`.
    `controllerUrl` can be overridden with env `CONTROLLER_URL`.
  - `GET /qr.svg` → SVG QR code of `controllerUrl` (so dad can scan it from the game screen).
- `ble.js` (required by server.js) — BLE peripheral via BlueZ on the system D-Bus (`dbus-next`, no root).
- `public/index.html` — the game (display). Canvas, full window.
- `public/controller.html` — the phone steering wheel page.

## Bluetooth LE (GATT contract)

- Service `8f1c0a20-5b7e-4d2a-9c3e-1a2b3c4d5e60`, characteristic "steer"
  `8f1c0a21-5b7e-4d2a-9c3e-1a2b3c4d5e60`, flags `write-without-response` + `write`, no pairing or encryption.
- Value: 2 bytes. Byte 0 is a signed int8; steer = byte / 127, clamped to -1..1. Byte 1 is the tap id: 0, except
  for 1 s after the smiley in the middle of the wheel is tapped, when it is a nonzero id that changes with every
  tap. A new nonzero id means "start the game" (a tap survives a few lost writes this way). A 1-byte write is
  steering only. The phone writes ~30 times/second.
- Advertisement: connectable, service UUID + local name `Cami`.
- `ble.js` exports the GATT app (ObjectManager at `/cami/driving`, service, characteristic) and an
  `LEAdvertisement1` (`/cami/driving/adv0`), and registers them on the first adapter (env `BLE_ADAPTER`
  to pick one). It re-registers when the adapter powers back on, when bluetoothd restarts, and when
  `ActiveInstances` drops to 0 (5 s watchdog); it unregisters on SIGINT/SIGTERM. If BlueZ is missing it
  logs a `[ble] WARNING` and the rest of the server runs as usual.
- Hub: the BLE phone is one virtual controller. It is connected while writes keep arriving
  (1.5 s timeout; also dropped at once if BlueZ reports that device disconnected). Writes go through the
  same steer relay as WebSocket controllers, and `controller` messages count WS + BLE controllers.

## WebSocket protocol (JSON text frames)

Clients identify themselves via query string: `/ws?role=display` or `/ws?role=controller`.

Controller → server:
- `{"type":"steer","value":<number -1..1>}` — sent ~30 times/second while connected.
  -1 = full left, 0 = straight, +1 = full right. Already smoothed, dead-zoned and clamped on the phone.
- `{"type":"start"}` — the smiley was tapped.

Server → display:
- `{"type":"steer","value":<number>}` — relayed from the (latest) controller.
- `{"type":"controller","connected":<bool>}` — sent on display connect and whenever the controller count changes.
- `{"type":"start"}` — a phone's smiley was tapped (over WebSocket or Bluetooth). The game starts if it is waiting.

Display behaviour without a controller: arrow keys / A-D steer (for dad testing), and the
waiting screen shows the QR code + URL (`controllerUrl`, i.e. the GitHub Pages page).

## Game page module contract

Plain browser JS, no build step, no frameworks, no external network requests (the game works offline; only the phone needs to load the controller page from GitHub Pages).

- `public/js/net.js` — `Net.connect(onSteer(value), onControllerStatus(connected), onStart())`, auto-reconnects.
- `public/js/art.js` — all drawing (graphics agent). Pure canvas 2D drawing functions, no game logic.
- `public/js/sounds.js` — WebAudio-synthesized sounds, no audio files.
- `public/js/game.js` — game loop, state, input, uses the three above.

See `docs/GAME_DESIGN.md` for what the game actually is.
