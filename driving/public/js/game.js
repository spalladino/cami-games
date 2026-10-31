// Cami Driving — game loop, state, input and rules.
// The spec is docs/GAME_DESIGN.md; section numbers below refer to it.
// Uses three globals written elsewhere: Art (drawing), Sounds (audio), Net (phone steering).
//
// Dad helpers:
//   `            toggle the debug overlay (fps, steer, state, biome, controller)
//   ?speed=4     run game time 4x faster (biome changes every 75/4 s)
//   ?biome=night start in another biome (meadow | beach | town | night)
//   ?debug=1     start with the debug overlay on
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants (section 2, 3, 4, 6)
  // ---------------------------------------------------------------------------

  var BIOMES = ['meadow', 'beach', 'town', 'night'];
  var TREAT_OF = { meadow: 'strawberry', beach: 'starfish', town: 'balloon', night: 'star' };
  var PROPS_OF = {
    meadow: ['tree', 'bush', 'flowers', 'cow'],
    beach: ['palm', 'umbrella', 'sandcastle'],
    town: ['house', 'roundTree', 'lamppost'],
    night: ['houseLit', 'lamppostOn', 'pine'],
  };
  // Prop widths in R (spec: 0.25–0.6 per kind).
  var PROP_SIZE = {
    tree: 0.5, bush: 0.3, flowers: 0.25, cow: 0.4,
    palm: 0.55, umbrella: 0.4, sandcastle: 0.35, boat: 0.45,
    house: 0.6, roundTree: 0.45, lamppost: 0.25,
    houseLit: 0.6, lamppostOn: 0.25, pine: 0.45,
  };
  var LANES = [-0.3, 0, 0.3];

  var CRUISE = 0.8;               // R/s forward speed on the road
  var SHOULDER_FACTOR = 0.65;     // speed factor on the shoulder
  var STEER_SMOOTH = 0.08;        // s, display-side steering smoothing
  var SPEED_EASE = 0.3;           // s, forward speed easing
  var LATERAL_SPEED = 0.9;        // R/s at full lock
  var ROAD_HALF = 0.5;
  var BUMPER = 0.82;              // soft bumper |x|
  var BUMPER_ZONE = 0.1;
  var BUMPER_CONTACT = 0.80;      // |x| at which the boing plays (the bumper is approached asymptotically)
  var BUMPER_REARM = 0.75;
  var DRIFT_BACK = 0.12;          // R/s back towards the road on the shoulder

  var CAR_W = 0.18, CAR_H = 0.30;
  var TREAT_SIZE = 0.16;
  var PUDDLE_W = 0.32, PUDDLE_H = 0.20;
  var GATE_SPARKLES = 20;

  var BIOME_SECONDS = 75;
  var BLEND_SECONDS = 3;
  var START_SECONDS = 3;
  var WAIT_FADE = 0.6;
  var CELEBRATION_SECONDS = 3;
  var STEER_TIMEOUT = 2;          // s without steer messages → s = 0 (real time)
  var DISCONNECT_GRACE = 1.5;     // s disconnected before PAUSED (real time)
  var KEY_RAMP = 0.15;            // s for keyboard steering to reach full lock

  var FLIGHT_SECONDS = 0.5;       // treat icon → tray slot
  var TROPHY_FLIGHT_SECONDS = 0.7; // tray icons → trophy star
  var PULSE_SECONDS = 0.4;
  var POP_SECONDS = 0.25;

  var MAX_PARTICLES = 300;
  var MAX_SUBSTEP = 1 / 60;       // physics step cap, so ?speed=8 does not tunnel through treats

  var STATE = { WAITING: 'WAITING', STARTING: 'STARTING', PLAYING: 'PLAYING', PAUSED: 'PAUSED' };

  var FALLBACK_PALETTE = {
    ground: '#7ED957', groundStripe: '#6CC64A', road: '#9AA0B5', roadEdge: '#FFFFFF',
    laneMark: '#FFE45C', accent: '#FF6FB5', dust: '#5DB843',
  };
  var CONFETTI_COLORS = ['#FF4D4D', '#FF9F1C', '#FFE45C', '#7ED957', '#4D96FF', '#B388FF', '#FF6FB5'];
  var DROPLET_COLORS = ['#4FC3F7', '#9BE0FF', '#2E9BEA'];

  // ---------------------------------------------------------------------------
  // URL params (dad testing)
  // ---------------------------------------------------------------------------

  var params = new URLSearchParams(location.search);
  var SPEED = clamp(parseFloat(params.get('speed')) || 1, 0.1, 50);
  var START_BIOME = BIOMES.indexOf(params.get('biome')) >= 0 ? params.get('biome') : 'meadow';
  var debugOn = params.get('debug') === '1';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function nowSec() { return performance.now() / 1000; }
  function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }
  function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function nextBiome(b) { return BIOMES[(BIOMES.indexOf(b) + 1) % BIOMES.length]; }

  var warned = {};
  function warnOnce(key, err) {
    if (warned[key]) return;
    warned[key] = true;
    console.error('[game] ' + key, err);
  }

  // Sounds must never break the game: call through this wrapper.
  function snd(name) {
    if (typeof Sounds === 'undefined' || !Sounds || typeof Sounds[name] !== 'function') return undefined;
    try {
      return Sounds[name].apply(Sounds, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      warnOnce('Sounds.' + name, e);
      return undefined;
    }
  }
  function soundOn() { return !!snd('isUnlocked'); }
  function hasArt() { return typeof Art !== 'undefined' && !!Art; }

  // ---------------------------------------------------------------------------
  // Canvas and units (section 2)
  // ---------------------------------------------------------------------------

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, DPR = 1, R = 1, CAR_Y = 0;

  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.max(1, Math.round(W * DPR));
    canvas.height = Math.max(1, Math.round(H * DPR));
    R = Math.max(1, Math.min(0.36 * W, 0.6 * H));
    CAR_Y = 0.8 * H;
  }
  function checkResize() {
    if (W !== window.innerWidth || H !== window.innerHeight || DPR !== (window.devicePixelRatio || 1)) resize();
  }
  window.addEventListener('resize', resize);
  resize();

  // World (x in R, d in R) → screen (CSS px).
  function sx(x) { return W / 2 + x * R; }
  function sy(d) { return CAR_Y - (d - car.d) * R; }
  function aheadVisible() { return CAR_Y / R; }                 // R of road visible above the car
  function spawnHorizon() { return car.d + aheadVisible() + 0.6; } // spawn just past the top edge
  function despawnLine() { return car.d - ((H - CAR_Y) / R + 0.5); } // 0.5R below the bottom edge

  // HUD positions (section 2).
  function slotPos(i) { return { x: W / 2 + (i - 4.5) * 0.095 * H, y: 0.07 * H }; }
  function trophyPos(i, count) { return Art.trophyPos(W, H, i, count); }

  // ---------------------------------------------------------------------------
  // Server info: controller URL and QR image for the waiting/paused cards
  // ---------------------------------------------------------------------------

  var ctrlUrl = 'https://' + (location.hostname || 'localhost') + ':8443/controller';
  var qrImg = null;

  function loadInfo() {
    fetch('/info', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (j) { if (j && typeof j.controllerUrl === 'string') ctrlUrl = j.controllerUrl; })
      .catch(function () { setTimeout(loadInfo, 5000); });
  }
  function loadQr() {
    var img = new Image();
    img.onload = function () { qrImg = img; };
    img.onerror = function () { qrImg = null; setTimeout(loadQr, 5000); };
    img.src = '/qr.svg';
  }
  loadInfo();
  loadQr();

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------

  var state = STATE.WAITING;
  var waitFade = 0;          // 1 → 0: waiting screen fading out over the game
  var startT = 0;            // seconds into STARTING (negative while the waiting screen fades)
  var lightStep = -1;        // last traffic light step that beeped
  var wentGreen = false;
  var keyboardMode = false;
  var tutorialDone = false;

  // Controller (Net) input.
  var ctrlConnected = false;
  var ctrlChangedAt = nowSec();
  var ctrlS = 0;
  var lastSteerAt = -1e9;

  // Keyboard input.
  var keyLeft = false, keyRight = false, kbS = 0;

  var car = {
    x: 0, d: 0, v: 0, sm: 0,
    bodyAngle: 0, wheelAngle: 0,
    squashT: 0, bumperArmed: true,
    puddleT: 0, offroad: false, dustT: 0,
  };

  var wt = 0;          // world time (frozen while paused, scaled by ?speed)
  var rt = 0;          // real time, for UI animation
  var playTime = 0;    // PLAYING time only (puddles)
  var biomeTime = 0;   // PLAYING time in the current biome
  var biome = START_BIOME;
  var scene = { from: biome, to: biome, mix: 1 };
  var pal = FALLBACK_PALETTE;

  var treats = [];     // {kind, x, d}
  var puddles = [];    // {x, d, hitAt}  hitAt = world time of splash or -1
  var props = [];      // {kind, x, d, size}
  var gates = [];      // {d, from, to, passed}
  var pops = [];       // {kind, x, d, age}
  var flights = [];    // treat icon flying to its tray slot {kind, slot, fx, fy, fsize, age}
  var trophyFlights = []; // tray icons flying into the new trophy {kind, slot, age}
  var nextTreatD = Infinity;
  var lastLane = 1;
  var nextPropD = [0, 0];
  var nextPuddleAt = 20 + rand(0, 4);

  var trayKinds = [];       // treats that have landed in the tray
  var collectedTotal = 0;   // all treats ever collected (slot = collectedTotal % 10)
  var trophies = 0;
  var pulseSlot = -1, pulseT = 0;
  var celebration = null;   // {age} while the party runs
  var spawnPaused = false;  // from the 10th treat until the party ends

  var fps = 60;
  var stats = { collected: 0, splashes: 0, boings: 0, gates: 0, celebrations: 0, pauses: 0 };

  // ---------------------------------------------------------------------------
  // Particles (pooled ring buffer, capped)
  // ---------------------------------------------------------------------------

  var particles = [];
  for (var pi = 0; pi < MAX_PARTICLES; pi++) particles.push({ alive: false });
  var particleNext = 0;
  var particleView = { kind: '', x: 0, y: 0, size: 0, rot: 0, life: 1, color: '#fff' };

  // World particles use x/d in R; screen particles (confetti, HUD sparkles) use px.
  function spawnParticle(kind, screen, x, y, vx, vy, size, life, color, grav, drag) {
    var p = particles[particleNext];
    particleNext = (particleNext + 1) % MAX_PARTICLES; // overwrite the oldest when full
    p.alive = true;
    p.kind = kind; p.screen = screen;
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.size = size; p.life = 1; p.maxLife = life;
    p.color = color; p.grav = grav || 0; p.drag = drag || 0;
    p.rot = rand(0, Math.PI * 2); p.vr = rand(-6, 6);
    return p;
  }

  function burstWorld(kind, n, x, d, speedLo, speedHi, sizeR, lifeLo, lifeHi, colors, drag) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(speedLo, speedHi);
      spawnParticle(kind, false, x, d, Math.cos(a) * sp, Math.sin(a) * sp, sizeR,
        rand(lifeLo, lifeHi), Array.isArray(colors) ? pick(colors) : colors, 0, drag);
    }
  }

  function updateParticles(h) {
    for (var i = 0; i < MAX_PARTICLES; i++) {
      var p = particles[i];
      if (!p.alive) continue;
      p.life -= h / p.maxLife;
      if (p.life <= 0) { p.alive = false; continue; }
      var k = Math.exp(-p.drag * h);
      p.vx *= k; p.vy *= k;
      p.vy += p.grav * h;
      p.x += p.vx * h; p.y += p.vy * h;
      p.rot += p.vr * h;
    }
  }

  function drawParticles() {
    var v = particleView;
    for (var i = 0; i < MAX_PARTICLES; i++) {
      var p = particles[i];
      if (!p.alive) continue;
      v.kind = p.kind; v.rot = p.rot; v.life = p.life; v.color = p.color;
      if (p.screen) { v.x = p.x; v.y = p.y; v.size = p.size; }
      else { v.x = sx(p.x); v.y = sy(p.y); v.size = p.size * R; }
      Art.drawParticle(ctx, v);
    }
  }

  function particleCount() {
    var n = 0;
    for (var i = 0; i < MAX_PARTICLES; i++) if (particles[i].alive) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Input: controller (Net) and keyboard (section 2, 6)
  // ---------------------------------------------------------------------------

  function onSteer(value) {
    var v = Number(value);
    if (!isFinite(v)) return;
    ctrlS = clamp(v, -1, 1);
    lastSteerAt = nowSec();
  }

  function onControllerStatus(connected) {
    connected = !!connected;
    if (connected === ctrlConnected) return;
    ctrlConnected = connected;
    ctrlChangedAt = nowSec();
    if (connected) {
      if (state === STATE.WAITING) {
        snd('connect');
        enterStarting(true);
      } else if (state === STATE.PAUSED) {
        snd('connect');
        enterStarting(false);
      } else if (keyboardMode) {
        // The phone takes over from dad's keyboard; from now on a disconnect pauses.
        snd('connect');
        keyboardMode = false;
      }
      // Otherwise this was a short flap (< 1.5 s): nothing to do.
    } else {
      ctrlS = 0; // stop steering at once; PAUSED follows after the grace period
    }
  }

  function keyDir(e) {
    var k = e.key, c = e.code;
    if (k === 'ArrowLeft' || c === 'KeyA' || k === 'a' || k === 'A') return -1;
    if (k === 'ArrowRight' || c === 'KeyD' || k === 'd' || k === 'D') return 1;
    return 0;
  }

  window.addEventListener('keydown', function (e) {
    snd('unlock');
    if (e.code === 'Backquote' || e.key === '`') { debugOn = !debugOn; return; }
    var dir = keyDir(e);
    if (!dir) return;
    e.preventDefault();
    if (dir < 0) keyLeft = true; else keyRight = true;
    // Dad pressing an arrow starts (or resumes) the game in keyboard mode.
    if (state === STATE.WAITING || state === STATE.PAUSED) {
      keyboardMode = true;
      enterStarting(state === STATE.WAITING);
    }
  });
  window.addEventListener('keyup', function (e) {
    var dir = keyDir(e);
    if (dir < 0) keyLeft = false;
    if (dir > 0) keyRight = false;
  });
  window.addEventListener('blur', function () { keyLeft = keyRight = false; });
  window.addEventListener('pointerdown', function () { snd('unlock'); });
  window.addEventListener('click', function () { snd('unlock'); });
  window.addEventListener('touchend', function () { snd('unlock'); });

  function updateKeyboard(dt) {
    var target = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    var stepAmt = dt / KEY_RAMP;
    if (kbS < target) kbS = Math.min(target, kbS + stepAmt);
    else if (kbS > target) kbS = Math.max(target, kbS - stepAmt);
  }

  // Raw steering input s in -1..1. Keyboard wins while used; the phone otherwise.
  function currentSteer() {
    if (keyLeft || keyRight || kbS !== 0) return kbS;
    if (nowSec() - lastSteerAt < STEER_TIMEOUT) return ctrlS;
    return 0;
  }

  // ---------------------------------------------------------------------------
  // State transitions (section 6)
  // ---------------------------------------------------------------------------

  function enterStarting(fromWaiting) {
    state = STATE.STARTING;
    startT = fromWaiting ? -WAIT_FADE : 0;
    waitFade = fromWaiting ? 1 : 0;
    lightStep = -1;
    wentGreen = false;
    car.v = 0; // forward speed is 0 until green
    if (!tutorialDone) placeTutorial();
  }

  function enterPaused() {
    state = STATE.PAUSED;
    stats.pauses++;
    keyLeft = keyRight = false;
    kbS = 0;
    snd('disconnect');
    snd('setEngine', false);
    snd('setOffroad', false);
  }

  function updateStateMachine() {
    // PAUSED only after the controller has been gone for 1.5 s (debounces flaps).
    if ((state === STATE.STARTING || state === STATE.PLAYING) && !keyboardMode && !ctrlConnected &&
        nowSec() - ctrlChangedAt > DISCONNECT_GRACE) {
      enterPaused();
    }
  }

  // Traffic light: red, yellow, green one per second; green = go.
  function updateStarting(h) {
    startT += h;
    if (waitFade > 0) waitFade = Math.max(0, waitFade - h / WAIT_FADE);
    if (startT < 0) return;
    var step = startT < 1 ? 0 : startT < 2 ? 1 : 2;
    if (step !== lightStep) {
      lightStep = step;
      snd('light', step);
    }
    if (step === 2 && !wentGreen) {
      wentGreen = true;
      snd('go');
      snd('setEngine', true);
    }
    if (startT >= START_SECONDS) state = STATE.PLAYING;
  }

  function trafficLightStep() { return Math.max(0, Math.min(2, Math.floor(Math.max(0, startT)))); }

  // ---------------------------------------------------------------------------
  // Spawning (section 3, 4)
  // ---------------------------------------------------------------------------

  // First ride: three fixed treats, a free win straight ahead then one each side.
  function placeTutorial() {
    tutorialDone = true;
    var k = TREAT_OF[biome];
    treats.push({ kind: k, x: 0, d: car.d + 1.0 });
    treats.push({ kind: k, x: 0.3, d: car.d + 3.0 });
    treats.push({ kind: k, x: -0.3, d: car.d + 4.8 });
    lastLane = 0;
    nextTreatD = car.d + 4.8 + rand(1.4, 2.0);
  }

  function spawnTreatGroup(d) {
    var lane = lastLane;
    if (Math.random() < 0.7) lane = pick([0, 1, 2].filter(function (i) { return i !== lastLane; }));
    var kind = TREAT_OF[biome];
    if (Math.random() < 0.2) {
      // Trail of 3, 0.5R apart: same lane, or stepping one lane across each time.
      var dir = 0;
      if (Math.random() < 0.5) dir = lane === 0 ? 1 : lane === 2 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      for (var k = 0; k < 3; k++) {
        var li = clamp(lane + k * dir, 0, 2);
        treats.push({ kind: kind, x: LANES[li], d: d + k * 0.5 });
        lastLane = li;
      }
      nextTreatD = d + 1.0 + rand(1.4, 2.0);
    } else {
      treats.push({ kind: kind, x: LANES[lane], d: d });
      lastLane = lane;
      nextTreatD = d + rand(1.4, 2.0);
    }
  }

  function spawnProp(side, d) {
    if (biome === 'beach' && side > 0) {
      // Right side is sea: only an occasional boat.
      if (Math.random() < 0.15) props.push({ kind: 'boat', x: rand(1.25, 1.45), d: d, size: PROP_SIZE.boat });
      return;
    }
    var kind = pick(PROPS_OF[biome]);
    var size = PROP_SIZE[kind];
    // |x| in 1.0–1.4, pushed out for wide props so they never overlap the shoulder (car reach 0.91).
    var ax = Math.max(rand(1.0, 1.4), 0.93 + size / 2);
    props.push({ kind: kind, x: side * ax, d: d, size: size });
  }

  function spawnProps(horizon) {
    for (var i = 0; i < 2; i++) {
      var side = i === 0 ? -1 : 1;
      while (nextPropD[i] < horizon) {
        spawnProp(side, nextPropD[i]);
        nextPropD[i] += rand(0.5, 1.0);
      }
    }
  }

  // Puddle in a lane with no treat within ±0.6R, and before the next treat group is placed.
  function trySpawnPuddle(horizon) {
    var d = horizon;
    if (d > nextTreatD - 0.6) return; // wait for the gap after the next treat spawns
    var free = [0, 1, 2].filter(function (i) {
      for (var j = 0; j < treats.length; j++) {
        if (Math.abs(treats[j].x - LANES[i]) < 0.01 && Math.abs(treats[j].d - d) <= 0.6) return false;
      }
      return true;
    });
    if (!free.length) return;
    puddles.push({ x: LANES[pick(free)], d: d, hitAt: -1 });
    nextPuddleAt = playTime + rand(10, 14);
  }

  function pendingGate() {
    for (var i = 0; i < gates.length; i++) if (!gates[i].passed) return gates[i];
    return null;
  }

  function spawn() {
    var horizon = spawnHorizon();

    // Treats (spawning pauses for the celebration).
    if (spawnPaused) nextTreatD = Math.max(nextTreatD, horizon);
    else while (nextTreatD < horizon) spawnTreatGroup(nextTreatD);

    spawnProps(horizon);

    if (state === STATE.PLAYING) {
      if (playTime >= nextPuddleAt) trySpawnPuddle(horizon);
      // Gate: placed so that, at cruise speed, it reaches the car when the biome's 75 s are up.
      if (!pendingGate()) {
        var remain = Math.max(0, BIOME_SECONDS - biomeTime);
        if (remain * CRUISE <= horizon - car.d) {
          gates.push({ d: car.d + remain * CRUISE, from: biome, to: nextBiome(biome), passed: false });
        }
      }
    }
  }

  function despawn() {
    var line = despawnLine();
    function keep(e) { return e.d >= line; }
    treats = treats.filter(keep);
    puddles = puddles.filter(keep);
    props = props.filter(keep);
    gates = gates.filter(function (g) { return !g.passed || g.d >= line; });
  }

  // ---------------------------------------------------------------------------
  // Car physics (section 2)
  // ---------------------------------------------------------------------------

  function forwardAllowed() {
    return state === STATE.PLAYING || (state === STATE.STARTING && startT >= 2);
  }

  function updateCar(h) {
    var s = currentSteer();
    car.sm += (s - car.sm) * (1 - Math.exp(-h / STEER_SMOOTH));
    var sm = car.sm;

    // Lateral motion with shoulder drift-back and the soft bumper.
    var vx = sm * LATERAL_SPEED;
    var ax = Math.abs(car.x), side = car.x < 0 ? -1 : 1;
    if (ax > ROAD_HALF) {
      var steeringOut = Math.abs(sm) >= 0.2 && (sm < 0 ? -1 : 1) === side;
      if (!steeringOut) vx -= side * DRIFT_BACK;
    }
    if (ax > BUMPER - BUMPER_ZONE && vx * side > 0) vx *= Math.max(0, (BUMPER - ax) / BUMPER_ZONE);
    car.x = clamp(car.x + vx * h, -BUMPER, BUMPER);
    ax = Math.abs(car.x);

    if (car.bumperArmed && ax >= BUMPER_CONTACT && sm * car.x > 0) {
      car.bumperArmed = false;
      car.squashT = 0.2;
      stats.boings++;
      snd('boing');
    } else if (!car.bumperArmed && ax < BUMPER_REARM) {
      car.bumperArmed = true;
    }

    // Forward speed eases to the target.
    var onShoulder = ax > ROAD_HALF;
    var target = forwardAllowed() ? CRUISE * (onShoulder ? SHOULDER_FACTOR : 1) : 0;
    car.v += (target - car.v) * (1 - Math.exp(-h / SPEED_EASE));
    var mul = car.puddleT > 0 ? 0.85 : 1;
    car.d += car.v * mul * h;

    // Shoulder effects only while actually rolling.
    car.offroad = onShoulder && car.v > 0.1;
    if (car.offroad) {
      car.dustT -= h;
      if (car.dustT <= 0) {
        car.dustT += 0.1;
        for (var i = -1; i <= 1; i += 2) {
          spawnParticle('dust', false, car.x + i * 0.07, car.d - 0.13, rand(-0.1, 0.1) + i * 0.05,
            rand(-0.15, -0.05), 0.05, rand(0.5, 0.8), pal.dust, 0, 2);
        }
      }
    } else {
      car.dustT = 0;
    }

    car.squashT = Math.max(0, car.squashT - h);
    car.puddleT = Math.max(0, car.puddleT - h);
    var wiggle = car.puddleT > 0 ? 0.15 * Math.sin(wt * 25) * (car.puddleT / 0.6) : 0;
    car.bodyAngle = sm * 0.30 + wiggle;
    car.wheelAngle = sm * 0.55;
  }

  // ---------------------------------------------------------------------------
  // Collisions, tray, celebration (section 3, 6)
  // ---------------------------------------------------------------------------

  function collect(t) {
    stats.collected++;
    pops.push({ kind: t.kind, x: t.x, d: t.d, age: 0 });
    burstWorld('sparkle', 8, t.x, t.d, 0.3, 0.7, 0.04, 0.4, 0.8, [pal.accent, '#FFFFFF', '#FFD93D'], 3);
    var slot = collectedTotal % 10;
    collectedTotal++;
    flights.push({ kind: t.kind, slot: slot, fx: sx(t.x), fy: sy(t.d), fsize: TREAT_SIZE * R, age: 0 });
    snd('collect', slot);
    if (slot === 9) {
      // Party is coming: stop spawning and quietly drop treats not yet on screen,
      // so nothing arrives (and gets missed) during the celebration.
      spawnPaused = true;
      var top = car.d + aheadVisible() + 0.15;
      treats = treats.filter(function (o) { return o.d <= top; });
    }
  }

  function splash(p) {
    stats.splashes++;
    p.hitAt = wt;
    burstWorld('droplet', 12, car.x, car.d + 0.05, 0.3, 0.6, 0.03, 0.4, 0.7, DROPLET_COLORS, 4);
    car.puddleT = 0.6;
    snd('splash');
  }

  function passGate(g) {
    g.passed = true;
    stats.gates++;
    biome = g.to;
    scene = { from: scene.to, to: g.to, mix: 0 };
    biomeTime = 0;
    snd('gate');
    var accent = FALLBACK_PALETTE.accent;
    if (hasArt()) {
      try { accent = Art.palette({ from: g.to, to: g.to, mix: 1 }).accent || accent; } catch (e) { warnOnce('Art.palette', e); }
    }
    for (var i = 0; i < GATE_SPARKLES; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(0.2, 0.6);
      spawnParticle('sparkle', false, rand(-0.65, 0.65), car.d + rand(-0.05, 0.15),
        Math.cos(a) * sp, Math.sin(a) * sp, 0.04, rand(0.6, 1.2), accent, 0, 2);
    }
  }

  function collisions() {
    for (var i = treats.length - 1; i >= 0; i--) {
      var t = treats[i];
      if (Math.abs(t.x - car.x) < 0.17 && Math.abs(t.d - car.d) < 0.20) {
        treats.splice(i, 1);
        collect(t);
      }
    }
    for (var j = 0; j < puddles.length; j++) {
      var p = puddles[j];
      if (p.hitAt < 0 && Math.abs(p.x - car.x) < 0.25 && Math.abs(p.d - car.d) < 0.18) splash(p);
    }
    for (var k = 0; k < gates.length; k++) {
      if (!gates[k].passed && gates[k].d <= car.d) passGate(gates[k]);
    }
  }

  function startCelebration() {
    stats.celebrations++;
    celebration = { age: 0 };
    snd('celebrate');
    for (var i = 0; i < 80; i++) {
      spawnParticle('confetti', true, rand(0, W), rand(-0.05 * H, 0.02 * H),
        rand(-0.4, 0.4) * R, rand(0.2, 1.0) * R, 0.03 * R, rand(1.0, 1.2), pick(CONFETTI_COLORS), 0.8 * R, 0.5);
    }
    // The tray icons fly into the new trophy; the tray empties.
    trophyFlights = trayKinds.map(function (k, idx) { return { kind: k, slot: idx, age: -idx * 0.05 }; });
    trayKinds = [];
    pulseSlot = -1;
  }

  function updateHud(h) {
    // Treat icons flying to their slots.
    for (var i = 0; i < flights.length; i++) {
      var f = flights[i];
      f.age += h;
      if (f.age >= FLIGHT_SECONDS) {
        flights.splice(i--, 1);
        trayKinds.push(f.kind);
        pulseSlot = trayKinds.length - 1;
        pulseT = 0;
        if (trayKinds.length >= 10) startCelebration();
      }
    }
    if (pulseSlot >= 0) {
      pulseT += h / PULSE_SECONDS;
      if (pulseT >= 1) { pulseSlot = -1; pulseT = 0; }
    }

    // Tray icons flying into the trophy.
    if (trophyFlights.length) {
      var done = true;
      for (var j = 0; j < trophyFlights.length; j++) {
        trophyFlights[j].age += h;
        if (trophyFlights[j].age < TROPHY_FLIGHT_SECONDS) done = false;
      }
      if (done) {
        trophyFlights = [];
        trophies++;
        var tp = trophyPos(trophies - 1, trophies);
        for (var k = 0; k < 12; k++) {
          var a = rand(0, Math.PI * 2), sp = rand(0.3, 0.8) * R;
          spawnParticle('sparkle', true, tp.x, tp.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.04 * R,
            rand(0.4, 0.8), pick(['#FFD700', '#FFF6A5', '#FFFFFF']), 0, 3);
        }
      }
    }

    if (celebration) {
      celebration.age += h;
      if (celebration.age >= CELEBRATION_SECONDS) {
        celebration = null;
        spawnPaused = false;
      }
    }

    for (var p = 0; p < pops.length; p++) {
      pops[p].age += h;
      if (pops[p].age >= POP_SECONDS) pops.splice(p--, 1);
    }

    if (scene.mix < 1) {
      scene.mix = Math.min(1, scene.mix + h / BLEND_SECONDS);
      if (scene.mix >= 1) scene = { from: scene.to, to: scene.to, mix: 1 };
    }
  }

  // ---------------------------------------------------------------------------
  // Main update
  // ---------------------------------------------------------------------------

  function step(h) {
    wt += h;
    if (state === STATE.STARTING) updateStarting(h);
    if (state === STATE.PLAYING) { playTime += h; biomeTime += h; }
    updateCar(h);
    spawn();
    collisions();
    updateHud(h);
    updateParticles(h);
    despawn();
  }

  var worldReady = false;
  function initWorld() {
    worldReady = true;
    // Pre-fill roadside props so the scenery is already there when the waiting screen fades.
    var start = despawnLine();
    nextPropD = [start + rand(0, 0.5), start + rand(0, 0.5)];
    spawnProps(spawnHorizon());
  }

  function updatePalette() {
    if (!hasArt()) return;
    try {
      var p = Art.palette(scene);
      if (p) pal = p;
    } catch (e) { warnOnce('Art.palette', e); }
  }

  var lastBodyClass = null;
  function tick(dt) {
    rt += dt;
    checkResize();
    if (!worldReady) initWorld();
    updateKeyboard(dt);
    updateStateMachine();
    updatePalette();

    if (state === STATE.STARTING || state === STATE.PLAYING) {
      var wdt = dt * SPEED;
      var n = Math.max(1, Math.ceil(wdt / MAX_SUBSTEP));
      for (var i = 0; i < n; i++) step(wdt / n);
    }

    // Sound toggles (safe every frame; Sounds acts on changes only).
    var engine = state === STATE.PLAYING || (state === STATE.STARTING && wentGreen);
    snd('setEngine', engine);
    snd('setOffroad', engine && car.offroad);
    if (state !== STATE.WAITING) snd('setBiome', biome);

    var driving = state === STATE.PLAYING || state === STATE.STARTING;
    if (driving !== lastBodyClass) {
      lastBodyClass = driving;
      document.body.classList.toggle('playing', driving);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering (section 7 draw order)
  // ---------------------------------------------------------------------------

  function nightAmount() {
    return (scene.to === 'night' ? scene.mix : 0) + (scene.from === 'night' ? 1 - scene.mix : 0);
  }

  function drawWorld() {
    var t = wt, cx = W / 2, scroll = car.d * R, i;
    var top = -R, bottom = H + R; // cull far-off entities

    Art.drawGround(ctx, W, H, scene, cx, R, scroll, t);
    Art.drawRoad(ctx, cx, R, H, scene, scroll, t);

    for (i = 0; i < puddles.length; i++) {
      var pd = puddles[i], py = sy(pd.d);
      if (py < top || py > bottom) continue;
      Art.drawPuddle(ctx, sx(pd.x), py, PUDDLE_W * R, PUDDLE_H * R, t, pd.hitAt < 0 ? -1 : wt - pd.hitAt);
    }

    // Props: farther ones first so nearer ones overlap them.
    var sorted = props.slice().sort(function (a, b) { return b.d - a.d; });
    for (i = 0; i < sorted.length; i++) {
      var pr = sorted[i], ppy = sy(pr.d);
      if (ppy < top || ppy > bottom) continue;
      Art.drawProp(ctx, pr.kind, sx(pr.x), ppy, pr.size * R, t);
    }

    var tsize = TREAT_SIZE * R;
    for (i = 0; i < treats.length; i++) {
      var tr = treats[i], ty = sy(tr.d);
      if (ty < top || ty > bottom) continue;
      Art.drawTreat(ctx, tr.kind, sx(tr.x), ty, tsize, t, 1);
    }
    for (i = 0; i < pops.length; i++) {
      var po = pops[i], pp = po.age / POP_SECONDS;
      Art.drawTreat(ctx, po.kind, sx(po.x), sy(po.d), tsize * (1 + 0.6 * pp), t, Math.max(0, 1 - pp));
    }

    for (i = 0; i < gates.length; i++) {
      var gy = sy(gates[i].d);
      if (gy < top || gy > bottom) continue;
      Art.drawGate(ctx, cx, gy, R, gates[i].to, t);
    }

    // Car: jitter on the shoulder, squash after the bumper, Z's when asleep.
    var jx = 0, jy = 0;
    if (car.offroad && state !== STATE.PAUSED) {
      jx = 2 * Math.sin(wt * Math.PI * 2 * 12);
      jy = 2 * Math.sin(wt * Math.PI * 2 * 12 + 1.7);
    }
    var squash = car.squashT > 0 ? Math.sin(Math.PI * (1 - car.squashT / 0.2)) : 0;
    var sleeping = state === STATE.PAUSED;
    Art.drawCar(ctx, sx(car.x) + jx, CAR_Y + jy, CAR_W * R, CAR_H * R, car.bodyAngle, car.wheelAngle,
      sleeping ? rt : t, { squash: squash, headlights: nightAmount() > 0.5, sleeping: sleeping });

    drawParticles();

    if (celebration) Art.drawRainbow(ctx, W, H, Math.min(1, celebration.age / CELEBRATION_SECONDS), t);

    Art.drawTray(ctx, W, H, trayKinds, pulseSlot, pulseT, rt);
    Art.drawTrophies(ctx, W, H, trophies, rt);
    drawFlights(t);

    if (state === STATE.STARTING) Art.drawTrafficLight(ctx, cx, 0.35 * H, 0.30 * H, trafficLightStep());

    if ((state === STATE.STARTING || state === STATE.PLAYING) && !soundOn()) {
      Art.drawSoundOff(ctx, 0.02 * H, 0.02 * H, 0.06 * H);
    }

    if (state === STATE.PAUSED) Art.drawPaused(ctx, W, H, rt, qrImg, ctrlUrl);
  }

  // Icons in flight are drawn over the tray so they visibly land in it.
  function drawFlights(t) {
    var slotIcon = 0.065 * H, i, p, a, b;
    for (i = 0; i < flights.length; i++) {
      var f = flights[i];
      p = easeOutCubic(Math.min(1, f.age / FLIGHT_SECONDS));
      b = slotPos(f.slot);
      Art.drawTreat(ctx, f.kind, f.fx + (b.x - f.fx) * p, f.fy + (b.y - f.fy) * p,
        f.fsize + (slotIcon - f.fsize) * p, t, 1);
    }
    for (i = 0; i < trophyFlights.length; i++) {
      var tf = trophyFlights[i];
      if (tf.age < 0) {
        a = slotPos(tf.slot);
        Art.drawTreat(ctx, tf.kind, a.x, a.y, slotIcon, t, 1);
        continue;
      }
      p = easeInOut(Math.min(1, tf.age / TROPHY_FLIGHT_SECONDS));
      a = slotPos(tf.slot);
      b = trophyPos(trophies, trophies + 1);
      Art.drawTreat(ctx, tf.kind, a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p, slotIcon * (1 - 0.6 * p), t, 1);
    }
  }

  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalAlpha = 1;
    if (!hasArt()) {
      ctx.fillStyle = '#7ED957';
      ctx.fillRect(0, 0, W, H);
    } else if (state === STATE.WAITING) {
      Art.drawWaiting(ctx, W, H, rt, qrImg, ctrlUrl, soundOn());
    } else {
      drawWorld();
      if (waitFade > 0) {
        ctx.globalAlpha = waitFade;
        Art.drawWaiting(ctx, W, H, rt, qrImg, ctrlUrl, soundOn());
        ctx.globalAlpha = 1;
      }
    }
    if (debugOn) drawDebug();
  }

  // ---------------------------------------------------------------------------
  // Debug overlay (` key)
  // ---------------------------------------------------------------------------

  function drawDebug() {
    var lines = [
      'fps ' + fps.toFixed(0) + '   speed x' + SPEED,
      'state ' + state + (keyboardMode ? ' (keyboard)' : '') + (celebration ? ' +party' : ''),
      'controller ' + (ctrlConnected ? 'connected' : 'disconnected') +
        '   net ' + (typeof Net !== 'undefined' && Net && Net.connected ? 'up' : 'down'),
      's ' + currentSteer().toFixed(2) + '   sm ' + car.sm.toFixed(2) + '   phone ' + ctrlS.toFixed(2) +
        ' (' + Math.min(99, nowSec() - lastSteerAt).toFixed(1) + 's ago)',
      'biome ' + biome + '  ' + biomeTime.toFixed(1) + '/' + BIOME_SECONDS + 's' +
        (scene.mix < 1 ? '  blend ' + scene.from + '>' + scene.to + ' ' + scene.mix.toFixed(2) : ''),
      'x ' + car.x.toFixed(2) + '  d ' + car.d.toFixed(1) + '  v ' + car.v.toFixed(2) + (car.offroad ? '  shoulder' : ''),
      'tray ' + trayKinds.length + '  trophies ' + trophies + '  collected ' + stats.collected,
      'treats ' + treats.length + '  puddles ' + puddles.length + '  props ' + props.length +
        '  gates ' + gates.length + '  particles ' + particleCount(),
      'play ' + playTime.toFixed(1) + 's  next puddle ' + nextPuddleAt.toFixed(1) + 's  sound ' + (soundOn() ? 'on' : 'locked'),
    ];
    ctx.save();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalAlpha = 1;
    ctx.font = '13px monospace';
    ctx.textBaseline = 'top';
    var lh = 16, pad = 8, bw = 0;
    for (var i = 0; i < lines.length; i++) bw = Math.max(bw, ctx.measureText(lines[i]).width);
    var bx = 8, by = H - lines.length * lh - pad * 2 - 8;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx, by, bw + pad * 2, lines.length * lh + pad * 2);
    ctx.fillStyle = '#9CFF9C';
    for (var j = 0; j < lines.length; j++) ctx.fillText(lines[j], bx + pad, by + pad + j * lh);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  var lastTs = null;
  function frame(ts) {
    requestAnimationFrame(frame);
    var t = ts / 1000;
    var raw = lastTs === null ? 0 : t - lastTs;
    lastTs = t;
    if (raw > 0) fps += (1 / raw - fps) * 0.1;
    var dt = clamp(raw, 0, 0.05); // tab switches must not teleport anything
    try {
      tick(dt);
      render();
    } catch (e) {
      warnOnce('frame error: ' + (e && e.message), e);
      try { ctx.restore(); } catch (e2) { /* ignore */ }
    }
  }

  if (typeof Net !== 'undefined' && Net && typeof Net.connect === 'function') {
    try { Net.connect(onSteer, onControllerStatus); } catch (e) { warnOnce('Net.connect', e); }
  } else {
    warnOnce('Net missing', new Error('net.js did not load; keyboard only'));
  }
  requestAnimationFrame(frame);

  // Read-only snapshot for tests and the console.
  window.CamiGame = {
    snapshot: function () {
      return {
        state: state, keyboardMode: keyboardMode, ctrlConnected: ctrlConnected, biome: biome,
        scene: { from: scene.from, to: scene.to, mix: scene.mix }, biomeTime: biomeTime, playTime: playTime,
        car: { x: car.x, d: car.d, v: car.v, sm: car.sm, offroad: car.offroad },
        tray: trayKinds.slice(), trophies: trophies, celebrating: !!celebration, spawnPaused: spawnPaused,
        treats: treats.map(function (t) { return { kind: t.kind, x: t.x, d: t.d }; }),
        puddles: puddles.map(function (p) { return { x: p.x, d: p.d, hit: p.hitAt >= 0 }; }),
        props: props.length, gates: gates.length,
        particles: particleCount(), stats: JSON.parse(JSON.stringify(stats)), speed: SPEED,
      };
    },
  };
})();
