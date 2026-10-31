'use strict';
// Cami Driving server.
// - HTTP  :8080 -> the game, for the computer (http://localhost:8080/)
// - HTTPS :8443 -> the phone steering wheel (https://<lan-ip>:8443/controller)
// - WebSocket /ws on both ports, one shared hub that relays controller steering to displays.
// See docs/ARCHITECTURE.md for the contract.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, 'certs');

const HEARTBEAT_INTERVAL_MS = 1000; // ping every second
const HEARTBEAT_TIMEOUT_MS = 3000; // no pong/message for 3s -> drop the client
const STALE_STEER_MS = 1000; // controller connected but silent for 1s -> tell displays steer 0

// ---------------------------------------------------------------------------
// LAN addresses
// ---------------------------------------------------------------------------

const VIRTUAL_IFACE = /^(lo|docker|br-|lxdbr|lxcbr|lxc|veth|virbr|vmnet|vboxnet|tun|tap|wg|zt|tailscale|cni|flannel|cali|podman|kube|ham|utun|awdl|llw|bridge)/i;
const WIFI_IFACE = /^(wl|wlan|wifi|wi-fi|ath|ra\d)/i;
const WIRED_IFACE = /^(en|eth|em\d|eno|ens|enp)/i;

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local
      const rank = WIFI_IFACE.test(name) ? 0 : WIRED_IFACE.test(name) ? 1 : 2;
      out.push({ name, address: a.address, rank });
    }
  }
  out.sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name));
  // de-duplicate while preserving preference order
  const seen = new Set();
  return out.filter((x) => (seen.has(x.address) ? false : seen.add(x.address)));
}

const LAN = lanAddresses();
const controllerUrls = LAN.map((x) => `https://${x.address}:${HTTPS_PORT}/controller`);
const controllerUrl = controllerUrls[0] || `https://localhost:${HTTPS_PORT}/controller`;

// ---------------------------------------------------------------------------
// Self-signed certificate (generated once, regenerated when the IP set changes)
// ---------------------------------------------------------------------------

function ensureCert() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'meta.json');
  const ips = [...new Set(['127.0.0.1', ...LAN.map((x) => x.address)])].sort();
  const wanted = JSON.stringify({ v: 2, ips, dns: ['localhost'] });

  let current = null;
  try {
    current = fs.readFileSync(metaFile, 'utf8');
  } catch {}
  if (current === wanted && fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',');
  console.log(`Generating self-signed certificate for ${san} ...`);
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '825',
      '-keyout', keyFile,
      '-out', certFile,
      '-subj', '/CN=cami-driving',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'extendedKeyUsage=serverAuth',
      // Leaf cert, not a CA: Chrome on Android rejects self-signed CA certs used as the server cert.
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  fs.writeFileSync(metaFile, wanted);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

// ---------------------------------------------------------------------------
// Static files + small API
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

let qrSvgCache = null;

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleRequest(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'text/plain; charset=utf-8', 'Bad request');
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
  }

  if (pathname === '/info') {
    return send(
      res,
      200,
      'application/json; charset=utf-8',
      JSON.stringify({
        controllerUrl,
        controllerUrls,
        gameUrl: `http://localhost:${HTTP_PORT}/`,
        controllers: hub.controllers.size,
        displays: hub.displays.size,
      })
    );
  }

  if (pathname === '/qr.svg') {
    try {
      if (!qrSvgCache) {
        qrSvgCache = await QRCode.toString(controllerUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      }
      return send(res, 200, 'image/svg+xml', qrSvgCache);
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', 'QR error: ' + err.message);
    }
  }

  if (pathname === '/controller' || pathname === '/controller/') pathname = '/controller.html';
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// WebSocket hub
// ---------------------------------------------------------------------------

const hub = {
  displays: new Set(),
  controllers: new Set(),
  lastSteer: 0,
  lastSteerAt: 0,
  lastAnnounced: null,
};

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastDisplays(obj) {
  const msg = JSON.stringify(obj);
  for (const d of hub.displays) if (d.readyState === WebSocket.OPEN) d.send(msg);
}

// Sent to displays whenever the number of connected controllers changes.
function announceControllerStatus() {
  const count = hub.controllers.size;
  if (count === hub.lastAnnounced) return;
  hub.lastAnnounced = count;
  const connected = count > 0;
  if (!connected && hub.lastSteer !== 0) {
    hub.lastSteer = 0;
    broadcastDisplays({ type: 'steer', value: 0 });
  }
  broadcastDisplays({ type: 'controller', connected });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  let role = 'display';
  try {
    role = new URL(req.url, 'http://x').searchParams.get('role') === 'controller' ? 'controller' : 'display';
  } catch {}
  ws.role = role;
  ws.lastSeen = Date.now();
  ws.remote = req.socket.remoteAddress;

  ws.on('pong', () => (ws.lastSeen = Date.now()));

  if (role === 'controller') {
    hub.controllers.add(ws);
    console.log(`[ws] controller connected from ${ws.remote} (${hub.controllers.size} total)`);
    announceControllerStatus();
    ws.on('message', (data, isBinary) => {
      ws.lastSeen = Date.now();
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || msg.type !== 'steer') return;
      let v = Number(msg.value);
      if (!Number.isFinite(v)) return;
      v = Math.max(-1, Math.min(1, v));
      // Multiple controllers: latest message wins.
      hub.lastSteer = v;
      hub.lastSteerAt = Date.now();
      broadcastDisplays({ type: 'steer', value: v });
    });
  } else {
    hub.displays.add(ws);
    console.log(`[ws] display connected from ${ws.remote} (${hub.displays.size} total)`);
    sendJson(ws, { type: 'controller', connected: hub.controllers.size > 0 });
    if (hub.controllers.size > 0) sendJson(ws, { type: 'steer', value: hub.lastSteer });
    ws.on('message', () => (ws.lastSeen = Date.now()));
  }

  ws.on('close', () => {
    if (ws.role === 'controller') {
      if (hub.controllers.delete(ws)) {
        console.log(`[ws] controller disconnected (${hub.controllers.size} left)`);
        announceControllerStatus();
      }
    } else if (hub.displays.delete(ws)) {
      console.log(`[ws] display disconnected (${hub.displays.size} left)`);
    }
  });
  ws.on('error', () => {});
});

// Heartbeat: ping everyone every second; drop anyone silent for ~3s (phone screen off,
// Wi-Fi dropped, tab killed...) so displays learn about lost controllers quickly.
// The timer ticks 4x/s so timeouts and stale steering are noticed promptly; pings go out 1x/s.
let lastPingAt = 0;
setInterval(() => {
  const now = Date.now();
  const doPing = now - lastPingAt >= HEARTBEAT_INTERVAL_MS;
  if (doPing) lastPingAt = now;
  for (const ws of wss.clients) {
    if (now - ws.lastSeen > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[ws] ${ws.role} ${ws.remote} timed out (no heartbeat)`);
      ws.terminate(); // emits 'close' -> hub bookkeeping
      continue;
    }
    if (doPing) {
      try {
        ws.ping();
      } catch {}
    }
  }
  // A connected controller that stopped sending (e.g. tab frozen but socket alive):
  // don't leave the car turning forever.
  if (hub.lastSteer !== 0 && now - hub.lastSteerAt > STALE_STEER_MS) {
    hub.lastSteer = 0;
    broadcastDisplays({ type: 'steer', value: 0 });
  }
}, 250).unref();

function attachWs(server) {
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {}
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`${label} port ${port} is already in use (is another copy of the server running?)`));
      } else reject(err);
    });
    server.listen(port, '0.0.0.0', resolve);
  });
}

async function main() {
  let tls;
  try {
    tls = ensureCert();
  } catch (err) {
    console.error('Could not create the HTTPS certificate (is openssl installed?):', err.message);
    process.exit(1);
  }

  const handler = (req, res) => {
    handleRequest(req, res).catch((err) => {
      try {
        send(res, 500, 'text/plain; charset=utf-8', 'Server error: ' + err.message);
      } catch {}
    });
  };
  const httpServer = http.createServer(handler);
  const httpsServer = https.createServer(tls, handler);
  attachWs(httpServer);
  attachWs(httpsServer);

  try {
    await listen(httpServer, HTTP_PORT, 'HTTP');
    await listen(httpsServer, HTTPS_PORT, 'HTTPS');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const line = '='.repeat(66);
  console.log('\n' + line);
  console.log('  CAMI DRIVING is running!');
  console.log(line);
  console.log(`\n  1) On THIS computer, open:   http://localhost:${HTTP_PORT}`);
  console.log(`\n  2) On the PHONE (same Wi-Fi), open in Chrome:\n\n       ${controllerUrl}\n`);
  console.log('     The phone will warn about the certificate: tap "Advanced" ->');
  console.log('     "Proceed to ... (unsafe)". That is expected (self-signed, LAN only).');
  if (controllerUrls.length > 1) {
    console.log('\n     If that address does not work, try:');
    for (const u of controllerUrls.slice(1)) console.log(`       ${u}`);
  }
  if (!LAN.length) console.log('\n     (No LAN address found - is this computer on Wi-Fi?)');
  try {
    const qr = await QRCode.toString(controllerUrl, { type: 'terminal', small: true });
    console.log('\n     Or scan this with the phone camera:\n');
    console.log(qr.replace(/^/gm, '     '));
  } catch {}
  console.log(line + '\n');
}

main();
