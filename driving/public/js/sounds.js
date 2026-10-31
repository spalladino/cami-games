// Cami Driving: every sound in the game, synthesized with WebAudio (no audio files).
// Contract: docs/GAME_DESIGN.md section 8. Defines window.Sounds.
//
// Graph:  voices -> bus -> compressor (gentle limiter) -> master (0.5) -> destination
//         offroad thumps -> offroadBus (fades in/out) -> bus
//         ambience       -> ambBus -> bus
//         engine hum     -> engine on/off gain -> bus
//
// Rules followed everywhere:
// - Every envelope starts and ends at exactly 0 (linear attack, exponential decay, linear tail to 0).
// - Every one-shot is a "voice" owning its nodes; when all its sources end, all nodes are disconnected.
// - Each sound type has a voice cap and a minimum retrigger gap, so rapid repeats never stack up.
// - Every public function is wrapped in try/catch and is a silent no-op while audio is locked.
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : globalThis;

  var ctx = null;
  var bus = null, comp = null, master = null;
  var offroadBus = null, ambBus = null;
  var engine = null; // {osc, lfo, ..., onOff}
  var noiseBuf = null;

  var groups = {};   // group name -> array of live voices
  var lastTrig = {}; // group name -> ctx time of last accepted trigger

  // Toggle state: what the game asked for (want) and what is currently applied (cur).
  // Wants are remembered while locked, so unlocking later picks up the right state silently.
  var want = { offroad: false, engine: false, biome: null };
  var cur = { offroad: false, engine: false, biome: null };

  var timer = null;
  var TICK_MS = 50;
  var LOOKAHEAD = 0.3; // seconds of events scheduled ahead of currentTime
  var offNext = 0, ambNext = 0;

  var LIMITS = {
    collect: { max: 2, gap: 0.03 },
    splash: { max: 2, gap: 0.12 },
    boing: { max: 1, gap: 0.15 },
    celebrate: { max: 1, gap: 1.0 },
    gate: { max: 1, gap: 0.5 },
    light: { max: 2, gap: 0.15 },
    go: { max: 1, gap: 0.3 },
    connect: { max: 1, gap: 0.25 },
    disconnect: { max: 1, gap: 0.25 },
    thump: { max: 4, gap: 0 },
    amb: { max: 6, gap: 0 }
  };

  // ---------------------------------------------------------------- helpers

  function rand(a, b) { return a + Math.random() * (b - a); }

  function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

  // C-major pentatonic starting at C5; index 0..n.
  var PENT = [0, 2, 4, 7, 9];
  function pent(i) { return midi(72 + 12 * Math.floor(i / 5) + PENT[i % 5]); }

  function isUnlocked() {
    return !!ctx && ctx.state === 'running';
  }

  // Gain envelope: 0 -> peak (linear, `a` s) -> optional hold -> exponential decay ending at
  // t + d -> exactly 0 shortly after. Returns the time the envelope is fully silent.
  function env(param, t, a, peak, d, hold) {
    hold = hold || 0;
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    if (hold > 0) param.setValueAtTime(peak, t + a + hold);
    var end = Math.max(t + d, t + a + hold + 0.01);
    param.exponentialRampToValueAtTime(0.0001, end);
    param.linearRampToValueAtTime(0, end + 0.015);
    return end + 0.015;
  }

  // Smoothly move a parameter towards a value without jumps.
  function glide(param, value, tau) {
    var t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, tau);
  }

  function Voice(group, dest) {
    this.group = group;
    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(dest);
    this.nodes = [this.out];
    this.srcs = [];
    this.ended = 0;
    this.dead = false;
    this.stolen = false;
  }

  Voice.prototype.node = function (n) {
    this.nodes.push(n);
    return n;
  };

  Voice.prototype.gain = function () {
    var g = ctx.createGain();
    g.gain.value = 0; // silent until its envelope says otherwise
    return this.node(g);
  };

  Voice.prototype.filter = function (type, freq, q) {
    var f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q == null ? 0.7 : q;
    return this.node(f);
  };

  Voice.prototype.src = function (s, start, stop) {
    var self = this;
    this.srcs.push({ node: s, stop: stop });
    this.nodes.push(s);
    s.onended = function () {
      self.ended++;
      if (self.ended >= self.srcs.length) self.free();
    };
    s.start(start);
    s.stop(stop);
    return s;
  };

  Voice.prototype.osc = function (type, freq, start, stop) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return this.src(o, start, stop);
  };

  Voice.prototype.noise = function (start, stop) {
    var n = ctx.createBufferSource();
    n.buffer = noiseBuf;
    n.loop = true;
    this.nodes.push(n);
    this.srcs.push({ node: n, stop: stop });
    var self = this;
    n.onended = function () {
      self.ended++;
      if (self.ended >= self.srcs.length) self.free();
    };
    n.start(start, Math.random() * (noiseBuf.duration - 0.1));
    n.stop(stop);
    return n;
  };

  // A simple enveloped oscillator into `dest`. Returns the oscillator (for pitch automation).
  Voice.prototype.tone = function (dest, type, freq, t, a, peak, d, hold) {
    var g = this.gain();
    var end = env(g.gain, t, a, peak, d, hold);
    var o = this.osc(type, freq, t, end + 0.01);
    o.connect(g);
    g.connect(dest);
    return o;
  };

  Voice.prototype.free = function () {
    if (this.dead) return;
    this.dead = true;
    for (var i = 0; i < this.nodes.length; i++) {
      try { this.nodes[i].disconnect(); } catch (e) { /* already disconnected */ }
    }
    this.nodes = [];
    var list = groups[this.group];
    if (list) {
      var k = list.indexOf(this);
      if (k >= 0) list.splice(k, 1);
    }
  };

  // Fade out fast (no click) and stop everything this voice owns.
  Voice.prototype.steal = function () {
    if (this.stolen || this.dead) return;
    this.stolen = true;
    var now = ctx.currentTime;
    try { this.out.gain.setTargetAtTime(0, now, 0.012); } catch (e) { /* ignore */ }
    var stopAt = now + 0.08;
    for (var i = 0; i < this.srcs.length; i++) {
      var s = this.srcs[i];
      if (s.stop > stopAt) {
        try { s.node.stop(stopAt); s.stop = stopAt; } catch (e) { /* ignore */ }
      }
    }
  };

  // Admit a new voice in `group`, enforcing retrigger gap and voice cap. Returns null to drop.
  function admit(group, dest, at) {
    var lim = LIMITS[group] || { max: 2, gap: 0.05 };
    var now = at == null ? ctx.currentTime : at;
    if (lim.gap > 0 && lastTrig[group] != null && now - lastTrig[group] < lim.gap && now >= lastTrig[group]) {
      return null;
    }
    lastTrig[group] = now;
    var list = groups[group] || (groups[group] = []);
    var live = [];
    for (var i = 0; i < list.length; i++) if (!list[i].stolen && !list[i].dead) live.push(list[i]);
    while (live.length >= lim.max) live.shift().steal();
    var v = new Voice(group, dest || bus);
    list.push(v);
    return v;
  }

  function stealGroup(group) {
    var list = groups[group];
    if (!list) return;
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) copy[i].steal();
  }

  // ---------------------------------------------------------------- graph

  function build() {
    var Ctor = W.AudioContext || W.webkitAudioContext;
    if (!Ctor) return false;
    var c = new Ctor();
    ctx = c;

    master = c.createGain();
    master.gain.value = 0.5;
    comp = c.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    bus = c.createGain();
    bus.gain.value = 1;
    bus.connect(comp);
    comp.connect(master);
    master.connect(c.destination);

    offroadBus = c.createGain();
    offroadBus.gain.value = 0;
    offroadBus.connect(bus);

    ambBus = c.createGain();
    ambBus.gain.value = 1;
    ambBus.connect(bus);

    var len = Math.floor(c.sampleRate * 2);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    var data = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    try {
      c.onstatechange = function () {
        try { applyWants(); } catch (e) { /* ignore */ }
      };
    } catch (e) { /* ignore */ }
    return true;
  }

  // ---------------------------------------------------------------- one-shots

  // Two-note marimba blip climbing the pentatonic scale with the slot index.
  function sCollect(i) {
    i = Math.floor(Number(i));
    if (!(i >= 0)) i = 0;
    if (i > 9) i = 9;
    var v = admit('collect');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    var notes = [pent(i), pent(i + 2)];
    var soften = 1 - i * 0.035; // high notes a touch quieter
    for (var k = 0; k < 2; k++) {
      var f = notes[k];
      var tk = t + k * 0.075;
      var peak = (k === 0 ? 0.24 : 0.28) * soften;
      v.tone(v.out, 'sine', f, tk, 0.004, peak, 0.32);
      if (f * 4 < 6000) v.tone(v.out, 'sine', f * 4, tk, 0.002, peak * 0.12, 0.07);
    }
  }

  // Bubbly bloop-bloop: two falling sine drops plus a soft lowpassed noise splash.
  function sSplash() {
    var v = admit('splash');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    var drops = [[t, 600, 200], [t + 0.14, 520, 180]];
    for (var k = 0; k < drops.length; k++) {
      var d = drops[k];
      var o = v.tone(v.out, 'sine', d[1], d[0], 0.006, 0.3, 0.14);
      o.frequency.setValueAtTime(d[1], d[0]);
      o.frequency.exponentialRampToValueAtTime(d[2], d[0] + 0.12);
    }
    var lp = v.filter('lowpass', 900, 0.7);
    var g = v.gain();
    var end = env(g.gain, t, 0.01, 0.35, 0.26);
    var n = v.noise(t, end + 0.01);
    n.connect(lp);
    lp.connect(g);
    g.connect(v.out);
  }

  // Cartoon spring: sine swooping 300 -> 500 -> 250 Hz with a fast wobble.
  function sBoing() {
    var v = admit('boing');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    var o = v.tone(v.out, 'sine', 300, t, 0.012, 0.32, 0.32);
    o.frequency.setValueAtTime(300, t);
    o.frequency.linearRampToValueAtTime(500, t + 0.08);
    o.frequency.exponentialRampToValueAtTime(250, t + 0.3);
    var depth = v.gain();
    depth.gain.setValueAtTime(40, t);
    depth.gain.exponentialRampToValueAtTime(6, t + 0.3);
    var lfo = v.osc('sine', 15, t, t + 0.36);
    lfo.connect(depth);
    depth.connect(o.frequency);
  }

  // Cute two-tone horn "beep".
  function horn(v, t) {
    var lp = v.filter('lowpass', 1800, 0.7);
    lp.connect(v.out);
    v.tone(lp, 'triangle', midi(74), t, 0.012, 0.13, 0.15, 0.08);
    v.tone(lp, 'triangle', midi(78), t, 0.012, 0.1, 0.15, 0.08);
  }

  // Fanfare: C-E-G-C' arpeggio, sparkly high trill, then "beep-beep".
  function sCelebrate() {
    var v = admit('celebrate');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    var arp = [72, 76, 79, 84];
    for (var k = 0; k < arp.length; k++) {
      var tk = t + k * 0.12;
      var last = k === arp.length - 1;
      v.tone(v.out, 'triangle', midi(arp[k]), tk, 0.008, 0.17, last ? 0.75 : 0.32);
      v.tone(v.out, 'sine', midi(arp[k] + 12), tk, 0.006, 0.05, last ? 0.5 : 0.2);
    }
    var trill = [91, 96]; // G6 / C7
    for (var j = 0; j < 10; j++) {
      var tj = t + 0.62 + j * 0.055;
      var shape = Math.sin(Math.PI * (j + 0.5) / 10); // swell in and out
      v.tone(v.out, 'sine', midi(trill[j % 2]), tj, 0.004, 0.03 + 0.05 * shape, 0.12);
    }
    horn(v, t + 1.35);
    horn(v, t + 1.58);
  }

  // Whoosh (bandpassed noise sweep) followed by a 5-note wind-chime glissando.
  function sGate() {
    var v = admit('gate');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    var bp = v.filter('bandpass', 400, 1.2);
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2500, t + 0.35);
    bp.frequency.exponentialRampToValueAtTime(800, t + 0.6);
    var g = v.gain();
    var end = env(g.gain, t, 0.22, 0.5, 0.6);
    var n = v.noise(t, end + 0.01);
    n.connect(bp);
    bp.connect(g);
    g.connect(v.out);

    var chimes = [84, 86, 88, 91, 93]; // C6 D6 E6 G6 A6
    for (var k = 0; k < chimes.length; k++) {
      var tk = t + 0.4 + k * 0.07;
      var f = midi(chimes[k]);
      v.tone(v.out, 'sine', f, tk, 0.003, 0.09, 0.9);
      v.tone(v.out, 'sine', f * 2.76, tk, 0.002, 0.015, 0.2);
    }
  }

  // Traffic light: soft 440 Hz boop for steps 0 and 1, bright 880 Hz ding for step 2.
  function sLight(step) {
    var v = admit('light');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    if (Number(step) === 2) {
      v.tone(v.out, 'sine', 880, t, 0.004, 0.26, 0.6);
      v.tone(v.out, 'sine', 1760, t, 0.003, 0.05, 0.22);
    } else {
      var o = v.tone(v.out, 'sine', 440, t, 0.01, 0.28, 0.22);
      o.frequency.setValueAtTime(455, t);
      o.frequency.exponentialRampToValueAtTime(430, t + 0.2);
      v.tone(v.out, 'sine', 880, t, 0.006, 0.03, 0.1);
    }
  }

  // Friendly "vroom": two slightly detuned saws rising 90 -> 220 Hz through a moving lowpass.
  function sGo() {
    var v = admit('go');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    var lp = v.filter('lowpass', 250, 1.0);
    lp.frequency.setValueAtTime(250, t);
    lp.frequency.exponentialRampToValueAtTime(1100, t + 0.38);
    lp.frequency.exponentialRampToValueAtTime(500, t + 0.55);
    lp.connect(v.out);
    var det = [1, 1.008];
    for (var k = 0; k < det.length; k++) {
      var o = v.tone(lp, 'sawtooth', 90 * det[k], t, 0.06, 0.1, 0.55, 0.22);
      o.frequency.setValueAtTime(90 * det[k], t);
      o.frequency.exponentialRampToValueAtTime(220 * det[k], t + 0.42);
    }
  }

  function bell(v, f, t, peak, d) {
    v.tone(v.out, 'sine', f, t, 0.005, peak, d);
    v.tone(v.out, 'sine', f * 2, t, 0.004, peak * 0.2, d * 0.4);
  }

  // Happy doorbell going up: E5 -> A5.
  function sConnect() {
    var v = admit('connect');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    bell(v, midi(76), t, 0.24, 0.5);
    bell(v, midi(81), t + 0.16, 0.24, 0.6);
  }

  // Gentle, quiet two tones going down: A4 -> E4.
  function sDisconnect() {
    var v = admit('disconnect');
    if (!v) return;
    var t = ctx.currentTime + 0.01;
    bell(v, midi(69), t, 0.15, 0.45);
    bell(v, midi(64), t + 0.22, 0.15, 0.55);
  }

  // ---------------------------------------------------------------- scheduled sounds

  // Offroad: one soft low thump (80 Hz-ish sine, 40 ms) with a whisper of gravel.
  function thump(t) {
    var v = admit('thump', offroadBus, t);
    if (!v) return;
    var o = v.tone(v.out, 'sine', 80, t, 0.004, 0.5, 0.045);
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.04);
    var lp = v.filter('lowpass', 500, 0.7);
    var g = v.gain();
    var end = env(g.gain, t, 0.003, 0.08, 0.04);
    var n = v.noise(t, end + 0.01);
    n.connect(lp);
    lp.connect(g);
    g.connect(v.out);
  }

  // Meadow: a little bird tweet (2-4 rising chirps). Returns seconds until the next one.
  function bird(t) {
    var v = admit('amb', ambBus, t);
    if (v) {
      var n = 2 + Math.floor(Math.random() * 3);
      var f = rand(2600, 3600);
      for (var k = 0; k < n; k++) {
        var tk = t + k * rand(0.09, 0.13);
        var o = v.tone(v.out, 'sine', f, tk, 0.008, 0.035, 0.07);
        o.frequency.setValueAtTime(f * 0.8, tk);
        o.frequency.exponentialRampToValueAtTime(f * 1.25, tk + 0.05);
      }
    }
    return rand(2.5, 6.5);
  }

  // Beach: a slow wave swish (lowpassed noise swelling in and out over ~3.4 s).
  function wave(t) {
    var v = admit('amb', ambBus, t);
    if (v) {
      var lp = v.filter('lowpass', 250, 0.5);
      lp.frequency.setValueAtTime(250, t);
      lp.frequency.exponentialRampToValueAtTime(1100, t + 1.4);
      lp.frequency.exponentialRampToValueAtTime(300, t + 3.3);
      var g = v.gain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 1.4);
      g.gain.linearRampToValueAtTime(0, t + 3.4);
      var n = v.noise(t, t + 3.45);
      n.connect(lp);
      lp.connect(g);
      g.connect(v.out);
    }
    return rand(4.5, 8);
  }

  // Night: a cricket chirp group (2-3 chirps of 3 quick pulses at ~4.4 kHz).
  function cricket(t) {
    var v = admit('amb', ambBus, t);
    if (v) {
      var g = v.gain();
      var chirps = 2 + Math.floor(Math.random() * 2);
      var p = t;
      g.gain.setValueAtTime(0, t);
      for (var c = 0; c < chirps; c++) {
        for (var k = 0; k < 3; k++) {
          var tp = t + c * 0.25 + k * 0.035;
          g.gain.setValueAtTime(0, tp);
          g.gain.linearRampToValueAtTime(0.025, tp + 0.006);
          g.gain.linearRampToValueAtTime(0, tp + 0.018);
          p = tp + 0.018;
        }
      }
      var o = v.osc('sine', rand(4200, 4600), t, p + 0.02);
      o.connect(g);
      g.connect(v.out);
    }
    return rand(1.2, 3.7);
  }

  var AMB = { meadow: bird, beach: wave, night: cricket };

  function ambienceActive() {
    return !!(cur.biome && Object.prototype.hasOwnProperty.call(AMB, cur.biome));
  }

  function tick() {
    try {
      if (!isUnlocked()) return;
      var now = ctx.currentTime;
      var horizon = now + LOOKAHEAD;
      if (cur.offroad) {
        if (offNext < now + 0.01) offNext = now + 0.01;
        while (offNext < horizon) {
          thump(offNext);
          offNext += 0.12 * (1 + rand(-0.15, 0.15));
        }
      }
      if (ambienceActive()) {
        if (ambNext < now - 0.5) ambNext = now + rand(0.5, 1.5); // fell behind (tab throttled)
        else if (ambNext < now + 0.01) ambNext = now + 0.01;
        var fn = AMB[cur.biome];
        while (ambNext < horizon) ambNext += fn(ambNext);
      }
    } catch (e) { /* never throw from a timer */ }
  }

  function updateTimer() {
    var need = isUnlocked() && (cur.offroad || ambienceActive());
    if (need && !timer) {
      timer = setInterval(tick, TICK_MS);
      tick();
    } else if (!need && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ---------------------------------------------------------------- toggles

  function ensureEngine() {
    if (engine) return;
    var osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 70;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 450;
    lp.Q.value = 0.5;
    var wobble = ctx.createGain();
    wobble.gain.value = 1;
    var onOff = ctx.createGain();
    onOff.gain.value = 0;
    var lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.5;
    var lfoF = ctx.createGain();
    lfoF.gain.value = 3; // +-3 Hz pitch wobble
    var lfoA = ctx.createGain();
    lfoA.gain.value = 0.2; // +-20% loudness wobble
    lfo.connect(lfoF);
    lfoF.connect(osc.frequency);
    lfo.connect(lfoA);
    lfoA.connect(wobble.gain);
    osc.connect(lp);
    lp.connect(wobble);
    wobble.connect(onOff);
    onOff.connect(bus);
    osc.start();
    lfo.start();
    engine = { onOff: onOff };
  }

  function applyWants() {
    if (!isUnlocked()) {
      updateTimer();
      return;
    }
    if (want.engine !== cur.engine) {
      cur.engine = want.engine;
      ensureEngine();
      glide(engine.onOff.gain, cur.engine ? 0.03 : 0, cur.engine ? 0.15 : 0.08);
    }
    if (want.offroad !== cur.offroad) {
      cur.offroad = want.offroad;
      glide(offroadBus.gain, cur.offroad ? 1 : 0, 0.03);
      if (cur.offroad) offNext = ctx.currentTime + 0.01;
    }
    if (want.biome !== cur.biome) {
      cur.biome = want.biome;
      stealGroup('amb');
      ambNext = ctx.currentTime + rand(0.6, 2.0);
    }
    updateTimer();
  }

  // ---------------------------------------------------------------- public API

  function oneShot(fn) {
    return function (arg) {
      try {
        if (!isUnlocked()) return;
        fn(arg);
      } catch (e) { /* sounds must never break the game */ }
    };
  }

  var Sounds = {
    unlock: function () {
      try {
        if (!ctx && !build()) return;
        if (ctx.state !== 'running' && ctx.state !== 'closed') {
          var p = ctx.resume();
          if (p && typeof p.then === 'function') {
            p.then(function () {
              try { applyWants(); } catch (e) { /* ignore */ }
            }, function () { /* ignore */ });
          }
        }
        applyWants();
      } catch (e) { /* ignore */ }
    },

    isUnlocked: function () {
      try { return isUnlocked(); } catch (e) { return false; }
    },

    collect: oneShot(sCollect),
    splash: oneShot(sSplash),
    boing: oneShot(sBoing),
    celebrate: oneShot(sCelebrate),
    gate: oneShot(sGate),
    light: oneShot(sLight),
    go: oneShot(sGo),
    connect: oneShot(sConnect),
    disconnect: oneShot(sDisconnect),

    setOffroad: function (on) {
      try {
        on = !!on;
        if (on === want.offroad && on === cur.offroad) return;
        want.offroad = on;
        applyWants();
      } catch (e) { /* ignore */ }
    },

    setEngine: function (on) {
      try {
        on = !!on;
        if (on === want.engine && on === cur.engine) return;
        want.engine = on;
        applyWants();
      } catch (e) { /* ignore */ }
    },

    setBiome: function (name) {
      try {
        name = typeof name === 'string' ? name : null;
        if (name === want.biome && name === cur.biome) return;
        want.biome = name;
        applyWants();
      } catch (e) { /* ignore */ }
    }
  };

  W.Sounds = Sounds;
})();
