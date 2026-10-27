// The progression save the engine client keeps (js/progress.js) and the
// session's injectable timers: the browser build's checksummed document
// round-trips, a corrupt or old one is refused, two devices' saves merge
// (the browser build's old cloud slot included), finished games record
// stars, lessons, dailies and achievements once, the old account settings
// map onto the game's options, and AI pacing runs on the timers it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../js/progress.js');
const Content = require('../js/content.js');
const Session = require('../js/session.js');

function result(over) {
  return Object.assign({ cfgId: 'j01', kind: 'journey', ruleset: 'clearance', youWon: true, stars: 2, pots: 3,
    score: { pots: 300, winBonus: 500, shotBonus: 50, foulPenalty: 0, total: 850 }, terminal: { reason: 'table-clear' } }, over);
}

test('a sealed save round-trips; tampering, garbage and other versions are refused', () => {
  const s = P.seal(Object.assign(P.blankSave(), { careerPots: 7 }));
  assert.deepEqual(P.parseSave(JSON.stringify(s)), s);
  assert.deepEqual(P.parseSave(s), s);
  assert.equal(P.parseSave(Object.assign({}, s, { careerPots: 8 })), null);
  assert.equal(P.parseSave('{nope'), null);
  assert.equal(P.parseSave(null), null);
  assert.equal(P.parseSave(P.seal(Object.assign(P.blankSave(), { version: 2 }))), null);
});

test("the browser build's cloud save.json (the same document) parses and merges", () => {
  // what the JS SDK wrote: JSON.stringify(save) with the browser build's checksum
  const old = P.seal({ version: 1, journeyStars: { j01: 3, 'ch:sprint-six': 1 }, lessonsDone: { aim: true }, achievements: { first_clear: true },
    careerPots: 40, dailyDays: ['2026-10-01'], lastSnapshot: { cfgId: 'j01', total: 900, stars: 3, at: '2026-10-01T10:00:00.000Z' }, checksum: '' });
  const text = JSON.stringify(old);
  const local = P.seal(Object.assign(P.blankSave(), { journeyStars: { j01: 1, j02: 2 }, careerPots: 12, dailyDays: ['2026-10-02'],
    lastSnapshot: { cfgId: 'j02', total: 700, stars: 2, at: '2026-10-05T10:00:00.000Z' } }));
  const m = P.merge(P.parseSave(JSON.parse(text)), local);
  assert.ok(P.parseSave(m), 'the merge is sealed');
  assert.deepEqual(m.journeyStars, { j01: 3, 'ch:sprint-six': 1, j02: 2 });
  assert.equal(m.careerPots, 40);
  assert.deepEqual(m.dailyDays, ['2026-10-01', '2026-10-02']);
  assert.equal(m.lastSnapshot.cfgId, 'j02');
  assert.ok(m.lessonsDone.aim && m.achievements.first_clear);
  assert.ok(P.same(P.merge(m, m), m), 'merging again changes nothing');
  assert.ok(!P.same(m, local));
});

test('recording a game: stars kept at their best, lessons, dailies and achievements once', () => {
  const s = P.blankSave();
  assert.deepEqual(P.record(s, result(), null, 'x'), ['first_clear']);
  assert.equal(s.journeyStars.j01, 2);
  assert.deepEqual(P.record(s, result({ stars: 1 }), null, 'y'), []);
  assert.equal(s.journeyStars.j01, 2, 'a worse run keeps the best stars');
  assert.equal(s.careerPots, 6);
  P.record(s, result({ cfgId: 'sprint-six', kind: 'challenge', stars: 3 }), null, 'z');
  assert.equal(s.journeyStars['ch:sprint-six'], 3);
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-02', '2026-10-03']) P.record(s, result({ cfgId: 'daily-' + d, kind: 'daily' }), null, d);
  assert.deepEqual(s.dailyDays, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.ok(s.achievements.daily_streak_3);
  for (const l of Content.LESSONS) P.record(s, result({ cfgId: 'lesson-' + l.id, kind: 'learn', pots: 0 }), l.id, 'l');
  assert.ok(s.achievements.spin_graduate);
  assert.equal(P.record(s, result({ ruleset: 'eightball', kind: 'practice', pots: 100 }), null, 'w').sort().join(), 'century,first_match');
  assert.equal(s.lastSnapshot.at, 'w');
});

test('journey unlocks, the Play stage and the home summary', () => {
  const s = P.blankSave();
  assert.ok(P.journeyUnlocked(s, 0) && !P.journeyUnlocked(s, 1));
  assert.equal(P.playStageIndex(s), 0);
  s.journeyStars[Content.JOURNEY[0].id] = 3;
  s.journeyStars['ch:marathon'] = 2;
  assert.ok(P.journeyUnlocked(s, 1));
  assert.equal(P.playStageIndex(s), 1);
  assert.deepEqual(P.summary(s), { done: 1, stars: 3, pots: 0 });
  for (const j of Content.JOURNEY) s.journeyStars[j.id] = 1;
  assert.equal(P.playStageIndex(s), Content.JOURNEY.length - 1, 'all beaten: the last stage');
});

test('leaderboard posting: every mode but lessons and hotseat', () => {
  assert.ok(P.ranksOnBoard(Content.JOURNEY[0]));
  assert.ok(P.ranksOnBoard(Content.dailyConfig('2026-10-27')));
  assert.ok(P.ranksOnBoard(Content.practiceConfig('match-casual', 1)));
  assert.ok(!P.ranksOnBoard(Content.practiceConfig('match-hotseat', 1)));
  assert.ok(!P.ranksOnBoard({ kind: 'learn' }));
});

test("the browser build's account settings: theme and left-handed carry over, the rest is the runtime's", () => {
  assert.deepEqual(P.gameSettingsFrom({ theme: 'oxblood', leftHanded: true, quality: 'high', highContrast: true, audio: { music: 0.2 }, name: 'Zed' }),
    { theme: 'oxblood', leftHanded: true });
  assert.deepEqual(P.gameSettingsFrom({ theme: 'disco', leftHanded: 'yes' }), {});
  assert.equal(P.checkSetting('name', '  Ann  '), 'Ann');
  assert.equal(P.checkSetting('name', '   '), undefined);
  assert.ok(P.LEGACY_KEYS.includes('ui.language') && P.LEGACY_KEYS.includes('quality'));
});

test('the session paces the house on the timers it is given (fixed steps on the engine)', () => {
  const queue = [];
  const timers = { set: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; }, clear: (t) => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); } };
  const cfg = Object.assign({}, Content.practiceConfig('match-casual', 7));
  const s = Session.create(cfg, { timers });
  let aiShots = 0;
  s.on('applied', (d) => { if (d.ai) aiShots++; });
  s.start();
  // the player breaks; when the turn passes, the house's move waits on a 750 ms timer
  s.command({ type: 'shoot', angle: 0, power: 900, spinTop: 0, spinSide: 0 }, 'a');
  s.ackResolved();
  for (let i = 0; i < 6 && s.isAITurn(); i++) {
    assert.ok(queue.length >= 1 && queue[0].ms === 750, 'a paced AI timer');
    queue.shift().fn();
    s.ackResolved();
  }
  assert.ok(aiShots > 0 || !s.isAITurn());
  s.pause();
  assert.equal(queue.length, 0, 'pausing clears the timer');
});
