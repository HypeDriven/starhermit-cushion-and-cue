/* Cushion & Cue — versioned content: ball defs, themes, journey stages,
 * challenges, tutorial lessons, practice presets, daily ruleset generator.
 * Shared browser (window.CCContent) / Node. Content is data-only; all
 * randomness enters through the config seed.
 */
(function (root, factory) {
  var RNG = (typeof module === 'object' && module.exports) ? require('./rng.js') : root.CCRNG;
  var api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCContent = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  var CONTENT_VERSION = 1;

  // ---------- balls ----------
  // Color is always reinforced by the printed number and solid/stripe band.
  var BALLS = {
    0:  { label: 'Cue',    color: 0xf4efe4, colorHC: 0xffffff },
    1:  { label: '1',      color: 0xe8b93c, colorHC: 0xf5d90a },
    2:  { label: '2',      color: 0x2e5fb8, colorHC: 0x2e6fe4 },
    3:  { label: '3',      color: 0xd43b2e, colorHC: 0xe03424 },
    4:  { label: '4',      color: 0x6a3d9a, colorHC: 0x8e24aa },
    5:  { label: '5',      color: 0xe07b28, colorHC: 0xef6c00 },
    6:  { label: '6',      color: 0x2e7d46, colorHC: 0x17a398 },
    7:  { label: '7',      color: 0x8a3b2a, colorHC: 0x9a3b26 },
    8:  { label: '8',      color: 0x1c1c20, colorHC: 0x000000 },
    9:  { label: '9',      color: 0xe8b93c, colorHC: 0xf5d90a },
    10: { label: '10',     color: 0x2e5fb8, colorHC: 0x2e6fe4 },
    11: { label: '11',     color: 0xd43b2e, colorHC: 0xe03424 },
    12: { label: '12',     color: 0x6a3d9a, colorHC: 0x8e24aa },
    13: { label: '13',     color: 0xe07b28, colorHC: 0xef6c00 },
    14: { label: '14',     color: 0x2e7d46, colorHC: 0x17a398 },
    15: { label: '15',     color: 0x8a3b2a, colorHC: 0x9a3b26 }
  };

  // ---------- themes (cosmetic only: cloth, wood, room, light) ----------
  var THEMES = [
    { id: 'tournament', name: 'Tournament Green', unlockStars: 0,
      palette: { cloth: 0x1e6a44, clothDark: 0x175737, cushion: 0x1a5c3b, wood: 0x6e4526, woodDark: 0x4a2d18,
                 wall: 0x2c2620, floor: 0x3d332a, light: 0xffe2b0, accent: 0xe8c46a, metal: 0xb08d57, fog: 0x211c16 } },
    { id: 'midnight', name: 'Midnight Blue', unlockStars: 10,
      palette: { cloth: 0x274b7a, clothDark: 0x1e3c63, cushion: 0x22436e, wood: 0x4a3a2e, woodDark: 0x32261d,
                 wall: 0x1d2230, floor: 0x272c3d, light: 0xcfe0ff, accent: 0x7fb0ff, metal: 0x8090b0, fog: 0x161a26 } },
    { id: 'oxblood', name: 'Oxblood Lounge', unlockStars: 25,
      palette: { cloth: 0x7a2e2e, clothDark: 0x632424, cushion: 0x6e2828, wood: 0x54341f, woodDark: 0x3a2213,
                 wall: 0x2b1f1e, floor: 0x3d2a26, light: 0xffd0b0, accent: 0xff9a6a, metal: 0xa87a50, fog: 0x201715 } },
    { id: 'slate', name: 'Slate Club', unlockStars: 45,
      palette: { cloth: 0x4c5a5e, clothDark: 0x3e4a4d, cushion: 0x445156, wood: 0x5d4a38, woodDark: 0x403023,
                 wall: 0x23282b, floor: 0x2f363a, light: 0xe8f4ff, accent: 0x9fd8e0, metal: 0x90a0a8, fog: 0x1b1f22 } },
    { id: 'ivory', name: 'Ivory Hall', unlockStars: 70,
      palette: { cloth: 0x8a7f68, clothDark: 0x746a56, cushion: 0x7e7460, wood: 0x8a6a4a, woodDark: 0x5f4630,
                 wall: 0x6a6055, floor: 0x7d7266, light: 0xfff4e0, accent: 0xffd9a0, metal: 0xb0a080, fog: 0x554c42 } }
  ];

  // ---------- journey ----------
  // Compact authored rows:
  // [id, name, seed, kind('clear'|'match'), nBalls, shotLimit, blackLast,
  //  parShots, aiSkill(0-100), mastery, themeIdx, intro]
  // Clearance: pot every ball inside the shot limit (black last when flagged).
  // Match: full 8-ball rack against the house player.
  var J = [
    ['j01','First Stroke',      201,'clear',3, 5,0, 3,  0,0,0,'Pot every ball before you run out of shots. Aim with a drag, set power, and strike.'],
    ['j02','Open Table',        202,'clear',3, 5,0, 3,  0,0,0,''],
    ['j03','Corners First',     203,'clear',4, 6,0, 4,  0,0,0,'Corner pockets are a little wider than the side pockets.'],
    ['j04,'.replace(',',''),'Side Pocket Study',204,'clear',4, 6,0, 4,  0,0,0,'Side pockets demand accuracy — aim for the center of the mouth.'],
    ['j05','Follow Through',    205,'clear',4, 6,0, 4,  0,0,0,'Top spin makes the cue ball follow its target. Useful for position.'],
    ['j06','House Warm-up',     206,'match',0, 0,0, 0, 25,0,0,'MATCH: first to legally pocket the 8 wins. Your group is decided by the first ball you pot.'],
    ['j07,'.replace(',',''),'Draw Shot',207,'clear',5, 7,0, 5,  0,0,0,'Back spin pulls the cue ball back after contact — avoid scratching behind a pot.'],
    ['j08','Black Goes Last',   208,'clear',5, 8,1, 6,  0,0,0,'New: the black must be the final ball. Pot it early and the round is lost.'],
    ['j09','Cushion Escape',    209,'clear',5, 7,0, 5,  0,0,0,''],
    ['j10','First Mastery',     210,'clear',6, 7,1, 6,  0,1,0,'MASTERY: everything so far — a tight shot limit and the black last.'],
    ['j11','Long Rails',        211,'clear',6, 8,0, 6,  0,0,1,''],
    ['j12','Split Decisions',   212,'clear',6, 8,0, 6,  0,0,1,''],
    ['j13','Club Night',        213,'match',0, 0,0, 0, 40,0,1,'MATCH: the house player has practiced. Expect longer runs.'],
    ['j14','Side Spin Serve',   214,'clear',6, 8,1, 6,  0,0,1,'Side spin changes the rebound off cushions. Use it to open angles.'],
    ['j15,'.replace(',',''),'Nine Lives',215,'clear',7, 9,0, 7,  0,0,1,''],
    ['j16,'.replace(',',''),'Quiet Table',216,'clear',7, 9,1, 7,  0,0,1,''],
    ['j17','Pressure Shots',    217,'clear',7, 8,0, 7,  0,0,1,''],
    ['j18,'.replace(',',''),'Second Mastery',218,'clear',8, 9,1, 8,  0,1,1,'MASTERY: eight balls, black last, no room for wasted shots.'],
    ['j19','Crowded Cloth',     219,'clear',8,10,0, 8,  0,0,2,''],
    ['j20,'.replace(',',''),'League Night',220,'match',0, 0,0, 0, 55,0,2,'MATCH: league level. Punish every mistake.'],
    ['j21,'.replace(',',''),'Angles and Edges',221,'clear',8,10,1, 8,  0,0,2,''],
    ['j22','Thin Cuts',         222,'clear',8,10,0, 8,  0,0,2,''],
    ['j23','No Margin',         223,'clear',8, 9,1, 8,  0,0,2,''],
    ['j24','Position Play',     224,'clear',9,11,0, 9,  0,0,2,'Plan two shots ahead — leave the cue ball with an angle.'],
    ['j25,'.replace(',',''),'Third Mastery',225,'clear',9,10,1, 9,  0,1,2,'MASTERY: nine balls and the black, ten shots.'],
    ['j26','Full Spread',       226,'clear',9,11,0, 9,  0,0,3,''],
    ['j27','Veteran Table',     227,'match',0, 0,0, 0, 68,0,3,'MATCH: the veteran rarely misses twice.'],
    ['j28','Rail Birds',        228,'clear',9,11,1, 9,  0,0,3,''],
    ['j29','Tight Pockets',     229,'clear',10,12,0,10,  0,0,3,''],
    ['j30','Half Century',      230,'clear',10,11,1,10,  0,0,3,''],
    ['j31,'.replace(',',''),'Fourth Mastery',231,'clear',10,11,1, 9,  0,1,3,'MASTERY: ten balls, black last, one shot of slack.'],
    ['j32','Closing Time',      232,'clear',10,12,0,10,  0,0,4,''],
    ['j33','Last Orders',       233,'clear',10,12,1,10,  0,0,4,''],
    ['j34','Champion Night',    234,'match',0, 0,0, 0, 80,0,4,'MATCH: the house champion. Hold your nerve.'],
    ['j35','Grand Spread',      235,'clear',10,11,1, 9,  0,0,4,''],
    ['j36','Final Mastery',     236,'clear',10,10,1, 9,  0,1,4,'MASTERY: the full table, black last, zero slack. Clear it like a champion.']
  ];

  function ballNumbers(n, blackLast) {
    // spread of solids/stripes; black (8) only when blackLast
    var pool = [1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
    var nums = pool.slice(0, n);
    if (blackLast) nums[nums.length - 1] = 8;
    return nums;
  }

  var JOURNEY = J.map(function (r) {
    var cfg = {
      id: r[0], name: r[1], version: CONTENT_VERSION, kind: 'journey',
      seed: r[2], matchKind: r[3], theme: THEMES[r[10]].id, intro: r[11],
      mastery: !!r[9]
    };
    if (r[3] === 'match') {
      cfg.ruleset = 'eightball'; cfg.layout = 'rack';
      cfg.players = [{ id: 'p1', name: 'You' }, { id: 'ai', name: 'House', ai: true, skill: r[8] / 100 }];
      cfg.par = { shots: 30 };
    } else {
      cfg.ruleset = 'clearance'; cfg.layout = 'scatter';
      cfg.ballNumbers = ballNumbers(r[4], !!r[6]);
      cfg.blackLast = !!r[6];
      cfg.shotLimit = r[5];
      cfg.par = { shots: r[7] };
      cfg.mechanics = { undo: true, hint: true };
    }
    return cfg;
  });

  // ---------- challenges (fixed seeds; constrained goals) ----------
  var CHALLENGES = [
    { id: 'sprint-six', name: 'Sprint Six', version: CONTENT_VERSION, kind: 'challenge',
      seed: 6101, ruleset: 'clearance', layout: 'scatter', ballNumbers: ballNumbers(6, false),
      shotLimit: 6, par: { shots: 6 }, theme: 'tournament',
      blurb: 'Six balls, six shots. Every single one must score.' },
    { id: 'black-watch', name: 'Black Watch', version: CONTENT_VERSION, kind: 'challenge',
      seed: 6202, ruleset: 'clearance', layout: 'scatter', ballNumbers: ballNumbers(6, true),
      blackLast: true, shotLimit: 8, par: { shots: 7 }, theme: 'oxblood',
      blurb: 'The black is guarded until last. One careless kiss ends it.' },
    { id: 'sharpshooter', name: 'Sharpshooter', version: CONTENT_VERSION, kind: 'challenge',
      seed: 6303, ruleset: 'clearance', layout: 'scatter', ballNumbers: ballNumbers(9, false),
      shotLimit: 8, par: { shots: 8 }, theme: 'midnight',
      blurb: 'Nine balls, eight shots — you must pot twice on one shot.' },
    { id: 'marathon', name: 'Marathon', version: CONTENT_VERSION, kind: 'challenge',
      seed: 6404, ruleset: 'clearance', layout: 'scatter', ballNumbers: ballNumbers(10, true),
      blackLast: true, shotLimit: 13, par: { shots: 12 }, theme: 'slate',
      blurb: 'The full spread plus the black. Settle in.' },
    { id: 'house-final', name: 'House Final', version: CONTENT_VERSION, kind: 'challenge',
      seed: 6505, ruleset: 'eightball', layout: 'rack',
      players: [{ id: 'p1', name: 'You' }, { id: 'ai', name: 'Champion', ai: true, skill: 0.85 }],
      par: { shots: 24 }, theme: 'ivory',
      blurb: 'One rack against the house champion, at full strength.' }
  ];

  // ---------- learn (interactive lessons; one rule at a time) ----------
  // require: event the player must produce — 'shot', 'pot', 'place',
  // 'spin-top', 'spin-side', 'clear'.
  var LESSONS = [
    { id: 'aim', title: 'Aim and strike', version: CONTENT_VERSION,
      ruleset: 'clearance', layout: 'explicit', seed: 11,
      cueAt: { x: -0.56, y: -0.25 }, balls: [{ n: 1, x: -0.1, y: -0.06 }],
      shotLimit: 6,
      steps: [
        { text: 'Drag from the cue ball toward the 1-ball to aim. A guide line shows where the cue ball will go.', require: 'shot' },
        { text: 'Now pot the 1-ball: line it up with the corner pocket and strike cleanly.', require: 'pot' }
      ],
      outro: 'Aiming learned. Power comes next.' },
    { id: 'power', title: 'Power control', version: CONTENT_VERSION,
      ruleset: 'clearance', layout: 'explicit', seed: 12,
      cueAt: { x: -0.8, y: 0.3 }, balls: [{ n: 3, x: 0.55, y: -0.2 }],
      shotLimit: 6,
      steps: [
        { text: 'The farther you pull back (or the higher the power slider), the harder the strike. Too soft and the ball dies short.', require: 'shot' },
        { text: 'Pot the 3-ball across the table. Judge the power so the cue ball does not follow it into the pocket.', require: 'pot' }
      ],
      outro: 'You can reach any ball now.' },
    { id: 'follow-draw', title: 'Follow and draw', version: CONTENT_VERSION,
      ruleset: 'clearance', layout: 'explicit', seed: 13,
      cueAt: { x: -0.3, y: 0 }, balls: [{ n: 5, x: 0.25, y: 0.05 }],
      shotLimit: 8,
      steps: [
        { text: 'Set follow (top spin, positive) or draw (back spin, negative) with the spin control, then strike. Watch how the cue ball reacts after contact.', require: 'spin-top' },
        { text: 'Pot the 5-ball.', require: 'pot' }
      ],
      outro: 'Spin moves the cue ball where you need it.' },
    { id: 'side-spin', title: 'Side spin', version: CONTENT_VERSION,
      ruleset: 'clearance', layout: 'explicit', seed: 14,
      cueAt: { x: -0.5, y: -0.3 }, balls: [{ n: 6, x: 0.4, y: 0.3 }],
      shotLimit: 8,
      steps: [
        { text: 'Side spin kicks the cue ball sideways off cushions. Take any shot with side spin and watch the rebound.', require: 'spin-side' },
        { text: 'Pot the 6-ball.', require: 'pot' }
      ],
      outro: 'Cushions are now a tool, not a wall.' },
    { id: 'fouls', title: 'Fouls and ball in hand', version: CONTENT_VERSION,
      ruleset: 'clearance', layout: 'explicit', seed: 15, startInHand: true,
      cueAt: { x: -0.56, y: 0 }, balls: [{ n: 2, x: 0.2, y: 0.2 }, { n: 4, x: 0.6, y: -0.25 }],
      shotLimit: 8,
      steps: [
        { text: 'After a foul (like pocketing the cue ball) you get ball in hand: place the cue ball anywhere. Tap a free spot, or use Place here.', require: 'place' },
        { text: 'Hitting nothing, hitting the wrong ball first, or failing to reach a cushion after contact are all fouls. Now pot both balls.', require: 'clear' }
      ],
      outro: 'You know every way a shot can go wrong — and how to recover.' },
    { id: 'eight-ball', title: 'The 8 goes last', version: CONTENT_VERSION,
      ruleset: 'clearance', layout: 'explicit', seed: 16, blackLast: true,
      cueAt: { x: -0.6, y: 0.1 }, balls: [{ n: 7, x: 0.1, y: -0.15 }, { n: 8, x: 0.5, y: 0.2 }],
      shotLimit: 6,
      steps: [
        { text: 'The black 8 must be the final ball. Pot the 7 first — touching the 8 first is a foul, potting it early loses the round.', require: 'clear' }
      ],
      outro: 'You are ready for a full table.' }
  ];

  // ---------- practice presets ----------
  var PRACTICE = [
    { id: 'solo-easy', name: 'Solo — Warm-up', ruleset: 'clearance', nBalls: 4, shotLimit: 8, blackLast: false },
    { id: 'solo-club', name: 'Solo — Club level', ruleset: 'clearance', nBalls: 7, shotLimit: 10, blackLast: true },
    { id: 'solo-pro', name: 'Solo — Pro spread', ruleset: 'clearance', nBalls: 10, shotLimit: 12, blackLast: true },
    { id: 'match-casual', name: 'Match — Casual AI', ruleset: 'eightball', aiSkill: 0.3 },
    { id: 'match-league', name: 'Match — League AI', ruleset: 'eightball', aiSkill: 0.6 },
    { id: 'match-shark', name: 'Match — Shark AI', ruleset: 'eightball', aiSkill: 0.85 },
    { id: 'match-hotseat', name: 'Match — Two players (hotseat)', ruleset: 'eightball', hotseat: true }
  ];

  function practiceConfig(presetId, seed) {
    var p = null;
    for (var i = 0; i < PRACTICE.length; i++) if (PRACTICE[i].id === presetId) p = PRACTICE[i];
    if (!p) throw new Error('unknown practice preset ' + presetId);
    var cfg = {
      id: p.id, name: p.name, version: CONTENT_VERSION, kind: 'practice',
      seed: seed >>> 0, ruleset: p.ruleset, theme: null,
      mechanics: { undo: true, hint: true }
    };
    if (p.ruleset === 'eightball') {
      cfg.layout = 'rack';
      cfg.players = p.hotseat
        ? [{ id: 'p1', name: 'Player 1' }, { id: 'p2', name: 'Player 2' }]
        : [{ id: 'p1', name: 'You' }, { id: 'ai', name: 'House', ai: true, skill: p.aiSkill }];
      cfg.par = { shots: 30 };
    } else {
      cfg.layout = 'scatter';
      cfg.ballNumbers = ballNumbers(p.nBalls, p.blackLast);
      cfg.blackLast = p.blackLast;
      cfg.shotLimit = p.shotLimit;
      cfg.par = { shots: p.nBalls };
    }
    return cfg;
  }

  // ---------- daily (one shared seed per UTC day; immutable after publication) ----------
  function dailyConfig(dateStr) { // 'YYYY-MM-DD' (UTC)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('bad daily date ' + dateStr);
    var h = RNG.hashString('cushion-and-cue-daily-v1-' + dateStr);
    var rng = RNG.create(h);
    var n = 5 + rng.int(3);          // 5..7 balls
    var black = rng.next() < 0.5;
    return {
      id: 'daily-' + dateStr, name: 'Daily — ' + dateStr, version: CONTENT_VERSION,
      kind: 'daily', seed: h, ruleset: 'clearance', layout: 'scatter',
      ballNumbers: ballNumbers(n, black), blackLast: black,
      shotLimit: n + 2, par: { shots: n + 1 },
      theme: THEMES[rng.int(THEMES.length)].id,
      mechanics: { undo: false, hint: true }, // ranked: no undo
      date: dateStr
    };
  }

  // ---------- achievements (stable lowercase keys; idempotent unlocks) ----------
  var ACHIEVEMENTS = [
    { key: 'first_clear',    name: 'First Clear',     desc: 'Clear a full table in any mode.' },
    { key: 'first_match',    name: 'Match Winner',    desc: 'Win an 8-ball match.' },
    { key: 'spin_graduate',  name: 'Spin Graduate',   desc: 'Finish every Learn lesson.' },
    { key: 'daily_streak_3', name: 'Regular',         desc: 'Play the daily on three different days.' },
    { key: 'mastery_gold',   name: 'Mastery Gold',    desc: 'Earn three stars on every mastery stage.' },
    { key: 'century',        name: 'Century Break',   desc: 'Pot 100 balls over your career.' }
  ];

  return {
    CONTENT_VERSION: CONTENT_VERSION,
    BALLS: BALLS,
    THEMES: THEMES,
    JOURNEY: JOURNEY,
    CHALLENGES: CHALLENGES,
    LESSONS: LESSONS,
    PRACTICE: PRACTICE,
    ACHIEVEMENTS: ACHIEVEMENTS,
    ballNumbers: ballNumbers,
    practiceConfig: practiceConfig,
    dailyConfig: dailyConfig,
    journeyById: function (id) {
      for (var i = 0; i < JOURNEY.length; i++) if (JOURNEY[i].id === id) return JOURNEY[i];
      return null;
    },
    challengeById: function (id) {
      for (var i = 0; i < CHALLENGES.length; i++) if (CHALLENGES[i].id === id) return CHALLENGES[i];
      return null;
    },
    lessonById: function (id) {
      for (var i = 0; i < LESSONS.length; i++) if (LESSONS[i].id === id) return LESSONS[i];
      return null;
    },
    themeById: function (id) {
      for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
      return THEMES[0];
    }
  };
});
