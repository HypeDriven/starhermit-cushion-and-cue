/* Cushion & Cue — zero-dependency test runner. Run: node tests/run-tests.js
 * Covers rng, rules (legality, fouls, endings, serialization, replay
 * determinism, AI legality) and content validation (legality, reachability,
 * bounded duration). Exits nonzero on the first failing section's summary.
 */
'use strict';

const RNG = require('../js/rng.js');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const solver = require('./solver.js');

const T = Rules.TABLE;
let passed = 0, failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error('FAIL: ' + name); }
}
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(name, fn) {
  const before = failed;
  try { fn(); }
  catch (e) { failed++; failures.push(name + ': threw ' + e.message); console.error('FAIL(threw): ' + name, e); }
  console.log((failed === before ? '  ok ' : '  BAD ') + name);
}

function shoot(state, angle, power, spinTop, spinSide) {
  return Rules.applyCommand(state, { type: 'shoot', angle, power, spinTop: spinTop || 0, spinSide: spinSide || 0 });
}
function scatterCfg(seed, extra) {
  return Object.assign({ seed, ruleset: 'clearance', layout: 'scatter', ballNumbers: [1, 2, 3], shotLimit: 10 }, extra || {});
}
function explicitClear(balls, cueAt, extra) {
  return Object.assign({ seed: 5, ruleset: 'clearance', layout: 'explicit', cueAt, balls, shotLimit: 20 }, extra || {});
}
function explicitEight(balls, cueAt, extra) {
  return Object.assign({ seed: 6, ruleset: 'eightball', layout: 'explicit', cueAt, balls,
    players: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] }, extra || {});
}

// ---------------------------------------------------------------- rng ------
section('rng: determinism', () => {
  const a = RNG.create(42), b = RNG.create(42);
  for (let i = 0; i < 100; i++) eq(a.next(), b.next(), 'rng seq diverged at ' + i);
  const s1 = RNG.streams(7), s2 = RNG.streams(7);
  eq(s1.rules.next(), s2.rules.next(), 'streams deterministic');
});
section('rng: stream independence', () => {
  const s = RNG.streams(99);
  const seqs = { rules: [], decor: [], av: [], ai: [] };
  for (const k of Object.keys(seqs)) for (let i = 0; i < 8; i++) seqs[k].push(s[k].next());
  const seen = new Set();
  for (const k of Object.keys(seqs)) {
    const key = seqs[k].join(',');
    ok(!seen.has(key), 'stream ' + k + ' collides with another stream');
    seen.add(key);
  }
  eq(RNG.hashString('a'), RNG.hashString('a'), 'hashString deterministic');
  ok(RNG.hashString('a') !== RNG.hashString('b'), 'hashString varies');
});

// ---------------------------------------------------------------- layouts --
section('rules: createGame all layouts', () => {
  for (const layout of ['rack', 'scatter', 'explicit']) {
    const cfg = layout === 'rack' ? { seed: 1, ruleset: 'eightball', layout }
      : layout === 'scatter' ? scatterCfg(2)
      : explicitClear([{ n: 1, x: 0.3, y: 0.1 }], { x: -0.5, y: 0 });
    const s = Rules.createGame(cfg);
    eq(s.layout, undefined, 'state has no layout leak'); // sanity: state shape
    ok(s.balls.length > 0, 'balls exist for ' + layout);
    for (const b of s.balls) {
      ok(b.x >= T.MIN_X - 0.001 && b.x <= T.MAX_X + 0.001, layout + ' ball x in bounds');
      ok(b.y >= T.MIN_Y - 0.001 && b.y <= T.MAX_Y + 0.001, layout + ' ball y in bounds');
    }
    for (let i = 0; i < s.balls.length; i++)
      for (let j = i + 1; j < s.balls.length; j++) {
        const dx = s.balls[i].x - s.balls[j].x, dy = s.balls[i].y - s.balls[j].y;
        ok(dx * dx + dy * dy >= (T.R * 1.9) ** 2, layout + ' balls overlap');
      }
  }
  const rack = Rules.createGame({ seed: 1, ruleset: 'eightball', layout: 'rack' });
  eq(rack.balls.length, 16, 'rack has 16 balls');
  // AI skill preserved from config (session AI depends on it)
  const m = Rules.createGame({ seed: 1, ruleset: 'eightball', layout: 'rack',
    players: [{ id: 'p1', name: 'You' }, { id: 'ai', name: 'Bot', ai: true, skill: 0.42 }] });
  eq(m.players[1].skill, 0.42, 'AI skill preserved in state');
});

// ------------------------------------------------------- invalid commands --
section('rules: every INVALID reason reachable', () => {
  const s = Rules.createGame(scatterCfg(3));
  const bad = (cmd, want, name) => {
    const r = Rules.applyCommand(s, cmd);
    eq(r.ok, false, name + ' rejected');
    eq(r.invalid, want, name + ' reason');
  };
  bad({ type: 'shoot', angle: -1, power: 100 }, Rules.INVALID.BAD_ANGLE, 'bad angle low');
  bad({ type: 'shoot', angle: 6284, power: 100 }, Rules.INVALID.BAD_ANGLE, 'bad angle high');
  bad({ type: 'shoot', angle: 0, power: 1001 }, Rules.INVALID.BAD_POWER, 'bad power');
  bad({ type: 'shoot', angle: 0, power: 100, spinTop: 101 }, Rules.INVALID.BAD_SPIN, 'bad spinTop');
  bad({ type: 'shoot', angle: 0, power: 100, spinSide: -101 }, Rules.INVALID.BAD_SPIN, 'bad spinSide');
  bad({ type: 'shoot', angle: 1.5, power: 100 }, Rules.INVALID.BAD_ANGLE, 'non-integer angle');
  bad({ type: 'shoot' }, Rules.INVALID.BAD_ANGLE, 'missing angle');
  bad({ type: 'dance' }, Rules.INVALID.BAD_CMD, 'unknown command');
  bad(null, Rules.INVALID.BAD_SHAPE, 'null command');
  bad({ type: 'place', x: 1.5, y: 0 }, Rules.INVALID.BAD_SHAPE, 'place floats');
  bad({ type: 'place', x: 0, y: 0 }, Rules.INVALID.NOT_IN_HAND, 'place without ball in hand');

  // ball in hand path: foul by shooting the cue into a pocket directly
  const scratchSetup = Rules.createGame(explicitClear([{ n: 1, x: 0.6, y: 0.4 }], { x: -0.9, y: -0.3 }));
  const intoPocket = Math.round(Math.atan2(T.MIN_Y - (-0.3), T.MIN_X - (-0.9)) * 1000 + Math.PI * 2000) % 6284;
  let r = shoot(scratchSetup, intoPocket, 900);
  ok(r.ok, 'scratch shot applies');
  ok(r.state.ballInHand, 'scratch grants ball in hand');
  eq(Rules.applyCommand(r.state, { type: 'shoot', angle: 0, power: 100 }).invalid, Rules.INVALID.IN_HAND, 'shoot while in hand');
  eq(Rules.applyCommand(r.state, { type: 'place', x: 99999, y: 0 }).invalid, Rules.INVALID.OUT_OF_BOUNDS, 'place out of bounds');
  const near = r.state.balls.find(b => b.n === 1);
  if (near && !near.potted) {
    eq(Rules.applyCommand(r.state, { type: 'place', x: Math.round(near.x * 1000), y: Math.round(near.y * 1000) }).invalid,
      Rules.INVALID.PLACE_BLOCKED, 'place blocked by ball');
  }
  // ended
  const done = Rules.applyCommand(r.state, { type: 'resign' });
  ok(done.ok && done.state.terminal, 'resign ends game');
  eq(Rules.applyCommand(done.state, { type: 'shoot', angle: 0, power: 100 }).invalid, Rules.INVALID.ENDED, 'shoot after end');
  eq(Rules.applyCommand(done.state, { type: 'resign' }).invalid, Rules.INVALID.ENDED, 'resign after end');
});

// ---------------------------------------------------------------- fouls ----
section('rules: foul detection', () => {
  // no-contact: soft shot away from every ball
  let s = Rules.createGame(explicitClear([{ n: 1, x: 0.6, y: 0.4 }], { x: -0.8, y: -0.3 }));
  let r = shoot(s, Math.round(Math.atan2(0.3, -0.2) * 1000 + Math.PI * 1000) % 6284, 60);
  ok(r.ok && r.events.some(e => e.type === 'foul' && e.foul === Rules.FOUL.NO_CONTACT), 'no-contact foul');

  // wrong-first: black last, aim at the black while others remain
  s = Rules.createGame(explicitClear([{ n: 1, x: 0.5, y: 0.3 }, { n: 8, x: 0.2, y: 0 }], { x: -0.4, y: 0 }, { blackLast: true }));
  r = shoot(s, 0, 500); // straight +x into the 8
  ok(r.ok && r.events.some(e => e.type === 'foul' && e.foul === Rules.FOUL.WRONG_FIRST), 'wrong-first foul');

  // no-rail: gentle straight hit on a mid-table ball, no pot, no cushion
  s = Rules.createGame(explicitClear([{ n: 1, x: 0.05, y: 0 }], { x: -0.3, y: 0 }));
  let noRail = null;
  for (const p of [150, 180, 210, 240]) {
    const rr = shoot(s, 0, p);
    if (rr.events.some(e => e.type === 'foul' && e.foul === Rules.FOUL.NO_RAIL)) { noRail = rr; break; }
  }
  ok(noRail, 'no-rail foul');

  // scratch
  s = Rules.createGame(explicitClear([{ n: 1, x: 0.6, y: 0.4 }], { x: -0.9, y: -0.3 }));
  const ang = Math.round(Math.atan2(T.MIN_Y + 0.3, T.MIN_X + 0.9) * 1000 + Math.PI * 2000) % 6284;
  r = shoot(s, ang, 900);
  ok(r.events.some(e => e.type === 'foul' && e.foul === Rules.FOUL.SCRATCH), 'scratch foul');
});

// Aim helper: milliradian angle from cue ball to the ghost position that
// sends `ball` toward `pocket` (real pocket coordinates only).
function ghostAngle(cue, ball, pocket) {
  const pdx = pocket.x - ball.x, pdy = pocket.y - ball.y;
  const pd = Math.hypot(pdx, pdy);
  const gx = ball.x - (pdx / pd) * T.R * 2, gy = ball.y - (pdy / pd) * T.R * 2;
  return Math.round(((Math.atan2(gy - cue.y, gx - cue.x) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * 1000) % 6284;
}
const CORNER = T.POCKETS[3]; // (MAX_X, MAX_Y)

// ------------------------------------------------------ clearance endings --
section('rules: clearance endings', () => {
  // clean win: single ball potted into a real corner pocket
  let s = Rules.createGame(explicitClear([{ n: 1, x: 0.6, y: 0.2 }], { x: -0.6, y: 0.2 }));
  let r = shoot(s, ghostAngle(s.balls[0], s.balls[1], CORNER), 700);
  ok(r.ok && r.state.terminal && r.state.terminal.reason === Rules.TERMINAL.CLEAR, 'clearance win');
  ok(r.state.score.winBonus === 500 && r.state.score.pots === 100, 'win score components');

  // shot limit: waste every shot (place far, dribble nowhere)
  s = Rules.createGame(explicitClear([{ n: 1, x: 0.6, y: 0.4 }], { x: -0.8, y: -0.3 }, { shotLimit: 3 }));
  let guard = 0;
  while (!s.terminal && guard++ < 40) {
    if (s.ballInHand) s = Rules.applyCommand(s, { type: 'place', x: -800, y: -300 }).state;
    else s = shoot(s, Math.round(1.5 * Math.PI * 1000) % 6284, 40).state;
  }
  eq(s.terminal && s.terminal.reason, Rules.TERMINAL.SHOTS, 'shot-limit ending');

  // black early: the 1 is contacted first (legal) and kisses the 8 in
  {
    const pk = CORNER;
    const b8 = { n: 8, x: pk.x - 0.3, y: pk.y - 0.12 };
    const dir = { x: (pk.x - b8.x), y: (pk.y - b8.y) };
    const dl = Math.hypot(dir.x, dir.y); dir.x /= dl; dir.y /= dl;
    const b1 = { n: 1, x: b8.x - dir.x * 0.35, y: b8.y - dir.y * 0.35 };
    const cue = { x: b1.x - dir.x * 0.45, y: b1.y - dir.y * 0.45 };
    const s2 = Rules.createGame(explicitClear([b1, b8], cue, { blackLast: true, shotLimit: 9 }));
    const ang = Math.round(Math.atan2(dir.y, dir.x) * 1000 + Math.PI * 2000) % 6284;
    let early = null;
    for (const p of [500, 650, 800]) {
      const rr = shoot(s2, ang, p);
      if (rr.state.terminal && rr.state.terminal.reason === Rules.TERMINAL.BLACK_EARLY) { early = rr; break; }
    }
    ok(early, 'black-early loss');
  }

  // black + scratch: only the 8 left, follow spin carries the cue in behind it
  {
    const pk = CORNER;
    const b8 = { n: 8, x: pk.x - 0.14, y: pk.y - 0.14 };
    const dir = { x: pk.x - b8.x, y: pk.y - b8.y };
    const dl = Math.hypot(dir.x, dir.y); dir.x /= dl; dir.y /= dl;
    const cue = { x: b8.x - dir.x * 0.55, y: b8.y - dir.y * 0.55 };
    const s2 = Rules.createGame(explicitClear([b8], cue, { blackLast: true, shotLimit: 9 }));
    const ang = Math.round(Math.atan2(dir.y, dir.x) * 1000 + Math.PI * 2000) % 6284;
    let scratchWin = null;
    for (const p of [500, 700, 900, 1000]) {
      const rr = shoot(s2, ang, p, 100);
      if (rr.state.terminal && rr.state.terminal.reason === Rules.TERMINAL.BLACK_SCRATCH) { scratchWin = rr; break; }
    }
    ok(scratchWin, 'black-scratch loss reachable');
  }
});

// ---------------------------------------------------------- eightball ------
section('rules: eightball flow', () => {
  // group assignment: pot a solid from an explicit layout
  let s = Rules.createGame(explicitEight(
    [{ n: 1, x: 0.6, y: 0.2 }, { n: 9, x: 0.2, y: -0.3 }, { n: 8, x: -0.2, y: -0.1 }],
    { x: -0.6, y: 0.2 }));
  s.breakDone = true; // skip break semantics; first legal pot assigns groups
  let r = null;
  for (const p of [250, 350, 450, 550]) {
    const rr = shoot(s, ghostAngle(s.balls[0], s.balls[1], CORNER), p);
    if (rr.events.some(e => e.type === 'groups')) { r = rr; break; }
  }
  ok(r && r.ok, 'solid potted cleanly');
  eq(r.state.players[0].group, 'solid', 'p1 takes solids');
  eq(r.state.players[1].group, 'stripe', 'p2 takes stripes');
  eq(r.state.current, 0, 'potter keeps the turn');

  // turn passing: a miss passes the turn
  s = r.state;
  r = shoot(s, Math.round(Math.PI * 1000), 120); // backwards into nothing
  eq(r.state.current, 1, 'miss passes turn');
  ok(r.state.turn === 1, 'turn counter increments');

  // 8 early loss: legal first contact with the 1, which kisses the 8 in
  {
    const pk = CORNER;
    const b8 = { n: 8, x: pk.x - 0.3, y: pk.y - 0.12 };
    const dir = { x: pk.x - b8.x, y: pk.y - b8.y };
    const dl = Math.hypot(dir.x, dir.y); dir.x /= dl; dir.y /= dl;
    const b1 = { n: 1, x: b8.x - dir.x * 0.35, y: b8.y - dir.y * 0.35 };
    const cue = { x: b1.x - dir.x * 0.45, y: b1.y - dir.y * 0.45 };
    const s2 = Rules.createGame(explicitEight([b1, b8, { n: 9, x: -0.3, y: -0.4 }], cue));
    s2.breakDone = true;
    const ang = Math.round(Math.atan2(dir.y, dir.x) * 1000 + Math.PI * 2000) % 6284;
    let early8 = null;
    for (const p of [500, 650, 800]) {
      const rr = shoot(s2, ang, p);
      if (rr.state.terminal && rr.state.terminal.reason === Rules.TERMINAL.EIGHT_EARLY) { early8 = rr; break; }
    }
    ok(early8, '8 early loses');
    eq(early8 && early8.state.terminal.winner, 'p2', 'other player wins');
  }

  // helper: state where p1 has solids legally cleared down to the 8,
  // with the 8 hanging on the corner and the cue on the pocket line
  function onTheEight() {
    const b8 = { n: 8, x: CORNER.x - 0.14, y: CORNER.y - 0.14 };
    const dx = CORNER.x - b8.x, dy = CORNER.y - b8.y;
    const dl = Math.hypot(dx, dy);
    const cue = { x: b8.x - (dx / dl) * 0.55, y: b8.y - (dy / dl) * 0.55 };
    const st = Rules.createGame(explicitEight([b8], cue));
    st.breakDone = true; st.openTable = false;
    st.players[0].group = 'solid'; st.players[1].group = 'stripe';
    for (let n = 1; n <= 7; n++) st.balls.push({ id: 90 + n, n, x: 0, y: 0, potted: true });
    return st;
  }

  // 8 + scratch loss (follow spin carries the cue in behind the 8)
  s = onTheEight();
  let scratch8 = null;
  for (const p of [500, 700, 900, 1000]) {
    const rr = shoot(s, ghostAngle(s.balls[0], s.balls.find(b => b.n === 8), CORNER), p, 100);
    if (rr.state.terminal && rr.state.terminal.reason === Rules.TERMINAL.EIGHT_SCRATCH) { scratch8 = rr; break; }
  }
  ok(scratch8, '8+scratch loses');
  eq(scratch8 && scratch8.state.terminal.winner, 'p2', '8+scratch winner');

  // clean 8 win
  s = onTheEight();
  let cleanWin = null;
  for (const p of [200, 300, 400, 500, 650, 800]) {
    const rr = shoot(s, ghostAngle(s.balls[0], s.balls.find(b => b.n === 8), CORNER), p);
    if (rr.state.terminal && rr.state.terminal.reason === Rules.TERMINAL.EIGHT_DONE) { cleanWin = rr; break; }
  }
  ok(cleanWin, 'clean 8 wins');
  eq(cleanWin && cleanWin.state.terminal.winner, 'p1', 'clean 8 winner');
  ok(cleanWin && cleanWin.state.score.winBonus === 500, 'match win bonus');

  // resign
  s = Rules.createGame(explicitEight([{ n: 1, x: 0.3, y: 0.3 }], { x: -0.5, y: 0 }));
  r = Rules.applyCommand(s, { type: 'resign' });
  eq(r.state.terminal && r.state.terminal.reason, Rules.TERMINAL.RESIGN, 'resign terminal');
  eq(r.state.terminal.winner, 'p2', 'resign winner is the opponent');
});

// ------------------------------------------------------ serialization ------
section('rules: serialization', () => {
  const s = Rules.createGame(scatterCfg(77));
  const r = shoot(s, 1000, 500);
  const json = Rules.serialize(r.state);
  const back = Rules.deserialize(json);
  eq(Rules.hashState(back), Rules.hashState(r.state), 'serialize round-trip preserves hash');
  eq(JSON.stringify(back), JSON.stringify(r.state), 'round-trip deep equal');
  let threw = false;
  try { Rules.deserialize(JSON.stringify({ v: 999 })); } catch (e) { threw = true; }
  ok(threw, 'unsupported version rejected');
  eq(Rules.hashState(s), Rules.hashState(Rules.deserialize(Rules.serialize(s))), 'hash determinism');
});

// ------------------------------------------------------------- replay ------
section('rules: replay property (same seed+commands → same hashes)', () => {
  for (const seed of [11, 222, 3333]) {
    const chains = [];
    for (let run = 0; run < 2; run++) {
      let s = Rules.createGame({ seed, ruleset: 'eightball', layout: 'rack',
        players: [{ id: 'p1', name: 'A', ai: true, skill: 0.6 }, { id: 'p2', name: 'B', ai: true, skill: 0.6 }] });
      const hashes = [Rules.hashState(s)];
      for (let i = 0; i < 12 && !s.terminal; i++) {
        if (s.ballInHand) {
          const p = Rules.computeAIPlace(s);
          s = Rules.applyCommand(s, { type: 'place', x: p.x, y: p.y }).state;
        }
        const shot = Rules.computeAIShot(s, 0.6);
        s = Rules.applyCommand(s, { type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 }).state;
        hashes.push(Rules.hashState(s));
      }
      chains.push(hashes.join(','));
    }
    eq(chains[0], chains[1], 'replay chain identical for seed ' + seed);
  }
});

// ---------------------------------------------------------- AI legality ----
section('rules: AI shots legal, terminate, no NaN (30 seeds)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const cfg = { seed, ruleset: 'clearance', layout: 'scatter',
      ballNumbers: [1, 2, 3, 4, 5, 6], shotLimit: 12 };
    const r = solver.driveAI(cfg, 40);
    ok(!r.error, 'AI clearance seed ' + seed + ' error: ' + r.error);
    ok(r.terminated, 'AI clearance seed ' + seed + ' terminates');
  }
  for (let seed = 1; seed <= 8; seed++) {
    const cfg = { seed, ruleset: 'eightball', layout: 'rack',
      players: [{ id: 'a', name: 'A', ai: true, skill: 0.7 }, { id: 'b', name: 'B', ai: true, skill: 0.7 }] };
    const r = solver.driveAI(cfg, 80);
    ok(!r.error, 'AI rack seed ' + seed + ' error: ' + r.error);
  }
});

// ------------------------------------------------------------- content -----
section('content: journey + challenges + lessons legal and solvable', () => {
  const items = [];
  for (const j of Content.JOURNEY) items.push(j);
  for (const c of Content.CHALLENGES) items.push(c);
  for (const l of Content.LESSONS) items.push({
    id: 'lesson-' + l.id, seed: l.seed, ruleset: l.ruleset, layout: l.layout,
    cueAt: l.cueAt, balls: l.balls, shotLimit: l.shotLimit, blackLast: !!l.blackLast,
    startInHand: !!l.startInHand
  });
  eq(Content.JOURNEY.length, 36, '36 journey stages');
  eq(Content.CHALLENGES.length, 5, '5 challenges');
  eq(Content.LESSONS.length, 6, '6 lessons');

  for (const cfg of items) {
    const s = Rules.createGame(cfg);
    for (const b of s.balls) {
      ok(b.x >= T.MIN_X - 0.001 && b.x <= T.MAX_X + 0.001 && b.y >= T.MIN_Y - 0.001 && b.y <= T.MAX_Y + 0.001,
        cfg.id + ' ball ' + b.n + ' in bounds');
    }
    for (let i = 0; i < s.balls.length; i++)
      for (let j = i + 1; j < s.balls.length; j++) {
        const dx = s.balls[i].x - s.balls[j].x, dy = s.balls[i].y - s.balls[j].y;
        ok(dx * dx + dy * dy >= (T.R * 1.9) ** 2, cfg.id + ' balls ' + s.balls[i].n + '/' + s.balls[j].n + ' overlap');
      }
    if (s.ruleset === 'clearance') {
      const r = solver.solveClearance(cfg);
      ok(!r.error, cfg.id + ' solver error: ' + r.error);
      ok(r.terminal && r.terminal.reason === Rules.TERMINAL.CLEAR, cfg.id + ' solvable to table-clear (got ' +
        (r.terminal && r.terminal.reason) + ')');
      ok(r.shots <= (cfg.shotLimit || 99), cfg.id + ' solved within shot limit (' + r.shots + '/' + cfg.shotLimit + ')');
    } else {
      const r = solver.driveAI(cfg, 80);
      ok(!r.error, cfg.id + ' match drive error: ' + r.error);
    }
  }
});

section('content: daily deterministic', () => {
  for (const d of ['2026-01-01', '2026-08-30', '2027-12-25']) {
    const a = Content.dailyConfig(d), b = Content.dailyConfig(d);
    eq(JSON.stringify(a), JSON.stringify(b), 'daily ' + d + ' deterministic');
    const s = Rules.createGame(a);
    ok(s.balls.length >= 6 && s.balls.length <= 8, 'daily ' + d + ' ball count sane');
    eq(s.mechanics.undo, false, 'daily ranked: no undo');
  }
  let threw = false;
  try { Content.dailyConfig('30-08-2026'); } catch (e) { threw = true; }
  ok(threw, 'bad daily date rejected');
});

section('content: achievements stable lowercase keys', () => {
  eq(Content.ACHIEVEMENTS.length, 6, '6 achievements');
  for (const a of Content.ACHIEVEMENTS) {
    ok(/^[a-z0-9_]+$/.test(a.key), 'key ' + a.key + ' lowercase-stable');
    ok(a.name && a.desc, 'key ' + a.key + ' has copy');
  }
});

// ------------------------------------------------------------- session ----
section('session: phases, undo, lessons, replay envelope', () => {
  const Session = require('../js/session.js');
  const cfg = { seed: 9, ruleset: 'clearance', layout: 'scatter', ballNumbers: [1, 2], shotLimit: 6, kind: 'practice' };
  const sess = Session.create(cfg, {});
  const seen = {};
  for (const ev of ['started', 'applied', 'invalid', 'results', 'undone', 'lesson', 'phase'])
    sess.on(ev, d => { (seen[ev] = seen[ev] || []).push(d); });

  const st0 = sess.start();
  eq(sess.getPhase(), 'active', 'phase active after start');
  const h0 = Rules.hashState(st0);

  // player shot → resolving → ackResolved → active
  const r1 = sess.command({ type: 'shoot', angle: 500, power: 400, spinTop: 0, spinSide: 0 }, 'a1');
  ok(r1.ok, 'first shot ok');
  eq(sess.getPhase(), 'resolving', 'shot locks input (resolving)');
  eq(sess.command({ type: 'shoot', angle: 0, power: 100 }, 'a2').invalid, 'resolving', 'double commit blocked');
  sess.ackResolved();
  eq(sess.getPhase(), 'active', 'resolves back to active');

  // undo restores the exact pre-shot state
  ok(sess.canUndo(), 'undo available');
  ok(sess.undo(), 'undo applies');
  eq(Rules.hashState(sess.getState()), h0, 'undo restores pre-shot hash');
  ok(!sess.canUndo(), 'undo stack empty after one undo');

  // invalid command surfaces a reason
  sess.command({ type: 'shoot', angle: 7000, power: 100 }, 'a3');
  eq(seen.invalid[0].invalid, Rules.INVALID.BAD_ANGLE, 'invalid announced');

  // lesson tracking: lesson 'aim' step 0 requires any shot
  const lesson = Content.lessonById('aim');
  const lcfg = { seed: lesson.seed, ruleset: 'clearance', layout: 'explicit', cueAt: lesson.cueAt,
    balls: lesson.balls, shotLimit: lesson.shotLimit, kind: 'learn' };
  const lsess = Session.create(lcfg, { lesson });
  lsess.on('lesson', d => { (seen.lesson = seen.lesson || []).push(d); });
  lsess.start();
  eq(seen.lesson.length, 1, 'lesson intro emitted');
  lsess.command({ type: 'shoot', angle: 0, power: 200, spinTop: 0, spinSide: 0 }, 'l1');
  ok(seen.lesson.some(d => d.step === 1), 'lesson advances on required shot');
  lsess.ackResolved();

  // resign → results with breakdown + replay envelope
  sess.resign();
  eq(sess.getPhase(), 'results', 'resign reaches results');
  const res = sess.getResult();
  ok(res && res.score && typeof res.score.total === 'number', 'result has score breakdown');
  ok(res.replay && res.replay.terminal && res.replay.terminal.finalHash === Rules.hashState(sess.getState()),
    'replay envelope final hash matches');
  eq(res.replay.schemaVersion, Session.REPLAY_SCHEMA, 'replay schema version');

  // ranked sessions cannot undo
  const daily = Session.create(Content.dailyConfig('2026-08-30'), { ranked: true });
  daily.start();
  daily.command({ type: 'shoot', angle: 100, power: 300 }, 'd1');
  daily.ackResolved();
  ok(!daily.canUndo(), 'daily/ranked: undo disabled');
});

// ------------------------------------------------------------- summary -----
console.log('');
console.log(`passed: ${passed}, failed: ${failed}`);
if (failed) {
  console.log('failures:');
  for (const f of failures.slice(0, 40)) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL TESTS PASS');
