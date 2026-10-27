// Plans a keyboard playthrough of one table for the play scripts, with the
// rules engine the game ships (js/rules.js, js/session.js): each player shot
// is the Hint's aim (H) nudged by whole aim steps (←/→, 8 mrad) and the
// power stepped from the last (↑/↓, 2.5 %), the first nudge nearest the
// hint whose simulated shot pots a legal ball without a foul (else the best
// scoring one); ball in hand takes the Hint's spot (H, then Enter). The
// house's turns are the session's own AI, run here with the same pacing in
// fixed steps (750 ms = 45 steps a placement or shot) and the replay's
// length (one trace frame a step), so the waits between the player's keys
// are known; generous margins keep the script drift-tolerant.
//   import { planTable } from './plan.mjs';  planTable(cfg, { lesson, spin, quietFirst }) → { lines, result }
// (quietFirst: the first shot pots nothing, for a lesson whose first step is any shot).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Rules = require('../js/rules.js');
const Session = require('../js/session.js');

const AIM_STEP = 8, POWER_STEP = 25, STEP_HZ = 60;
const steps60 = (ms) => Math.max(1, Math.round((ms * STEP_HZ) / 1000));

function score(res, me) {
  if (!res.ok) return -1e9;
  let sc = 0;
  for (const e of res.events) {
    if (e.type === 'pot') sc += 100;
    else if (e.type === 'foul') sc -= 300;
    else if (e.type === 'terminal') sc += res.state.terminal.winner === me || e.reason === Rules.TERMINAL.CLEAR ? 100000 : -100000;
  }
  if (res.state.ruleset === 'eightball' && res.state.current === res.state.players.findIndex((p) => p.id === me)) sc += 50;
  return sc;
}

/** The best nudge of the hint: { dk (aim steps, + = left), power }. */
function chooseShot(state, hintAngle, power, spinTop, spinSide, quiet = false) {
  const me = state.players[state.current].id;
  let best = null;
  if (quiet) {
    // a legal shot that pots nothing (a lesson's first step): the softest clean one near the hint
    for (let r = 0; r <= 30; r++) {
      for (const dk of r === 0 ? [0] : [r, -r]) {
        for (let dp = -8; dp <= 16; dp++) {
          const p = power - dp * POWER_STEP;
          if (p < 50 || p > 1000) continue;
          const angle = (((hintAngle + dk * AIM_STEP) % 6284) + 6284) % 6284;
          const res = Rules.applyCommand(state, { type: 'shoot', angle, power: p, spinTop, spinSide });
          if (res.ok && !res.events.some((e) => e.type === 'pot' || e.type === 'foul' || e.type === 'terminal')) return { dk, power: p, sc: 0, cost: r + Math.abs(dp) };
        }
      }
    }
  }
  for (let r = 0; r <= 14 && !(best && best.sc >= 100 && r > 0 && best.cost < r); r++) {
    for (const dk of r === 0 ? [0] : [r, -r]) {
      for (let dp = -20; dp <= 22; dp++) {
        const p = power + dp * POWER_STEP;
        if (p < 0 || p > 1000) continue;
        const angle = (((hintAngle + dk * AIM_STEP) % 6284) + 6284) % 6284;
        const res = Rules.applyCommand(state, { type: 'shoot', angle, power: p, spinTop, spinSide });
        const sc = score(res, me);
        const cost = Math.abs(dk) + Math.abs(dp) * 0.25;
        if (!best || sc > best.sc || (sc === best.sc && cost < best.cost)) best = { dk, power: p, sc, cost };
      }
    }
  }
  return best;
}

/**
 * Plays `cfg` to its end (at most `maxShots` player shots) the way the play
 * script will: returns the script lines after the table is on screen and the
 * session's result.
 */
export function planTable(cfg, { lesson = null, maxShots = 40, spin = null, quietFirst = false } = {}) {
  let now = 0;
  const timers = [];
  const sess = Session.create(cfg, { lesson, ranked: cfg.kind === 'daily', timers: {
    set: (fn, ms) => { const t = { at: now + steps60(ms), fn }; timers.push(t); return t; },
    clear: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  } });
  let playing = 0;      // steps of replay left
  let result = null;
  sess.on('applied', (d) => { if (d.trace) playing = d.trace.frames.length - 1; });
  sess.on('results', (r) => { result = r; });
  sess.start();
  /** Runs fixed steps until the player can act (or the game ended); how many. */
  const settle = () => {
    let n = 0;
    for (let guard = 0; guard < 20000; guard++) {
      if (playing > 0) { playing--; now++; n++; if (playing === 0) sess.ackResolved(); continue; }
      if (result) return n;
      if (!sess.isAITurn() && sess.getPhase() === 'active') return n;
      now++; n++;
      for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    }
    throw new Error('the house never finished its turn');
  };
  const lines = [];
  let power = 450, spinTop = 0, spinSide = 0, shots = 0;
  const wait = (n) => { if (n > 0) lines.push(`frames ${n}`); };
  const key = (code) => { lines.push(`key ${code} 1`, 'frames 2'); };
  wait(settle() + 30);
  while (!result && shots < maxShots) {
    const st = sess.getState();
    if (st.ballInHand) {
      const h = Rules.hint(st);
      key('KeyH');
      const res = sess.command({ type: 'place', x: h.place.x, y: h.place.y }, 'p' + shots);
      if (!res.ok) throw new Error('placement refused: ' + res.invalid);
      key('Enter');
      wait(20);
      continue;
    }
    if (spin && shots === 0) {
      // the spin pad: focused by a click on it, reset (0), then its arrows (±10 a press), focus back to the table
      lines.push('click =Spin', 'frames 5');
      key('Digit0'); // the click set spin where it landed: back to none
      for (let i = 0; i < Math.abs(spin.top || 0) / 10; i++) key(spin.top > 0 ? 'ArrowUp' : 'ArrowDown');
      for (let i = 0; i < Math.abs(spin.side || 0) / 10; i++) key(spin.side > 0 ? 'ArrowRight' : 'ArrowLeft');
      spinTop = spin.top || 0; spinSide = spin.side || 0;
      lines.push('click Pool table', 'frames 5');
    }
    const hint = Rules.hint(st).shot;
    key('KeyH');
    const c = chooseShot(st, hint.angle, power, spinTop, spinSide, quietFirst && shots === 0);
    for (let i = 0; i < Math.abs(c.dk); i++) key(c.dk > 0 ? 'ArrowLeft' : 'ArrowRight');
    for (let p = power; p !== c.power; p += c.power > p ? POWER_STEP : -POWER_STEP) key(c.power > p ? 'ArrowUp' : 'ArrowDown');
    power = c.power;
    const angle = (((hint.angle + c.dk * AIM_STEP) % 6284) + 6284) % 6284;
    const res = sess.command({ type: 'shoot', angle, power, spinTop, spinSide }, 's' + shots);
    if (!res.ok) throw new Error('shot refused: ' + res.invalid);
    shots++;
    lines.push('key Enter 1');
    wait(settle() + 40);
    if (!result) lines.push(`expect Score ${sess.getState().score.total} ·`);
  }
  if (!result) throw new Error(`no result within ${maxShots} shots`);
  return { lines, result, state: sess.getState() };
}
