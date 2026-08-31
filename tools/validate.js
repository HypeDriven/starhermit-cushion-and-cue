/* Cushion & Cue — content validator (CLI). Run: node tools/validate.js
 * Prints per-item legality / reachability / bounded-duration results and
 * exits nonzero on any defect. Also verifies the starhermit.txt launch
 * file exists.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Rules = require('../js/rules.js');
const Content = require('../js/content.js');
const solver = require('../tests/solver.js');

const T = Rules.TABLE;
let defects = 0;

function report(id, ok, detail) {
  console.log(` ${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ' — ' + detail : ''}`);
  if (!ok) defects++;
}

function checkLayout(cfg) {
  const t0 = Date.now();
  let s;
  try { s = Rules.createGame(cfg); }
  catch (e) { return report(cfg.id, false, 'createGame threw: ' + e.message); }
  let legal = true, why = '';
  for (const b of s.balls) {
    if (b.x < T.MIN_X - 0.001 || b.x > T.MAX_X + 0.001 || b.y < T.MIN_Y - 0.001 || b.y > T.MAX_Y + 0.001) {
      legal = false; why = 'ball ' + b.n + ' out of bounds';
    }
  }
  for (let i = 0; i < s.balls.length && legal; i++)
    for (let j = i + 1; j < s.balls.length; j++) {
      const dx = s.balls[i].x - s.balls[j].x, dy = s.balls[i].y - s.balls[j].y;
      if (dx * dx + dy * dy < (T.R * 1.9) * (T.R * 1.9)) {
        legal = false; why = 'balls ' + s.balls[i].n + '/' + s.balls[j].n + ' overlap';
      }
    }
  if (!legal) return report(cfg.id, false, why);

  if (s.ruleset === 'clearance') {
    const r = solver.solveClearance(cfg);
    if (r.error) return report(cfg.id, false, 'solver error: ' + r.error);
    if (!r.terminal || r.terminal.reason !== Rules.TERMINAL.CLEAR)
      return report(cfg.id, false, 'not solvable to table-clear (got ' + (r.terminal && r.terminal.reason) + ')');
    if (r.shots > (cfg.shotLimit || 99))
      return report(cfg.id, false, `needs ${r.shots} shots > limit ${cfg.shotLimit}`);
    report(cfg.id, true, `solvable in ${r.shots}/${cfg.shotLimit} shots (${Date.now() - t0}ms)`);
  } else {
    const r = solver.driveAI(cfg, 80);
    if (r.error) return report(cfg.id, false, 'match drive error: ' + r.error);
    report(cfg.id, true, `match stable for ${r.steps} AI shots${r.terminated ? ' (finished: ' + r.state.terminal.reason + ')' : ''}`);
  }
}

console.log('== Cushion & Cue content validation ==');

// launch file contract
const root = path.join(__dirname, '..');
let star = {};
try {
  for (const line of fs.readFileSync(path.join(root, 'starhermit.txt'), 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) star[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
} catch (e) {
  report('starhermit.txt', false, 'unreadable: ' + e.message);
}
if (star.launch) {
  report('launch file', fs.existsSync(path.join(root, star.launch)), star.launch);
} else {
  report('starhermit.txt', false, 'missing launch= key');
}

console.log('\n-- journey (36) --');
for (const j of Content.JOURNEY) checkLayout(j);

console.log('\n-- challenges (5) --');
for (const c of Content.CHALLENGES) checkLayout(c);

console.log('\n-- lessons (6) --');
for (const l of Content.LESSONS) {
  checkLayout({
    id: 'lesson-' + l.id, seed: l.seed, ruleset: l.ruleset, layout: l.layout,
    cueAt: l.cueAt, balls: l.balls, shotLimit: l.shotLimit,
    blackLast: !!l.blackLast, startInHand: !!l.startInHand
  });
}

console.log('\n-- practice presets (7) --');
for (const p of Content.PRACTICE) {
  checkLayout(Content.practiceConfig(p.id, 12345));
}

console.log('\n-- daily (sample dates) --');
for (const d of ['2026-01-01', '2026-06-15', '2026-08-30', '2027-02-28']) {
  checkLayout(Content.dailyConfig(d));
}

console.log('');
if (defects) {
  console.log(`VALIDATION FAILED: ${defects} defect(s)`);
  process.exit(1);
}
console.log('VALIDATION PASSED');
