'use strict';
// Bluetooth Low Energy steering input.
//
// The computer acts as a BLE *peripheral* through BlueZ on the system D-Bus (no root, no raw HCI):
// we export a GATT application (one service, one writable "steer" characteristic) plus an LE
// advertisement, and register both on the adapter. The phone (Chrome Web Bluetooth, a BLE
// central) connects and writes one signed byte ~30 times/second.
//
// The phone counts as a connected controller while writes keep arriving (CONNECTED_TIMEOUT_MS).
// See docs/ARCHITECTURE.md for the GATT contract.

const dbus = require('dbus-next');

const { Interface, ACCESS_READ } = dbus.interface;
const { Message, Variant, DBusError } = dbus;

const SERVICE_UUID = '8f1c0a20-5b7e-4d2a-9c3e-1a2b3c4d5e60';
const STEER_UUID = '8f1c0a21-5b7e-4d2a-9c3e-1a2b3c4d5e60';
const LOCAL_NAME = 'Cami';

const CONNECTED_TIMEOUT_MS = 1500; // no write for this long -> the BLE controller is gone
const WATCHDOG_MS = 5000; // re-check registration / advertising this often

const BLUEZ = 'org.bluez';
const APP_PATH = '/cami/driving';
const SERVICE_PATH = APP_PATH + '/service0';
const CHAR_PATH = SERVICE_PATH + '/char0';
const ADV_PATH = APP_PATH + '/adv0';

const GATT_SERVICE_IFACE = 'org.bluez.GattService1';
const GATT_CHAR_IFACE = 'org.bluez.GattCharacteristic1';
const ADV_IFACE = 'org.bluez.LEAdvertisement1';
const ADAPTER_IFACE = 'org.bluez.Adapter1';
const GATT_MANAGER_IFACE = 'org.bluez.GattManager1';
const ADV_MANAGER_IFACE = 'org.bluez.LEAdvertisingManager1';
const DEVICE_IFACE = 'org.bluez.Device1';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const OM_IFACE = 'org.freedesktop.DBus.ObjectManager';

// int8 byte -> steer in -1..1
function byteToSteer(b) {
  const s = b > 127 ? b - 256 : b;
  return Math.max(-1, Math.min(1, s / 127));
}

// ---------------------------------------------------------------------------
// Exported D-Bus objects
// ---------------------------------------------------------------------------

class GattService extends Interface {
  constructor() {
    super(GATT_SERVICE_IFACE);
  }
  get UUID() {
    return SERVICE_UUID;
  }
  get Primary() {
    return true;
  }
}
GattService.configureMembers({
  properties: {
    UUID: { signature: 's', access: ACCESS_READ },
    Primary: { signature: 'b', access: ACCESS_READ },
  },
});

class SteerCharacteristic extends Interface {
  constructor(onWrite) {
    super(GATT_CHAR_IFACE);
    this.onWrite = onWrite;
  }
  get UUID() {
    return STEER_UUID;
  }
  get Service() {
    return SERVICE_PATH;
  }
  get Flags() {
    return ['write-without-response', 'write'];
  }
  WriteValue(value, options) {
    const offset = options && options.offset ? Number(options.offset.value) : 0;
    if (offset !== 0) throw new DBusError('org.bluez.Error.InvalidOffset', 'offset must be 0');
    if (!value || value.length < 1) throw new DBusError('org.bluez.Error.InvalidValueLength', 'expected 1 byte');
    const device = options && options.device ? String(options.device.value) : null;
    this.onWrite(value[0], device);
  }
}
SteerCharacteristic.configureMembers({
  properties: {
    UUID: { signature: 's', access: ACCESS_READ },
    Service: { signature: 'o', access: ACCESS_READ },
    Flags: { signature: 'as', access: ACCESS_READ },
  },
  methods: {
    WriteValue: { inSignature: 'aya{sv}', outSignature: '' },
  },
});

class Advertisement extends Interface {
  constructor(onRelease) {
    super(ADV_IFACE);
    this.onRelease = onRelease;
  }
  get Type() {
    return 'peripheral';
  }
  get ServiceUUIDs() {
    return [SERVICE_UUID];
  }
  get LocalName() {
    return LOCAL_NAME;
  }
  get Discoverable() {
    return true;
  }
  Release() {
    this.onRelease();
  }
}
Advertisement.configureMembers({
  properties: {
    Type: { signature: 's', access: ACCESS_READ },
    ServiceUUIDs: { signature: 'as', access: ACCESS_READ },
    LocalName: { signature: 's', access: ACCESS_READ },
    Discoverable: { signature: 'b', access: ACCESS_READ },
  },
  methods: {
    Release: { inSignature: '', outSignature: '' },
  },
});

// BlueZ discovers the GATT hierarchy through ObjectManager.GetManagedObjects on the app root.
class ObjectManager extends Interface {
  constructor(objects) {
    super(OM_IFACE);
    this.objects = objects; // [{ path, iface }]
  }
  GetManagedObjects() {
    const out = {};
    for (const { path, iface } of this.objects) {
      const props = {};
      for (const [name, opt] of Object.entries(iface.$properties)) {
        props[name] = new Variant(opt.signature, iface[name]);
      }
      out[path] = Object.assign(out[path] || {}, { [iface.$name]: props });
    }
    return out;
  }
}
ObjectManager.configureMembers({
  methods: {
    GetManagedObjects: { inSignature: '', outSignature: 'a{oa{sa{sv}}}' },
  },
});

// ---------------------------------------------------------------------------
// Peripheral
// ---------------------------------------------------------------------------

/**
 * Start the BLE peripheral. Never throws: if BlueZ or the adapter is unavailable it logs a
 * warning and keeps retrying quietly in the background.
 *
 * @param {object} opts
 * @param {(value:number) => void} opts.onSteer - steer value -1..1 for every write
 * @param {(connected:boolean) => void} opts.onConnectedChange - BLE controller came/went
 * @param {string} [opts.adapter] - adapter name, default env BLE_ADAPTER or the first one (hci0)
 * @returns {{ stop: () => Promise<void>, status: () => object }}
 */
function startBle({ onSteer, onConnectedChange, adapter = process.env.BLE_ADAPTER, log = console.log } = {}) {
  const warn = (msg) => log(`[ble] WARNING: ${msg}`);
  const info = (msg) => log(`[ble] ${msg}`);

  const state = {
    bus: null,
    adapterPath: null,
    powered: false,
    appRegistered: false,
    advRegistered: false,
    connected: false, // the BLE controller, by write timeout (source of truth)
    lastWriteAt: 0,
    device: null, // D-Bus path of the device that last wrote, when BlueZ tells us
    lastProblem: null, // last warning text, so retries don't spam the log
    stopped: false,
    busy: null, // in-flight sync() promise
    again: false, // sync() requested while one was running
    forceAdv: false,
    forceApp: false,
  };
  let timeoutTimer = null;
  let watchdog = null;

  function problem(msg) {
    if (state.lastProblem === msg) return;
    state.lastProblem = msg;
    warn(`${msg} - Bluetooth steering is off; the Wi-Fi controller still works.`);
  }

  // --- the virtual controller ------------------------------------------------

  function onWrite(byte, device) {
    if (state.stopped) return;
    state.lastWriteAt = Date.now();
    if (device) state.device = device;
    if (!state.connected) {
      state.connected = true;
      info(`phone connected${device ? ` (${device.split('/').pop()})` : ''}`);
      onConnectedChange(true);
    }
    clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(dropController, CONNECTED_TIMEOUT_MS);
    onSteer(byteToSteer(byte));
  }

  function dropController() {
    clearTimeout(timeoutTimer);
    if (!state.connected) return;
    state.connected = false;
    info('phone disconnected (no steering for 1.5 s)');
    onConnectedChange(false);
  }

  // --- D-Bus helpers ---------------------------------------------------------

  function call(dest, path, iface, member, signature = '', body = []) {
    return state.bus.call(new Message({ destination: dest, path, interface: iface, member, signature, body }));
  }

  async function getProp(path, iface, name) {
    const reply = await call(BLUEZ, path, PROPS_IFACE, 'Get', 'ss', [iface, name]);
    return reply.body[0].value;
  }

  const isErr = (err, name) => err && err.type === name;
  const errText = (err) => (err && (err.type ? `${err.type}: ${err.text || err.message}` : err.message)) || String(err);

  async function findAdapter() {
    const reply = await call(BLUEZ, '/', OM_IFACE, 'GetManagedObjects');
    const objects = reply.body[0];
    const candidates = Object.keys(objects)
      .filter((p) => objects[p][ADAPTER_IFACE] && objects[p][GATT_MANAGER_IFACE] && objects[p][ADV_MANAGER_IFACE])
      .sort();
    if (adapter) return candidates.find((p) => p.endsWith('/' + adapter)) || null;
    return candidates[0] || null;
  }

  async function registerApp() {
    try {
      await call(BLUEZ, state.adapterPath, GATT_MANAGER_IFACE, 'RegisterApplication', 'oa{sv}', [APP_PATH, {}]);
    } catch (err) {
      if (!isErr(err, 'org.bluez.Error.AlreadyExists')) throw err;
    }
    state.appRegistered = true;
  }

  async function registerAdv() {
    try {
      await call(BLUEZ, state.adapterPath, ADV_MANAGER_IFACE, 'RegisterAdvertisement', 'oa{sv}', [ADV_PATH, {}]);
    } catch (err) {
      if (!isErr(err, 'org.bluez.Error.AlreadyExists')) throw err;
    }
    state.advRegistered = true;
  }

  async function unregisterAdv() {
    state.advRegistered = false;
    try {
      await call(BLUEZ, state.adapterPath, ADV_MANAGER_IFACE, 'UnregisterAdvertisement', 'o', [ADV_PATH]);
    } catch {}
  }

  async function unregisterApp() {
    state.appRegistered = false;
    try {
      await call(BLUEZ, state.adapterPath, GATT_MANAGER_IFACE, 'UnregisterApplication', 'o', [APP_PATH]);
    } catch {}
  }

  // --- bring the registration in line with reality (serialized) -------------

  function sync() {
    if (state.stopped || !state.bus) return Promise.resolve();
    if (state.busy) {
      state.again = true;
      return state.busy;
    }
    state.busy = (async () => {
      do {
        state.again = false;
        try {
          await syncOnce();
        } catch (err) {
          problem(`could not register with BlueZ (${errText(err)})`);
        }
      } while (state.again && !state.stopped);
    })().finally(() => (state.busy = null));
    return state.busy;
  }

  async function syncOnce() {
    let path;
    try {
      path = await findAdapter();
    } catch (err) {
      state.adapterPath = null;
      state.appRegistered = state.advRegistered = false;
      problem(`BlueZ is not reachable (${errText(err)}); is the bluetooth service running?`);
      return;
    }
    if (!path) {
      state.adapterPath = null;
      state.appRegistered = state.advRegistered = false;
      problem(`no Bluetooth LE adapter${adapter ? ` named ${adapter}` : ''} found`);
      return;
    }
    if (path !== state.adapterPath) {
      state.adapterPath = path;
      state.appRegistered = state.advRegistered = false;
    }
    state.powered = await getProp(path, ADAPTER_IFACE, 'Powered');
    if (!state.powered) {
      // BlueZ drops advertisements on power-off; re-register everything once it is back.
      state.appRegistered = state.advRegistered = false;
      problem(`Bluetooth adapter ${path.split('/').pop()} is powered off (turn Bluetooth on)`);
      return;
    }

    if (state.forceApp) {
      state.forceApp = false;
      await unregisterApp();
    }
    if (state.forceAdv) {
      state.forceAdv = false;
      await unregisterAdv();
    }
    const fresh = !state.appRegistered || !state.advRegistered;
    if (!state.appRegistered) await registerApp();
    if (!state.advRegistered) await registerAdv();

    // A registered advertisement that BlueZ is not actually running (e.g. after a disconnect
    // or a controller reset) shows up as ActiveInstances == 0: register it again.
    const active = await getProp(path, ADV_MANAGER_IFACE, 'ActiveInstances');
    if (active === 0) {
      await unregisterAdv();
      await registerAdv();
    }
    if (fresh || state.lastProblem) {
      state.lastProblem = null;
      info(`advertising as "${LOCAL_NAME}" on ${path.split('/').pop()} (service ${SERVICE_UUID})`);
    }
  }

  // --- BlueZ events ------------------------------------------------------------

  function onMessage(msg) {
    if (msg.type !== dbus.MessageType.SIGNAL || state.stopped) return;
    const { path, member } = msg;
    const iface = msg.interface;

    if (iface === 'org.freedesktop.DBus' && member === 'NameOwnerChanged' && msg.body[0] === BLUEZ) {
      state.appRegistered = state.advRegistered = false;
      if (msg.body[2]) {
        info('bluetooth service (re)started; registering again');
        setTimeout(sync, 500);
      } else {
        problem('the bluetooth service stopped');
      }
      return;
    }
    if (iface === OM_IFACE && member === 'InterfacesAdded') {
      if (msg.body[1][ADAPTER_IFACE]) setTimeout(sync, 500);
      return;
    }
    if (iface === OM_IFACE && member === 'InterfacesRemoved') {
      if (msg.body[0] === state.adapterPath && msg.body[1].includes(ADAPTER_IFACE)) {
        state.adapterPath = null;
        state.appRegistered = state.advRegistered = false;
        problem('the Bluetooth adapter was removed');
      }
      return;
    }
    if (iface === PROPS_IFACE && member === 'PropertiesChanged') {
      const [changedIface, changed] = msg.body;
      if (changedIface === ADAPTER_IFACE && path === state.adapterPath && changed.Powered) {
        const powered = changed.Powered.value;
        if (powered === state.powered) return;
        state.powered = powered;
        if (powered) {
          info('Bluetooth adapter powered on; registering again');
          state.forceApp = state.forceAdv = true;
          setTimeout(sync, 300);
        } else {
          state.appRegistered = state.advRegistered = false;
          problem('Bluetooth adapter powered off (turn Bluetooth on)');
        }
      } else if (changedIface === DEVICE_IFACE && changed.Connected && path.startsWith(state.adapterPath + '/')) {
        // Informational only; the write timeout decides whether the phone is "connected".
        const dev = path.split('/').pop();
        if (changed.Connected.value) {
          info(`device ${dev} connected`);
        } else {
          info(`device ${dev} disconnected`);
          if (path === state.device) dropController(); // our phone: don't wait for the timeout
          // Make sure we are advertising again so the phone can reconnect.
          setTimeout(sync, 1000);
        }
      }
    }
  }

  async function addMatch(rule) {
    await call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [rule]);
  }

  // --- start -------------------------------------------------------------------

  (async () => {
    let bus;
    try {
      bus = dbus.systemBus();
    } catch (err) {
      problem(`cannot connect to the system D-Bus (${errText(err)})`);
      return;
    }
    state.bus = bus;
    bus.on('error', (err) => {
      problem(`system D-Bus error (${errText(err)})`);
    });
    bus.on('message', onMessage);

    const char = new SteerCharacteristic(onWrite);
    const service = new GattService();
    const adv = new Advertisement(() => {
      state.advRegistered = false;
      info('BlueZ released the advertisement');
      if (!state.stopped) setTimeout(sync, 1000);
    });
    const om = new ObjectManager([
      { path: SERVICE_PATH, iface: service },
      { path: CHAR_PATH, iface: char },
    ]);
    try {
      bus.export(APP_PATH, om);
      bus.export(SERVICE_PATH, service);
      bus.export(CHAR_PATH, char);
      bus.export(ADV_PATH, adv);
      await addMatch(`type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BLUEZ}'`);
      await addMatch(`type='signal',sender='${BLUEZ}',interface='${PROPS_IFACE}',member='PropertiesChanged'`);
      await addMatch(`type='signal',sender='${BLUEZ}',interface='${OM_IFACE}'`);
    } catch (err) {
      problem(`cannot use the system D-Bus (${errText(err)})`);
      return;
    }
    if (state.stopped) return;
    await sync();
    watchdog = setInterval(sync, WATCHDOG_MS);
    watchdog.unref();
  })().catch((err) => problem(`unexpected error (${errText(err)})`));

  // --- stop --------------------------------------------------------------------

  async function stop() {
    if (state.stopped) return;
    state.stopped = true;
    clearInterval(watchdog);
    clearTimeout(timeoutTimer);
    if (!state.bus) return;
    if (state.busy) await state.busy.catch(() => {});
    if (state.adapterPath) {
      if (state.advRegistered) await unregisterAdv();
      if (state.appRegistered) await unregisterApp();
    }
    try {
      state.bus.disconnect();
    } catch {}
  }

  function status() {
    return {
      adapter: state.adapterPath,
      advertising: state.advRegistered,
      gatt: state.appRegistered,
      connected: state.connected,
      busName: state.bus && state.bus.name,
    };
  }

  return { stop, status };
}

module.exports = { startBle, byteToSteer, SERVICE_UUID, STEER_UUID, LOCAL_NAME, CHAR_PATH, APP_PATH, ADV_PATH };
