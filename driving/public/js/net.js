// Net: connects the game (display) to the server's WebSocket hub and reports the phone's steering.
//
//   Net.connect(onSteer, onControllerStatus)
//     onSteer(value)                 value in -1..1 (-1 full left, 0 straight, +1 full right)
//     onControllerStatus(connected)  true when a phone controller is connected
//
//   Net.connected            true while the display's own socket to the server is open
//   Net.controllerConnected  true while a phone controller is connected
//   Net.steer                last steering value received (0 when no controller)
//
// Auto-reconnects with backoff. If the server connection drops while a controller was connected,
// it reports onSteer(0) and onControllerStatus(false) so the game falls back to keyboard control.
(function () {
  'use strict';

  var Net = {
    connected: false,
    controllerConnected: false,
    steer: 0,
    connect: connect,
  };

  var started = false;
  var ws = null;
  var retryMs = 500;
  var retryTimer = null;
  var cbSteer = function () {};
  var cbStatus = function () {};

  function safe(fn, arg) {
    try {
      fn(arg);
    } catch (e) {
      if (window.console) console.error('[Net] callback error', e);
    }
  }

  function setController(connected) {
    connected = !!connected;
    if (connected === Net.controllerConnected) return;
    Net.controllerConnected = connected;
    if (!connected && Net.steer !== 0) {
      Net.steer = 0;
      safe(cbSteer, 0);
    }
    safe(cbStatus, connected);
  }

  function scheduleReconnect() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      open();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  }

  function open() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var sock;
    try {
      sock = new WebSocket(proto + '//' + location.host + '/ws?role=display');
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = function () {
      if (sock !== ws) return;
      Net.connected = true;
      retryMs = 500;
    };

    sock.onmessage = function (ev) {
      if (sock !== ws || typeof ev.data !== 'string') return;
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'steer') {
        var v = Number(msg.value);
        if (!isFinite(v)) return;
        v = Math.max(-1, Math.min(1, v));
        Net.steer = v;
        safe(cbSteer, v);
      } else if (msg.type === 'controller') {
        setController(msg.connected);
      }
    };

    sock.onclose = function () {
      if (sock !== ws) return;
      ws = null;
      Net.connected = false;
      setController(false);
      scheduleReconnect();
    };

    sock.onerror = function () {
      // onclose follows and handles reconnecting.
    };
  }

  function connect(onSteer, onControllerStatus) {
    if (typeof onSteer === 'function') cbSteer = onSteer;
    if (typeof onControllerStatus === 'function') cbStatus = onControllerStatus;
    if (started) return Net;
    started = true;
    open();
    // Reconnect promptly when the tab comes back or the network returns.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !ws) {
        retryMs = 500;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        open();
      }
    });
    window.addEventListener('online', function () {
      if (!ws) open();
    });
    return Net;
  }

  window.Net = Net;
})();
