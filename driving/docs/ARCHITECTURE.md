# Cami Driving — architecture

A tiny driving game for a 4-year-old who has never played a video game.
The game runs in a browser on the computer (big screen). A Google Pixel (Android, Chrome)
is the steering wheel: she holds it like a wheel and tilts/rotates it left and right.
Steering is the ONLY input.

## Pieces

```
            Wi-Fi LAN
 Pixel (Chrome)  ──wss://<lan-ip>:8443/ws──►  Node server (server.js)  ──ws://localhost:8080/ws──►  Game page (computer browser)
 /controller                                   relays steer messages                               /
```

- `server.js` (Node 24, run with `npm start`):
  - HTTP on port **8080** — the computer opens `http://localhost:8080/` (the game).
  - HTTPS on port **8443** with an auto-generated self-signed cert (SANs include all LAN IPs) —
    the phone opens `https://<lan-ip>:8443/controller`. HTTPS is required because Chrome on Android
    only exposes device orientation/motion sensors in a secure context. The phone shows a cert
    warning once ("Advanced → Proceed").
  - WebSocket endpoint `/ws` on BOTH ports, sharing one hub.
  - Serves static files from `public/`.
  - `GET /info` → `{ "controllerUrl": "https://192.168.1.3:8443/controller", "controllerUrls": [...] }`
  - `GET /qr.svg` → SVG QR code of `controllerUrl` (so dad can scan it from the game screen).
- `public/index.html` — the game (display). Canvas, full window.
- `public/controller.html` — the phone steering wheel page.

## WebSocket protocol (JSON text frames)

Clients identify themselves via query string: `/ws?role=display` or `/ws?role=controller`.

Controller → server:
- `{"type":"steer","value":<number -1..1>}` — sent ~30 times/second while connected.
  -1 = full left, 0 = straight, +1 = full right. Already smoothed, dead-zoned and clamped on the phone.

Server → display:
- `{"type":"steer","value":<number>}` — relayed from the (latest) controller.
- `{"type":"controller","connected":<bool>}` — sent on display connect and whenever the controller count changes.

Display behaviour without a controller: arrow keys / A-D steer (for dad testing), and the
waiting screen shows the QR code + URL.

## Game page module contract

Plain browser JS, no build step, no frameworks, no external network requests (works offline on the LAN).

- `public/js/net.js` — `Net.connect(onSteer(value), onControllerStatus(connected))`, auto-reconnects.
- `public/js/art.js` — all drawing (graphics agent). Pure canvas 2D drawing functions, no game logic.
- `public/js/sounds.js` — WebAudio-synthesized sounds, no audio files.
- `public/js/game.js` — game loop, state, input, uses the three above.

See `docs/GAME_DESIGN.md` for what the game actually is.
