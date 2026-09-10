/* Cushion & Cue — procedural WebAudio. No audio files: every sound is a
 * short synthesized transient. Buses: music, effects, ambience, voice.
 * Pitch/variant randomness is seeded via CCRNG STREAM_AV so replays of
 * recorded sessions sound identical. Plain script → window.CCAudio.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CCRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCAudio = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STORAGE_KEY = 'cushion-and-cue-audio-v1';

  var ctx = null;
  var master = null;
  var buses = {};          // name -> GainNode
  var avRng = RNG.derive(0xC0FFEE, RNG.STREAM_AV);
  var ambienceNodes = null;
  var started = false;

  var volumes = { music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7 };
  var muted = false;

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  function loadVolumes() {
    try {
      var raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        for (var k in volumes) if (typeof d.volumes[k] === 'number') volumes[k] = clamp01(d.volumes[k]);
        muted = !!d.muted;
      }
    } catch (e) { /* corrupt or unavailable storage: keep defaults */ }
  }

  function saveVolumes() {
    try {
      if (typeof localStorage !== 'undefined')
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ volumes: volumes, muted: muted }));
    } catch (e) { /* storage unavailable */ }
  }

  function ensureCtx() {
    if (ctx) return true;
    var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    ['music', 'effects', 'ambience', 'voice'].forEach(function (name) {
      var g = ctx.createGain();
      g.gain.value = volumes[name];
      g.connect(master);
      buses[name] = g;
    });
    return true;
  }

  // Resume on first user gesture (browser autoplay policy).
  function unlock() {
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (!started) { started = true; startAmbience(); loadSfxManifest(); }
  }

  // ---------- authored samples: lazy fetch/decode/cache of sfx/<name>.opus ----------
  // Synthesis remains the fallback while a clip is loading or if it fails.

  var sfxByEvent = null;   // event name -> [clip basenames]
  var sfxState = {};       // clip basename -> 'loading' | 'failed' | AudioBuffer

  function loadSfxManifest() {
    if (sfxByEvent !== null || typeof fetch !== 'function') return;
    sfxByEvent = {};
    fetch('sfx/manifest.json').then(function (res) {
      if (!res.ok) throw new Error('manifest ' + res.status);
      return res.json();
    }).then(function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (item) {
        if (!item || typeof item.name !== 'string' || typeof item.event !== 'string') return;
        (sfxByEvent[item.event] = sfxByEvent[item.event] || []).push(item.name);
      });
      swapAmbience();
    }).catch(function () { /* no samples available: synthesis stays in use */ });
  }

  // Replace the synthesized hall noise with the authored 'ambience' clip once
  // it has decoded; any failure leaves the noise loop running untouched.
  function swapAmbience() {
    if (!ctx || !ambienceNodes || !sfxByEvent || !sfxByEvent.ambience || !sfxByEvent.ambience.length) return;
    var name = sfxByEvent.ambience[0];
    fetch('sfx/' + name + '.opus').then(function (res) {
      if (!res.ok) throw new Error('ambience ' + res.status);
      return res.arrayBuffer();
    }).then(function (ab) { return ctx.decodeAudioData(ab); }).then(function (buf) {
      if (!ambienceNodes || ambienceNodes.authored) return;
      var src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      var g = ctx.createGain();
      g.gain.value = 0.7;
      src.connect(g); g.connect(buses.ambience);
      src.start();
      try { ambienceNodes.src.stop(); } catch (e) { /* already stopped */ }
      ambienceNodes = { src: src, gain: g, authored: true };
    }).catch(function () { /* keep the synthesized room tone */ });
  }

  function loadSfxClip(name) {
    if (sfxState[name]) return;
    sfxState[name] = 'loading';
    fetch('sfx/' + name + '.opus').then(function (res) {
      if (!res.ok) throw new Error('clip ' + name + ' ' + res.status);
      return res.arrayBuffer();
    }).then(function (ab) {
      return ctx.decodeAudioData(ab);
    }).then(function (buf) {
      sfxState[name] = buf;
    }).catch(function () {
      sfxState[name] = 'failed';
    });
  }

  // Try to play an authored sample for this event through the effects bus.
  // Returns true when a decoded clip was actually started; false means the
  // caller should run its existing synthesis (clip still loading or failed).
  function playSfx(event) {
    if (!ctx || !sfxByEvent) return false;
    var names = sfxByEvent[event];
    if (!names || !names.length) return false;
    var name = names[Math.floor(avRng.next() * names.length)];
    var state = sfxState[name];
    if (!state) { loadSfxClip(name); return false; }
    if (state === 'loading' || state === 'failed') return false;
    var src = ctx.createBufferSource();
    src.buffer = state;
    src.connect(buses.effects);
    src.start();
    return true;
  }

  // ---------- synth primitives ----------

  // Short filtered noise burst: strikes, clicks, thuds.
  function noiseBurst(bus, dur, freq, q, gain, when) {
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (avRng.next() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f); f.connect(g); g.connect(buses[bus]);
    src.start(when); src.stop(when + dur + 0.02);
  }

  function tone(bus, type, f0, f1, dur, gain, when) {
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(buses[bus]);
    o.start(when); o.stop(when + dur + 0.02);
  }

  // ---------- ambience: quiet filtered-noise hall loop ----------
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    var len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = avRng.next() * 2 - 1;
    var src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 0.4;
    var g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f); f.connect(g); g.connect(buses.ambience);
    src.start();
    ambienceNodes = { src: src, gain: g };
  }

  // ---------- public event sounds ----------

  var api = {
    unlock: unlock,

    isAvailable: function () { return ensureCtx(); },

    getVolumes: function () {
      return { music: volumes.music, effects: volumes.effects, ambience: volumes.ambience, voice: volumes.voice, muted: muted };
    },
    setVolume: function (bus, v) {
      if (!(bus in volumes)) return;
      volumes[bus] = clamp01(v);
      if (ctx && buses[bus]) buses[bus].gain.value = volumes[bus];
      saveVolumes();
    },
    setMuted: function (m) {
      muted = !!m;
      if (master) master.gain.value = muted ? 0 : 1;
      saveVolumes();
    },

    // Reseed the AV stream (per session) so variants stay deterministic.
    reseed: function (seed) { avRng = RNG.derive(seed >>> 0, RNG.STREAM_AV); },

    strike: function (power) { // cue hits cue ball; power 0..1
      if (!ctx) return;
      if (playSfx('strike')) return;
      var t = ctx.currentTime;
      var v = 0.2 + 0.8 * (power || 0.5);
      noiseBurst('effects', 0.05, 2400 + avRng.next() * 600, 2.5, 0.5 * v, t);
      tone('effects', 'triangle', 900 + avRng.next() * 200, 500, 0.06, 0.2 * v, t);
    },

    ballClick: function (speed) { // ball-ball impact, layered by speed (m/s)
      if (!ctx) return;
      if (playSfx('ballClick')) return;
      var t = ctx.currentTime;
      var v = Math.min(1, (speed || 0.5) / 3);
      noiseBurst('effects', 0.03 + v * 0.02, 3200 + avRng.next() * 800, 4, 0.25 + 0.55 * v, t);
      if (v > 0.4) tone('effects', 'sine', 1400, 900, 0.04, 0.12 * v, t);
    },

    cushion: function (speed) {
      if (!ctx) return;
      if (playSfx('cushion')) return;
      var t = ctx.currentTime;
      var v = Math.min(1, (speed || 0.5) / 3);
      noiseBurst('effects', 0.09, 300 + avRng.next() * 120, 1.2, 0.2 + 0.35 * v, t);
      tone('effects', 'sine', 160, 90, 0.09, 0.15 * v, t);
    },

    pocketDrop: function () {
      if (!ctx) return;
      if (playSfx('pocketDrop')) return;
      var t = ctx.currentTime;
      noiseBurst('effects', 0.06, 800, 1.5, 0.4, t);
      tone('effects', 'sine', 320, 140, 0.18, 0.3, t + 0.03);
      noiseBurst('effects', 0.05, 500, 1.0, 0.2, t + 0.1);
    },

    foul: function () {
      if (!ctx) return;
      if (playSfx('foul')) return;
      var t = ctx.currentTime;
      tone('effects', 'sawtooth', 180, 150, 0.28, 0.18, t);
      tone('effects', 'square', 120, 100, 0.28, 0.1, t);
    },

    uiClick: function () {
      if (!ctx) return;
      if (playSfx('uiClick')) return;
      noiseBurst('effects', 0.025, 2000, 3, 0.15, ctx.currentTime);
    },

    turnChime: function () {
      if (!ctx) return;
      if (playSfx('turnChime')) return;
      var t = ctx.currentTime;
      tone('voice', 'sine', 660, 660, 0.09, 0.16, t);
      tone('voice', 'sine', 880, 880, 0.12, 0.16, t + 0.09);
    },

    cueBeep: function () { // voice bus cue (e.g. hint shown)
      if (!ctx) return;
      if (playSfx('cueBeep')) return;
      tone('voice', 'sine', 520, 520, 0.08, 0.14, ctx.currentTime);
    },

    rack: function () { // balls racked / table ready at game start
      if (!ctx) return;
      if (playSfx('rack')) return;
      var t = ctx.currentTime;
      for (var i = 0; i < 5; i++)
        noiseBurst('effects', 0.03, 2800 + avRng.next() * 900, 4, 0.18, t + i * 0.045 + avRng.next() * 0.01);
    },

    placeBall: function () { // cue ball set down for ball-in-hand
      if (!ctx) return;
      if (playSfx('placeBall')) return;
      var t = ctx.currentTime;
      noiseBurst('effects', 0.04, 900, 1.2, 0.22, t);
      tone('effects', 'sine', 240, 160, 0.07, 0.12, t);
    },

    groupsSet: function () { // solids/stripes assigned
      if (!ctx) return;
      if (playSfx('groups')) return;
      var t = ctx.currentTime;
      noiseBurst('effects', 0.035, 1500, 2.5, 0.25, t);
      noiseBurst('effects', 0.035, 1500, 2.5, 0.25, t + 0.11);
    },

    undo: function () { // shot rewound
      if (!ctx) return;
      if (playSfx('undo')) return;
      tone('effects', 'sine', 300, 700, 0.14, 0.12, ctx.currentTime);
    },

    achievement: function () { // achievement unlocked on the results card
      if (!ctx) return;
      if (playSfx('achievement')) return;
      var t = ctx.currentTime;
      var notes = [784, 988, 1175, 1568];
      for (var i = 0; i < notes.length; i++)
        tone('music', 'sine', notes[i], notes[i], 0.18, 0.16, t + i * 0.08);
    },

    win: function () {
      if (!ctx) return;
      if (playSfx('win')) return;
      var t = ctx.currentTime;
      var notes = [523, 659, 784, 1047];
      for (var i = 0; i < notes.length; i++)
        tone('music', 'triangle', notes[i], notes[i], 0.22, 0.2, t + i * 0.12);
    },

    lose: function () {
      if (!ctx) return;
      if (playSfx('lose')) return;
      var t = ctx.currentTime;
      var notes = [392, 330, 262];
      for (var i = 0; i < notes.length; i++)
        tone('music', 'triangle', notes[i], notes[i] * 0.94, 0.3, 0.18, t + i * 0.16);
    }
  };

  loadVolumes();
  return api;
});
