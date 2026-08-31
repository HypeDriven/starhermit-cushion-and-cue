/* Cushion & Cue — offline solver used by tests and tools/validate.js.
 * Proves reachability and bounded duration for clearance content: a
 * deterministic search over candidate placements and shots, simulating
 * each with the authoritative rules engine and keeping the best outcome.
 * Not the in-game AI — this is the content validator's "perfect player".
 */
'use strict';

const Rules = require('../js/rules.js');
const T = Rules.TABLE;

function milli(a) {
  return Math.round(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * 1000) % 6284;
}

function evalResult(res) {
  if (!res.ok) return -1e9;
  let sc = 0;
  for (const e of res.events) {
    if (e.type === 'pot') sc += 100;
    else if (e.type === 'foul') sc -= 120;
    else if (e.type === 'terminal') {
      sc += (e.reason === Rules.TERMINAL.CLEAR || e.reason === Rules.TERMINAL.EIGHT_DONE) ? 100000 : -100000;
    }
  }
  sc -= Rules.remainingTargets(res.state) * 2;
  return sc;
}

function candidateShots(state) {
  const cue = state.balls[0];
  const out = [];
  for (const tn of Rules.legalTargets(state)) {
    const b = state.balls.find(b => b.n === tn);
    if (!b || b.potted) continue;
    for (const pk of T.POCKETS) {
      const pdx = pk.x - b.x, pdy = pk.y - b.y;
      const pd = Math.hypot(pdx, pdy);
      if (pd < 0.01) continue;
      const gx = b.x - (pdx / pd) * T.R * 2, gy = b.y - (pdy / pd) * T.R * 2;
      const cd = Math.hypot(gx - cue.x, gy - cue.y);
      if (cd < 0.01) continue;
      const baseA = Math.atan2(gy - cue.y, gx - cue.x);
      const baseP = 280 + cd * 260 + pd * 300;
      for (const da of [0, -12, 12, -25, 25]) {
        for (const pf of [0.7, 1.0, 1.4, 1.9]) {
          out.push({
            angle: milli(baseA + da / 1000),
            power: Math.max(60, Math.min(1000, Math.round(baseP * pf))),
            spinTop: 0, spinSide: 0
          });
        }
      }
    }
  }
  out.push(Rules.computeAIShot(state, 1.0));
  return out;
}

function bestShot(state) {
  let best = null;
  for (const shot of candidateShots(state)) {
    const res = Rules.applyCommand(state, { type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 });
    const sc = evalResult(res);
    if (!best || sc > best.sc) best = { sc, shot };
  }
  return best ? best.shot : Rules.computeAIShot(state, 1.0);
}

function freeSpots(state) {
  const spots = [];
  for (let gx = T.MIN_X + 0.05; gx <= T.MAX_X - 0.05; gx += 0.14) {
    for (let gy = T.MIN_Y + 0.05; gy <= T.MAX_Y - 0.05; gy += 0.14) {
      let ok = true;
      for (const b of state.balls) {
        if (b.potted || b.n === 0) continue;
        const dx = gx - b.x, dy = gy - b.y;
        if (dx * dx + dy * dy < (T.R * 2.1) * (T.R * 2.1)) { ok = false; break; }
      }
      if (ok) spots.push([gx, gy]);
    }
  }
  return spots;
}

// Solve a clearance game. Returns {state, terminal, shots, error}.
function solveClearance(cfg) {
  let state = Rules.createGame(cfg);
  if (cfg.startInHand) state.ballInHand = true;
  const cap = (cfg.shotLimit || 40) + 60;
  while (!state.terminal && state.shotCount < cap) {
    if (state.ballInHand) {
      let best = null;
      for (const [x, y] of freeSpots(state)) {
        const placed = Rules.applyCommand(state, { type: 'place', x: Math.round(x * 1000), y: Math.round(y * 1000) });
        if (!placed.ok) continue;
        const shot = bestShot(placed.state);
        const res = Rules.applyCommand(placed.state, { type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 });
        const sc = evalResult(res);
        if (!best || sc > best.sc) {
          best = { sc, cmds: [{ type: 'place', x: Math.round(x * 1000), y: Math.round(y * 1000) },
                              { type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 }] };
        }
      }
      const cmds = best ? best.cmds : [{ type: 'place', x: Rules.computeAIPlace(state).x, y: Rules.computeAIPlace(state).y }];
      for (const c of cmds) {
        const r = Rules.applyCommand(state, c);
        if (!r.ok) return { state, terminal: null, shots: state.shotCount, error: r.invalid };
        state = r.state;
      }
    } else {
      const shot = bestShot(state);
      const r = Rules.applyCommand(state, { type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 });
      if (!r.ok) return { state, terminal: null, shots: state.shotCount, error: r.invalid };
      state = r.state;
    }
  }
  return { state, terminal: state.terminal, shots: state.shotCount };
}

// AI-vs-AI (or AI solo) driver for match stages / fuzzing: uses the shipped
// computeAIShot/computeAIPlace. Must always terminate with sane numbers.
function driveAI(cfg, maxShots) {
  let state = Rules.createGame(cfg);
  let steps = 0;
  while (!state.terminal && steps < maxShots) {
    const cur = state.players[state.current];
    const skill = cur.skill != null ? cur.skill : 0.5;
    if (state.ballInHand) {
      const p = Rules.computeAIPlace(state);
      const r = Rules.applyCommand(state, { type: 'place', x: p.x, y: p.y });
      if (!r.ok) return { state, steps, error: 'place: ' + r.invalid };
      state = r.state;
      continue;
    }
    const shot = Rules.computeAIShot(state, skill);
    for (const v of [shot.angle, shot.power]) {
      if (!Number.isFinite(v)) return { state, steps, error: 'NaN shot' };
    }
    const r = Rules.applyCommand(state, { type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 });
    if (!r.ok) return { state, steps, error: 'shoot: ' + r.invalid };
    for (const b of r.state.balls) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return { state, steps, error: 'NaN position' };
    }
    state = r.state;
    steps++;
  }
  return { state, steps, terminated: !!state.terminal };
}

module.exports = { solveClearance, driveAI, bestShot, evalResult };
