/* Cushion & Cue — pure deterministic rules engine.
 * No rendering, no DOM, no Date.now(): every transition derives from
 * (state, command) only. Usable from browser (window.CCRules) and Node.
 *
 * Two rulesets:
 *  - 'eightball': two players (hotseat or vs deterministic AI). Open table,
 *    groups assigned on first legal pot, standard fouls, ball-in-hand,
 *    8 last to win, 8 early / 8+scratch to lose.
 *  - 'clearance': solo. Pot every target ball within a shot limit; an
 *    optional black must go last. Fouls waste the shot and give ball-in-hand.
 *
 * Physics: fixed step (1/240 s), quantized inputs (angle in milliradians,
 * power/spin in permille), stable pair ordering, no wall-clock anywhere.
 * A shot resolves synchronously into an exact end state plus a sampled
 * trace (60 Hz frames + ordered events) that renderers replay cosmetically.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CCRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCRules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var STATE_VERSION = 1;

  // ---------- table & physics constants (meters, seconds) ----------
  var PLAY_W = 2.24;             // x extent between cushion faces
  var PLAY_H = 1.12;             // y extent between cushion faces
  var MIN_X = -PLAY_W / 2, MAX_X = PLAY_W / 2;
  var MIN_Y = -PLAY_H / 2, MAX_Y = PLAY_H / 2;
  var R = 0.0286;                // ball radius
  var HEAD_X = -PLAY_W / 4;      // head spot (cue ball line)
  var FOOT_X = PLAY_W / 4;       // foot spot (rack apex)
  var POCKETS = [
    { x: MIN_X, y: MIN_Y, cap: 0.078, kind: 'corner' },
    { x: MAX_X, y: MIN_Y, cap: 0.078, kind: 'corner' },
    { x: MIN_X, y: MAX_Y, cap: 0.078, kind: 'corner' },
    { x: MAX_X, y: MAX_Y, cap: 0.078, kind: 'corner' },
    { x: 0,     y: MIN_Y, cap: 0.068, kind: 'side' },
    { x: 0,     y: MAX_Y, cap: 0.068, kind: 'side' }
  ];
  var POCKET_MOUTH = 0.10;       // cushions open up inside this range
  var DT = 1 / 240;
  var MAX_TICKS = 2400;          // 10 s hard bound: no unbounded loops
  var SAMPLE_EVERY = 4;          // trace frames at 60 Hz
  var FRICTION = 0.5;            // m/s^2 rolling deceleration
  var STOP_SPEED = 0.01;
  var REST_BALL = 0.95;          // ball-ball restitution
  var REST_CUSHION = 0.75;       // cushion restitution
  var V_MAX = 4.2;               // m/s at power 1000
  var SPIN_FOLLOW = 0.5;         // top/back spin → post-contact follow/draw
  var SPIN_SIDE = 0.6;           // side spin → tangential kick off cushions

  var TERMINAL = {
    EIGHT_DONE: 'eight-complete',
    EIGHT_EARLY: 'eight-early',
    EIGHT_SCRATCH: 'eight-scratch',
    CLEAR: 'table-clear',
    SHOTS: 'shot-limit',
    BLACK_EARLY: 'black-early',
    BLACK_SCRATCH: 'black-scratch',
    RESIGN: 'resigned'
  };

  var INVALID = {
    ENDED: 'game-ended',
    BAD_CMD: 'unknown-command',
    BAD_SHAPE: 'malformed-command',
    BAD_ANGLE: 'bad-angle',
    BAD_POWER: 'bad-power',
    BAD_SPIN: 'bad-spin',
    NOT_IN_HAND: 'not-ball-in-hand',
    IN_HAND: 'must-place-cue-first',
    PLACE_BLOCKED: 'place-blocked',
    OUT_OF_BOUNDS: 'out-of-bounds'
  };

  var FOUL = {
    NO_CONTACT: 'no-contact',
    WRONG_FIRST: 'wrong-first-contact',
    NO_RAIL: 'no-rail-after-contact',
    SCRATCH: 'cue-ball-potted'
  };

  // ---------- helpers ----------

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) {
      var out = '[';
      for (var i = 0; i < v.length; i++) out += (i ? ',' : '') + stableStringify(v[i]);
      return out + ']';
    }
    var keys = Object.keys(v).sort(), s = '{';
    for (var k = 0; k < keys.length; k++) {
      s += (k ? ',' : '') + JSON.stringify(keys[k]) + ':' + stableStringify(v[keys[k]]);
    }
    return s + '}';
  }

  function hashState(state) {
    var s = stableStringify(state);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function q6(v) { return Math.round(v * 1e6) / 1e6; }
  function q9(v) { return Math.round(v * 1e9) / 1e9; }

  function dirFromMilli(angleMilli) {
    var a = angleMilli / 1000;
    return { x: q6(Math.cos(a)), y: q6(Math.sin(a)) };
  }

  function ballGroup(n) {
    if (n === 0) return 'cue';
    if (n === 8) return 'eight';
    return n < 8 ? 'solid' : 'stripe';
  }

  function serialize(state) { return JSON.stringify(state); }
  function deserialize(json) {
    var s = JSON.parse(json);
    if (s.v !== STATE_VERSION) throw new Error('unsupported state version ' + s.v);
    return s;
  }

  // ---------- layouts ----------

  // Standard 8-ball rack: apex 1 on the foot spot, 8 in the middle,
  // one solid + one stripe in the rear corners, rest shuffled by seed.
  function rackPositions(rng) {
    var order = [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];
    rng.shuffle(order);
    var slots = []; // row-major triangle, row 0 = apex toward cue
    for (var row = 0; row < 5; row++)
      for (var i = 0; i <= row; i++) slots.push({ row: row, i: i });
    var nums = new Array(15);
    nums[0] = 1;                                   // apex
    nums[4] = 8;                                   // center of row 2
    nums[11] = 7; nums[14] = 9;                    // rear corners: solid+stripe
    var k = 0;
    for (var s = 0; s < 15; s++) {
      if (nums[s]) continue;
      nums[s] = order[k++];
    }
    var gap = R * 2 + 0.0006;
    var balls = [{ id: 0, n: 0, x: HEAD_X, y: 0, potted: false }];
    for (var t = 0; t < 15; t++) {
      var sl = slots[t];
      balls.push({
        id: nums[t], n: nums[t],
        x: q9(FOOT_X + sl.row * gap * 0.8660254),
        y: q9((sl.i - sl.row / 2) * gap),
        potted: false
      });
    }
    return balls;
  }

  // Seeded scatter for clearance/lesson layouts: non-overlapping, pocket-safe.
  function scatterPositions(rng, numbers, cueAt) {
    var balls = [];
    function free(x, y) {
      if (x < MIN_X + R + 0.03 || x > MAX_X - R - 0.03) return false;
      if (y < MIN_Y + R + 0.03 || y > MAX_Y - R - 0.03) return false;
      for (var p = 0; p < POCKETS.length; p++) {
        var dx = x - POCKETS[p].x, dy = y - POCKETS[p].y;
        if (dx * dx + dy * dy < 0.14 * 0.14) return false;
      }
      for (var b = 0; b < balls.length; b++) {
        var ex = x - balls[b].x, ey = y - balls[b].y;
        if (ex * ex + ey * ey < (R * 2.4) * (R * 2.4)) return false;
      }
      return true;
    }
    function place() {
      for (var tries = 0; tries < 400; tries++) {
        var x = MIN_X + 0.06 + rng.next() * (PLAY_W - 0.12);
        var y = MIN_Y + 0.06 + rng.next() * (PLAY_H - 0.12);
        if (free(x, y)) return { x: q9(x), y: q9(y) };
      }
      // deterministic fallback grid (never reached in validated content)
      for (var gx = MIN_X + 0.1; gx < MAX_X; gx += 0.09)
        for (var gy = MIN_Y + 0.1; gy < MAX_Y; gy += 0.09)
          if (free(gx, gy)) return { x: q9(gx), y: q9(gy) };
      return { x: 0, y: 0 };
    }
    var cue = cueAt || { x: HEAD_X + rng.next() * 0.3 - 0.15, y: rng.next() * 0.5 - 0.25 };
    balls.push({ id: 0, n: 0, x: q9(cue.x), y: q9(cue.y), potted: false });
    for (var i = 0; i < numbers.length; i++) {
      var pos = place();
      balls.push({ id: numbers[i], n: numbers[i], x: pos.x, y: pos.y, potted: false });
    }
    return balls;
  }

  // ---------- game creation ----------

  function createGame(cfg) {
    if (!cfg || !Number.isInteger(cfg.seed)) throw new Error('config requires integer seed');
    var ruleset = cfg.ruleset || 'clearance';
    var rng = RNG.derive(cfg.seed, RNG.STREAM_RULES);
    var balls;
    if (cfg.layout === 'rack') balls = rackPositions(rng);
    else if (cfg.layout === 'scatter') {
      var numbers = cfg.ballNumbers || [1, 2, 3, 4, 5];
      balls = scatterPositions(rng, numbers, cfg.cueAt || null);
    } else if (cfg.layout === 'explicit') {
      balls = [{ id: 0, n: 0, x: cfg.cueAt.x, y: cfg.cueAt.y, potted: false }];
      for (var i = 0; i < cfg.balls.length; i++) {
        var b = cfg.balls[i];
        balls.push({ id: b.n, n: b.n, x: b.x, y: b.y, potted: false });
      }
    } else throw new Error('unknown layout ' + cfg.layout);

    var players;
    if (ruleset === 'eightball') {
      players = (cfg.players || [{ id: 'p1', name: 'Player 1' }, { id: 'p2', name: 'Player 2' }])
        .map(function (p) { return { id: p.id, name: p.name, ai: !!p.ai, skill: p.ai ? (p.skill != null ? p.skill : 0.5) : null, group: null, fouls: 0, pots: 0 }; });
    } else {
      players = [{ id: 'p1', name: (cfg.players && cfg.players[0] && cfg.players[0].name) || 'You', ai: false, group: null, fouls: 0, pots: 0 }];
    }

    return {
      v: STATE_VERSION,
      cfgId: cfg.id || 'unnamed',
      contentVersion: cfg.version || 1,
      kind: cfg.kind || 'practice',
      seed: cfg.seed,
      ruleset: ruleset,
      blackLast: ruleset === 'clearance' && !!cfg.blackLast,
      tick: 0,
      turn: 0,
      shotCount: 0,
      phase: 'aim',
      players: players,
      current: 0,
      balls: balls,
      ballInHand: false,
      openTable: true,
      breakDone: ruleset !== 'eightball',
      shotsLeft: ruleset === 'clearance' ? (cfg.shotLimit || 0) : 0,
      mechanics: Object.assign({ undo: true, hint: true }, cfg.mechanics || {}),
      par: cfg.par || null,
      score: { pots: 0, winBonus: 0, shotBonus: 0, foulPenalty: 0, total: 0 },
      foulsLog: [],
      terminal: null
    };
  }

  // ---------- command validation ----------

  function validateCommandShape(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return INVALID.BAD_SHAPE;
    if (cmd.type === 'shoot') {
      if (!Number.isInteger(cmd.angle) || cmd.angle < 0 || cmd.angle >= 6284) return INVALID.BAD_ANGLE;
      if (!Number.isInteger(cmd.power) || cmd.power < 0 || cmd.power > 1000) return INVALID.BAD_POWER;
      var st = cmd.spinTop == null ? 0 : cmd.spinTop;
      var ss = cmd.spinSide == null ? 0 : cmd.spinSide;
      if (!Number.isInteger(st) || st < -100 || st > 100) return INVALID.BAD_SPIN;
      if (!Number.isInteger(ss) || ss < -100 || ss > 100) return INVALID.BAD_SPIN;
      return null;
    }
    if (cmd.type === 'place') {
      if (!Number.isInteger(cmd.x) || !Number.isInteger(cmd.y)) return INVALID.BAD_SHAPE;
      return null;
    }
    if (cmd.type === 'resign') return null;
    return INVALID.BAD_CMD;
  }

  function checkCommand(state, cmd) {
    var shape = validateCommandShape(cmd);
    if (shape) return shape;
    if (state.terminal) return INVALID.ENDED;
    if (cmd.type === 'resign') return null;
    if (cmd.type === 'place') {
      if (!state.ballInHand) return INVALID.NOT_IN_HAND;
      var x = cmd.x / 1000, y = cmd.y / 1000;
      if (x < MIN_X + R || x > MAX_X - R || y < MIN_Y + R || y > MAX_Y - R) return INVALID.OUT_OF_BOUNDS;
      for (var i = 0; i < state.balls.length; i++) {
        var b = state.balls[i];
        if (b.potted || b.n === 0) continue;
        var dx = x - b.x, dy = y - b.y;
        if (dx * dx + dy * dy < (R * 2.05) * (R * 2.05)) return INVALID.PLACE_BLOCKED;
      }
      return null;
    }
    if (cmd.type === 'shoot') {
      if (state.ballInHand) return INVALID.IN_HAND;
      return null;
    }
    return null;
  }

  // What can the current actor do right now? Used by UI, tutorial, and tests.
  function legalActions(state) {
    if (state.terminal) return [];
    var acts = [];
    if (state.ballInHand) acts.push({ type: 'place' });
    else acts.push({ type: 'shoot', angleMin: 0, angleMax: 6283, powerMin: 0, powerMax: 1000 });
    acts.push({ type: 'resign' });
    return acts;
  }

  // ---------- physics ----------

  // Simulate a shot from the current aim state. Mutates nothing in `state`;
  // returns { balls (end positions), events, trace, meta }.
  function simulateShot(state, cmd) {
    var dir = dirFromMilli(cmd.angle);
    var v0 = (cmd.power / 1000) * V_MAX;
    var bs = state.balls.map(function (b) {
      return { n: b.n, x: b.x, y: b.y, vx: 0, vy: 0, potted: b.potted, spinSide: 0 };
    });
    var cue = bs[0];
    cue.vx = dir.x * v0; cue.vy = dir.y * v0;
    cue.spinSide = (cmd.spinSide || 0) / 100;
    var spinTop = (cmd.spinTop || 0) / 100;

    var events = [];
    var frames = [];
    var meta = {
      firstContact: -1, firstContactTick: -1, cushionAfterContact: false,
      potted: [], cuePotted: false, spinApplied: false
    };
    var tick0 = state.tick;
    var moving = v0 > 0;

    for (var t = 0; t < MAX_TICKS && moving; t++) {
      var tick = tick0 + t;
      // 1. integrate friction + position
      moving = false;
      for (var i = 0; i < bs.length; i++) {
        var b = bs[i];
        if (b.potted) continue;
        var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (sp > 0) {
          var dec = FRICTION * DT;
          if (sp <= Math.max(dec, STOP_SPEED)) { b.vx = 0; b.vy = 0; }
          else { var k = (sp - dec) / sp; b.vx *= k; b.vy *= k; moving = true; }
        }
        b.x += b.vx * DT; b.y += b.vy * DT;
      }
      // 2. pockets
      for (var pi = 0; pi < bs.length; pi++) {
        var bb = bs[pi];
        if (bb.potted) continue;
        for (var pj = 0; pj < POCKETS.length; pj++) {
          var pk = POCKETS[pj];
          var pdx = bb.x - pk.x, pdy = bb.y - pk.y;
          if (pdx * pdx + pdy * pdy < pk.cap * pk.cap) {
            bb.potted = true;
            var psp = Math.sqrt(bb.vx * bb.vx + bb.vy * bb.vy);
            bb.vx = 0; bb.vy = 0;
            events.push({ tick: tick, type: 'pocket', ball: bb.n, pocket: pj, speed: q6(psp) });
            if (bb.n === 0) meta.cuePotted = true; else meta.potted.push(bb.n);
            break;
          }
        }
      }
      // 3. ball-ball collisions (stable id order, two passes)
      for (var pass = 0; pass < 2; pass++) {
        for (var a = 0; a < bs.length; a++) {
          var ba = bs[a];
          if (ba.potted) continue;
          for (var c = a + 1; c < bs.length; c++) {
            var bc = bs[c];
            if (bc.potted) continue;
            var dx = bc.x - ba.x, dy = bc.y - ba.y;
            var d2 = dx * dx + dy * dy;
            var min = R * 2;
            if (d2 >= min * min || d2 === 0) continue;
            var d = Math.sqrt(d2);
            var nx = dx / d, ny = dy / d;
            // positional correction
            var push = (min - d) / 2 + 1e-9;
            ba.x -= nx * push; ba.y -= ny * push;
            bc.x += nx * push; bc.y += ny * push;
            // impulse along line of centers
            var rvn = (bc.vx - ba.vx) * nx + (bc.vy - ba.vy) * ny;
            if (rvn < 0) {
              var j = -(1 + REST_BALL) * rvn / 2;
              bc.vx += j * nx; bc.vy += j * ny;
              ba.vx -= j * nx; ba.vy -= j * ny;
              var impact = q6(-rvn);
              if (impact > 0.02) events.push({ tick: tick, type: 'hit', a: ba.n, b: bc.n, speed: impact });
              if (ba.n === 0 && meta.firstContact < 0) {
                meta.firstContact = bc.n; meta.firstContactTick = tick;
                // follow / draw: cue keeps or reverses along its incoming line
                if (!meta.spinApplied && spinTop !== 0) {
                  var add = spinTop * SPIN_FOLLOW * impact;
                  var len = Math.sqrt(dir.x * dir.x + dir.y * dir.y) || 1;
                  ba.vx += (dir.x / len) * add; ba.vy += (dir.y / len) * add;
                  meta.spinApplied = true;
                }
              }
            }
          }
        }
      }
      // 4. cushions (open near pocket mouths; hard outer clamp as backstop)
      for (var ci = 0; ci < bs.length; ci++) {
        var cb = bs[ci];
        if (cb.potted) continue;
        var nearPocket = false;
        for (var pp = 0; pp < POCKETS.length; pp++) {
          var cdx = cb.x - POCKETS[pp].x, cdy = cb.y - POCKETS[pp].y;
          if (cdx * cdx + cdy * cdy < POCKET_MOUTH * POCKET_MOUTH) { nearPocket = true; break; }
        }
        var hitAxis = 0;
        if (!nearPocket) {
          if (cb.x < MIN_X + R && cb.vx < 0) { cb.x = MIN_X + R; cb.vx = -cb.vx * REST_CUSHION; hitAxis = 1; }
          else if (cb.x > MAX_X - R && cb.vx > 0) { cb.x = MAX_X - R; cb.vx = -cb.vx * REST_CUSHION; hitAxis = 1; }
          if (cb.y < MIN_Y + R && cb.vy < 0) { cb.y = MIN_Y + R; cb.vy = -cb.vy * REST_CUSHION; hitAxis = 2; }
          else if (cb.y > MAX_Y - R && cb.vy > 0) { cb.y = MAX_Y - R; cb.vy = -cb.vy * REST_CUSHION; hitAxis = 2; }
        }
        // backstop: never leave the table surround
        if (cb.x < MIN_X - 0.15) { cb.x = MIN_X - 0.15; cb.vx = -cb.vx * 0.3; }
        if (cb.x > MAX_X + 0.15) { cb.x = MAX_X + 0.15; cb.vx = -cb.vx * 0.3; }
        if (cb.y < MIN_Y - 0.15) { cb.y = MIN_Y - 0.15; cb.vy = -cb.vy * 0.3; }
        if (cb.y > MAX_Y + 0.15) { cb.y = MAX_Y + 0.15; cb.vy = -cb.vy * 0.3; }
        if (hitAxis) {
          // side spin kicks tangentially off cushions, then bleeds away
          if (cb.n === 0 && cb.spinSide !== 0) {
            var nsp = Math.sqrt(cb.vx * cb.vx + cb.vy * cb.vy);
            if (hitAxis === 1) cb.vy += cb.spinSide * SPIN_SIDE * nsp;
            else cb.vx += cb.spinSide * SPIN_SIDE * nsp;
            cb.spinSide *= 0.4;
          }
          var csp = Math.sqrt(cb.vx * cb.vx + cb.vy * cb.vy);
          if (csp > 0.05) events.push({ tick: tick, type: 'cushion', ball: cb.n, speed: q6(csp) });
          if (meta.firstContactTick >= 0 && tick >= meta.firstContactTick) meta.cushionAfterContact = true;
        }
      }
      if (t % SAMPLE_EVERY === 0) {
        var frame = [];
        for (var f = 0; f < bs.length; f++) {
          frame.push(bs[f].potted ? null : q6(bs[f][ 'x' ]), bs[f].potted ? null : q6(bs[f].y));
        }
        frames.push(frame);
      }
    }
    // final exact frame (skip/fast-forward lands here — the authoritative state)
    var finalFrame = [];
    for (var g = 0; g < bs.length; g++) {
      finalFrame.push(bs[g].potted ? null : q9(bs[g].x), bs[g].potted ? null : q9(bs[g].y));
    }
    frames.push(finalFrame);
    return {
      balls: bs.map(function (b) { return { n: b.n, x: q9(b.x), y: q9(b.y), potted: b.potted }; }),
      events: events,
      trace: { dt: DT, every: SAMPLE_EVERY, frames: frames },
      meta: meta
    };
  }

  // ---------- shot adjudication ----------

  function legalTargets(state) {
    var p = state.players[state.current];
    var targets = [];
    for (var i = 0; i < state.balls.length; i++) {
      var b = state.balls[i];
      if (b.potted || b.n === 0) continue;
      if (state.ruleset === 'clearance') {
        if (state.blackLast && b.n === 8 && !onlyBlackLeft(state)) continue;
        targets.push(b.n);
      } else {
        if (state.openTable) { if (b.n !== 8) targets.push(b.n); }
        else if (p.group && pottedCount(state, p.group) === 7) { if (b.n === 8) targets.push(b.n); }
        else if (p.group && ballGroup(b.n) === p.group) targets.push(b.n);
      }
    }
    return targets;
  }

  function pottedCount(state, group) {
    var n = 0;
    for (var i = 0; i < state.balls.length; i++)
      if (state.balls[i].potted && state.balls[i].n !== 0 && ballGroup(state.balls[i].n) === group) n++;
    return n;
  }

  function onlyBlackLeft(state) {
    for (var i = 0; i < state.balls.length; i++) {
      var b = state.balls[i];
      if (!b.potted && b.n !== 0 && b.n !== 8) return false;
    }
    return true;
  }

  function remainingTargets(state) {
    var n = 0;
    for (var i = 0; i < state.balls.length; i++) {
      var b = state.balls[i];
      if (b.potted || b.n === 0) continue;
      if (state.ruleset === 'clearance') n++;
      else if (b.n !== 8) n++;
    }
    return n;
  }

  function addScore(state, field, pts) {
    state.score[field] += pts;
    state.score.total = state.score.pots + state.score.winBonus + state.score.shotBonus + state.score.foulPenalty;
  }

  function finish(state, reason, winnerIdx, events) {
    state.phase = 'ended';
    state.terminal = { reason: reason, turn: state.turn, shots: state.shotCount };
    if (winnerIdx != null) state.terminal.winner = state.players[winnerIdx].id;
    if (reason === TERMINAL.CLEAR || reason === TERMINAL.EIGHT_DONE) {
      addScore(state, 'winBonus', 500);
      if (state.ruleset === 'clearance') addScore(state, 'shotBonus', Math.max(0, state.shotsLeft) * 50);
    }
    events.push({ type: 'terminal', reason: reason, winner: state.terminal.winner || null });
  }

  // preTargets: legal first-contact balls evaluated BEFORE the shot.
  function applyShotOutcome(state, sim, events, preTargets) {
    var me = state.players[state.current];
    var meta = sim.meta;
    var fouls = [];
    var targets = preTargets;
    var onBreak = state.ruleset === 'eightball' && !state.breakDone;

    if (meta.cuePotted) fouls.push(FOUL.SCRATCH);
    if (meta.firstContact < 0) fouls.push(FOUL.NO_CONTACT);
    else if (targets.length && targets.indexOf(meta.firstContact) < 0) fouls.push(FOUL.WRONG_FIRST);
    if (meta.potted.length === 0 && !meta.cushionAfterContact && meta.firstContact >= 0) fouls.push(FOUL.NO_RAIL);

    var foul = fouls.length > 0;
    var eightPotted = meta.potted.indexOf(8) >= 0;

    for (var fi = 0; fi < fouls.length; fi++) {
      state.foulsLog.push({ turn: state.turn, player: me.id, foul: fouls[fi] });
      events.push({ type: 'foul', foul: fouls[fi], player: me.id });
    }
    if (foul) { me.fouls++; addScore(state, 'foulPenalty', -75); }

    state.shotCount++;
    if (state.ruleset === 'clearance') state.shotsLeft--;

    // pot bookkeeping
    var ownPotted = 0;
    for (var pi = 0; pi < meta.potted.length; pi++) {
      var n = meta.potted[pi];
      events.push({ type: 'pot', ball: n, player: me.id });
      if (n === 8) continue;
      if (state.ruleset === 'eightball') {
        var grp = ballGroup(n);
        if (state.openTable && !foul && state.breakDone) {
          // first legal pot after the break assigns groups
          me.group = grp;
          var other = state.players[1 - state.current];
          if (other) other.group = grp === 'solid' ? 'stripe' : 'solid';
          state.openTable = false;
          events.push({ type: 'groups', solid: grp === 'solid' ? me.id : (other && other.id), stripe: grp === 'stripe' ? me.id : (other && other.id) });
        }
        var owner = state.players[0].group === ballGroup(n) ? state.players[0] :
                    (state.players[1] && state.players[1].group === ballGroup(n) ? state.players[1] : me);
        owner.pots++;
        if (owner === me) ownPotted++;
      } else {
        me.pots++; ownPotted++;
      }
      addScore(state, 'pots', 100);
    }
    state.breakDone = true;

    // 8-ball endings (an 8 on the break is re-spotted by applyCommand instead)
    if (state.ruleset === 'eightball' && eightPotted && !onBreak) {
      if (foul) { finish(state, TERMINAL.EIGHT_SCRATCH, 1 - state.current, events); return; }
      var mineCleared = me.group && pottedCount(state, me.group) === 7;
      if (mineCleared) finish(state, TERMINAL.EIGHT_DONE, state.current, events);
      else finish(state, TERMINAL.EIGHT_EARLY, 1 - state.current, events);
      return;
    }

    if (state.ruleset === 'clearance') {
      var left = remainingTargets(state);
      if (state.blackLast && eightPotted) {
        if (left === 0 && !foul) { finish(state, TERMINAL.CLEAR, 0, events); return; }
        if (foul) { finish(state, TERMINAL.BLACK_SCRATCH, null, events); return; }
        finish(state, TERMINAL.BLACK_EARLY, null, events);
        return;
      }
      if (left === 0) { finish(state, TERMINAL.CLEAR, 0, events); return; }
      if (state.shotsLeft <= 0) { finish(state, TERMINAL.SHOTS, null, events); return; }
      // solo: never pass the turn; any foul grants ball-in-hand
      state.ballInHand = foul;
      return;
    }

    // eightball turn flow
    if (foul) {
      state.current = 1 - state.current;
      state.turn++;
      state.ballInHand = true;
    } else if (ownPotted === 0) {
      state.current = 1 - state.current;
      state.turn++;
      state.ballInHand = false;
    } else {
      state.ballInHand = false; // legal pot: same player continues
    }
  }

  // Re-spot the 8 (used when it leaves the table on the break).
  function respotEight(state) {
    var eight = null;
    for (var i = 0; i < state.balls.length; i++) if (state.balls[i].n === 8) eight = state.balls[i];
    if (!eight || !eight.potted) return;
    var spots = [{ x: FOOT_X, y: 0 }];
    for (var k = 1; k < 12; k++) spots.push({ x: FOOT_X + k * R * 2.2, y: 0 });
    for (var s = 0; s < spots.length; s++) {
      var ok = true;
      for (var b = 0; b < state.balls.length; b++) {
        var ob = state.balls[b];
        if (ob.potted || ob.n === 8) continue;
        var dx = spots[s].x - ob.x, dy = spots[s].y - ob.y;
        if (dx * dx + dy * dy < (R * 2.1) * (R * 2.1)) { ok = false; break; }
      }
      if (ok && spots[s].x < MAX_X - R) {
        eight.potted = false; eight.x = q9(spots[s].x); eight.y = 0;
        return;
      }
    }
  }

  // ---------- public command entry ----------

  function applyCommand(state, cmd) {
    var err = checkCommand(state, cmd);
    if (err) return { ok: false, invalid: err, state: state, events: [] };
    var next = clone(state);
    var events = [];
    var trace = null;

    if (cmd.type === 'resign') {
      var winner = next.ruleset === 'eightball' ? 1 - next.current : null;
      finish(next, TERMINAL.RESIGN, winner, events);
      return { ok: true, state: next, events: events, trace: null };
    }

    if (cmd.type === 'place') {
      var cue = next.balls[0];
      cue.potted = false;
      cue.x = cmd.x / 1000; cue.y = cmd.y / 1000;
      next.ballInHand = false;
      events.push({ type: 'place', x: cue.x, y: cue.y });
      return { ok: true, state: next, events: events, trace: null };
    }

    // shoot
    var wasBreak = next.ruleset === 'eightball' && !next.breakDone;
    var preTargets = legalTargets(next); // legality judged against pre-shot layout
    var sim = simulateShot(next, cmd);
    for (var i = 0; i < sim.balls.length; i++) {
      var sb = sim.balls[i], ob = next.balls[i];
      ob.x = sb.x; ob.y = sb.y; ob.potted = sb.potted;
    }
    next.tick += MAX_TICKS; // monotonic: next shot's tick base always ahead
    var shotEvents = sim.events.map(function (e) { return e; });
    applyShotOutcome(next, sim, events, preTargets);
    if (wasBreak) {
      var eightDown = false;
      for (var b2 = 0; b2 < next.balls.length; b2++)
        if (next.balls[b2].n === 8 && next.balls[b2].potted) eightDown = true;
      if (eightDown && !next.terminal) { respotEight(next); events.push({ type: 'respot', ball: 8 }); }
    }
    events.unshift({ type: 'shoot', angle: cmd.angle, power: cmd.power, spinTop: cmd.spinTop || 0, spinSide: cmd.spinSide || 0 });
    // merge: physics detail events are exposed separately for audio/VFX sync
    return { ok: true, state: next, events: events, physics: shotEvents, trace: sim.trace, meta: sim.meta };
  }

  // ---------- aiming & hints (same legality data the UI previews) ----------

  // Ray from the cue ball at `angleMilli`: nearest ball or cushion contact.
  function aimPreview(state, angleMilli) {
    var cue = state.balls[0];
    if (cue.potted) return null;
    var d = dirFromMilli(angleMilli);
    var best = null;
    for (var i = 1; i < state.balls.length; i++) {
      var b = state.balls[i];
      if (b.potted) continue;
      var rx = b.x - cue.x, ry = b.y - cue.y;
      var proj = rx * d.x + ry * d.y;
      if (proj <= 0) continue;
      var perp2 = rx * rx + ry * ry - proj * proj;
      var rr = (R * 2) * (R * 2);
      if (perp2 >= rr) continue;
      var tHit = proj - Math.sqrt(rr - perp2);
      if (tHit > 0 && (!best || tHit < best.dist)) {
        best = { dist: q6(tHit), x: q6(cue.x + d.x * tHit), y: q6(cue.y + d.y * tHit), ball: b.n };
      }
    }
    // cushion intersections
    var tC = Infinity, cx = 0, cy = 0;
    if (d.x > 0) { var t1 = (MAX_X - R - cue.x) / d.x; if (t1 > 0 && t1 < tC) { tC = t1; } }
    if (d.x < 0) { var t2 = (MIN_X + R - cue.x) / d.x; if (t2 > 0 && t2 < tC) { tC = t2; } }
    if (d.y > 0) { var t3 = (MAX_Y - R - cue.y) / d.y; if (t3 > 0 && t3 < tC) { tC = t3; } }
    if (d.y < 0) { var t4 = (MIN_Y + R - cue.y) / d.y; if (t4 > 0 && t4 < tC) { tC = t4; } }
    if (tC < Infinity && (!best || tC < best.dist)) {
      return { dist: q6(tC), x: q6(cue.x + d.x * tC), y: q6(cue.y + d.y * tC), ball: null };
    }
    return best;
  }

  function pathClear(state, x0, y0, x1, y1, ignoreN) {
    var dx = x1 - x0, dy = y1 - y0;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return true;
    for (var i = 0; i < state.balls.length; i++) {
      var b = state.balls[i];
      if (b.potted || b.n === 0 || b.n === ignoreN) continue;
      var t = ((b.x - x0) * dx + (b.y - y0) * dy) / len2;
      if (t <= 0.02 || t >= 0.98) continue;
      var px = x0 + dx * t, py = y0 + dy * t;
      var ex = b.x - px, ey = b.y - py;
      if (ex * ex + ey * ey < (R * 2.1) * (R * 2.1)) return false;
    }
    return true;
  }

  // Deterministic shot suggestion. skill in [0,1]: 1 = near-perfect.
  // Uses an AI stream derived from (seed, shotCount) so replays stay stable.
  function computeAIShot(state, skill) {
    var targets = legalTargets(state);
    if (!targets.length) targets = [8];
    var cue = state.balls[0];
    var rng = RNG.create(((state.seed >>> 0) ^ RNG.STREAM_AI ^ (state.shotCount * 0x9e3779b9)) >>> 0);
    var best = null;
    for (var ti = 0; ti < targets.length; ti++) {
      var ball = null;
      for (var bi = 0; bi < state.balls.length; bi++)
        if (state.balls[bi].n === targets[ti]) ball = state.balls[bi];
      if (!ball || ball.potted) continue;
      for (var pi = 0; pi < POCKETS.length; pi++) {
        var pk = POCKETS[pi];
        var pdx = pk.x - ball.x, pdy = pk.y - ball.y;
        var pd = Math.sqrt(pdx * pdx + pdy * pdy);
        if (pd < 0.01) continue;
        // ghost-ball position behind the target, on the pocket line
        var gx = ball.x - (pdx / pd) * R * 2, gy = ball.y - (pdy / pd) * R * 2;
        var cdx = gx - cue.x, cdy = gy - cue.y;
        var cd = Math.sqrt(cdx * cdx + cdy * cdy);
        if (cd < 0.01) continue;
        // cut angle between cue→ghost and ball→pocket
        var dot = (cdx * pdx + cdy * pdy) / (cd * pd);
        if (dot < 0.15) continue; // cut too thin
        if (!pathClear(state, cue.x, cue.y, gx, gy, ball.n)) continue;
        if (!pathClear(state, ball.x, ball.y, pk.x, pk.y, ball.n)) continue;
        var score = cd + pd + (1 - dot) * 1.5;
        if (!best || score < best.score) {
          best = { score: score, gx: gx, gy: gy, cd: cd, pd: pd, dot: dot };
        }
      }
    }
    var angle, power;
    if (best) {
      angle = Math.atan2(best.gy - cue.y, best.gx - cue.x);
      power = Math.min(900, Math.round(280 + best.cd * 260 + best.pd * 300 + (1 - best.dot) * 160));
    } else {
      // safety: roll the cue into the nearest legal ball
      var near = null, nd = Infinity;
      for (var ni = 0; ni < targets.length; ni++) {
        for (var bi2 = 0; bi2 < state.balls.length; bi2++) {
          var bb = state.balls[bi2];
          if (bb.n !== targets[ni] || bb.potted) continue;
          var ddx = bb.x - cue.x, ddy = bb.y - cue.y;
          var dd = ddx * ddx + ddy * ddy;
          if (dd < nd) { nd = dd; near = bb; }
        }
      }
      if (!near) return { angle: 0, power: 300, spinTop: 0, spinSide: 0 };
      angle = Math.atan2(near.y - cue.y, near.x - cue.x);
      power = 320;
    }
    // seeded imprecision by skill
    var maxErr = (1 - skill) * 0.055;
    angle += (rng.next() * 2 - 1) * maxErr;
    power = Math.max(60, Math.min(1000, Math.round(power * (1 + (rng.next() * 2 - 1) * (1 - skill) * 0.18))));
    var milli = Math.round(((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * 1000) % 6284;
    return { angle: milli, power: power, spinTop: 0, spinSide: 0 };
  }

  function computeAIPlace(state) {
    // behind the head string, drifting to the first free lane
    var candidates = [];
    for (var y = -0.4; y <= 0.4; y += 0.1)
      for (var x = MIN_X + 0.08; x <= 0; x += 0.12)
        candidates.push({ x: x, y: y });
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i], ok = true;
      for (var b = 0; b < state.balls.length; b++) {
        var ob = state.balls[b];
        if (ob.potted || ob.n === 0) continue;
        var dx = c.x - ob.x, dy = c.y - ob.y;
        if (dx * dx + dy * dy < (R * 2.1) * (R * 2.1)) { ok = false; break; }
      }
      if (ok) return { x: Math.round(c.x * 1000), y: Math.round(c.y * 1000) };
    }
    return { x: Math.round(HEAD_X * 1000), y: 400 };
  }

  // Hint = high-skill AI suggestion; tutorials and the hint button share it.
  function hint(state) {
    if (state.ballInHand) return { place: computeAIPlace(state) };
    return { shot: computeAIShot(state, 0.97) };
  }

  return {
    STATE_VERSION: STATE_VERSION,
    TABLE: {
      PLAY_W: PLAY_W, PLAY_H: PLAY_H, MIN_X: MIN_X, MAX_X: MAX_X, MIN_Y: MIN_Y, MAX_Y: MAX_Y,
      R: R, HEAD_X: HEAD_X, FOOT_X: FOOT_X, POCKETS: POCKETS, POCKET_MOUTH: POCKET_MOUTH
    },
    PHYS: { DT: DT, MAX_TICKS: MAX_TICKS, V_MAX: V_MAX, SAMPLE_EVERY: SAMPLE_EVERY },
    TERMINAL: TERMINAL,
    INVALID: INVALID,
    FOUL: FOUL,
    createGame: createGame,
    applyCommand: applyCommand,
    checkCommand: checkCommand,
    validateCommandShape: validateCommandShape,
    legalActions: legalActions,
    legalTargets: legalTargets,
    remainingTargets: remainingTargets,
    pottedCount: pottedCount,
    ballGroup: ballGroup,
    aimPreview: aimPreview,
    computeAIShot: computeAIShot,
    computeAIPlace: computeAIPlace,
    hint: hint,
    rackPositions: rackPositions,
    scatterPositions: scatterPositions,
    hashState: hashState,
    stableStringify: stableStringify,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone
  };
});
