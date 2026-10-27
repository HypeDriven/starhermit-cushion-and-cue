/* Cushion & Cue — the progression save (classic script → CCProgress; Node).
 * The browser build's save document, unchanged: { version 1, journeyStars
 * (stage ids and 'ch:<challenge id>' → best stars), lessonsDone,
 * achievements, careerPots, dailyDays, lastSnapshot, checksum } with an
 * FNV checksum over the rest (CCRules.hashState). It is the engine save
 * (starhermit:storage `saves`) and, as the browser build's JS SDK wrote it,
 * the old cloud slot's save.json. Pure: the engine client and the node
 * tests share it.
 */
(function (root, factory) {
  var deps = (typeof module === 'object' && module.exports)
    ? { Rules: require('./rules.js'), Content: require('./content.js'), Session: require('./session.js') }
    : { Rules: root.CCRules, Content: root.CCContent, Session: root.CCSession };
  var api = factory(deps.Rules, deps.Content, deps.Session);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCProgress = api;
})(typeof self !== 'undefined' ? self : this, function (Rules, Content, Session) {
  'use strict';

  var SAVE_VERSION = 1;

  function blankSave() {
    return { version: SAVE_VERSION, journeyStars: {}, lessonsDone: {}, achievements: {},
      careerPots: 0, dailyDays: [], lastSnapshot: null, checksum: '' };
  }
  function checksumDoc(doc) {
    var copy = {}, k;
    for (k in doc) if (k !== 'checksum') copy[k] = doc[k];
    return Rules.hashState(copy); // FNV over stable stringify
  }
  /** Stamps the checksum; returns the document. */
  function seal(doc) { doc.checksum = checksumDoc(doc); return doc; }
  /** A save document (object or JSON text) if its shape and checksum hold, else null. */
  function parseSave(json) {
    try {
      var doc = typeof json === 'string' ? JSON.parse(json) : json;
      if (!doc || typeof doc !== 'object' || doc.version !== SAVE_VERSION) return null;
      if (doc.checksum !== checksumDoc(doc)) return null;
      return doc;
    } catch (e) { return null; }
  }
  /** Two saves merged (better stars, every lesson / achievement / daily, the larger pot count, the later snapshot), sealed. */
  function merge(a, b) { return seal(Session.mergeSaves(a, b)); }
  function same(a, b) {
    var x = Object.assign({}, a || {}), y = Object.assign({}, b || {});
    delete x.checksum; delete y.checksum;
    return Rules.stableStringify(x) === Rules.stableStringify(y);
  }

  /** Journey stage i is open once stage i − 1 has a star. */
  function journeyUnlocked(save, i) {
    if (i === 0) return true;
    return (save.journeyStars[Content.JOURNEY[i - 1].id] || 0) > 0;
  }
  /** Play's stage: the first unlocked stage without a star, else the last. */
  function playStageIndex(save) {
    for (var i = 0; i < Content.JOURNEY.length; i++) {
      if (journeyUnlocked(save, i) && !(save.journeyStars[Content.JOURNEY[i].id] > 0)) return i;
    }
    return Content.JOURNEY.length - 1;
  }
  /** The home line's numbers: journey stages with a star, their stars, career pots. */
  function summary(save) {
    var stars = 0, done = 0;
    Object.keys(save.journeyStars).forEach(function (k) { if (k.indexOf('ch:') !== 0) stars += save.journeyStars[k]; });
    Content.JOURNEY.forEach(function (j) { if ((save.journeyStars[j.id] || 0) > 0) done++; });
    return { done: done, stars: stars, pots: save.careerPots };
  }

  /**
   * Records a finished game (CCSession result `r`; `lessonId` when a lesson
   * was completed) into `save` and checks the achievements (idempotent).
   * `nowIso` stamps the last-game snapshot. Returns the newly unlocked keys.
   * The caller persists (seal + save).
   */
  function record(save, r, lessonId, nowIso) {
    var before = Object.assign({}, save.achievements);
    save.careerPots += r.pots;
    if (r.kind === 'journey') {
      if (r.stars > (save.journeyStars[r.cfgId] || 0)) save.journeyStars[r.cfgId] = r.stars;
    }
    if (r.kind === 'challenge') {
      var k = 'ch:' + r.cfgId;
      if (r.stars > (save.journeyStars[k] || 0)) save.journeyStars[k] = r.stars;
    }
    if (r.kind === 'learn' && lessonId) save.lessonsDone[lessonId] = true;
    if (r.kind === 'daily') {
      var day = String(r.cfgId).replace('daily-', '');
      if (save.dailyDays.indexOf(day) < 0) save.dailyDays.push(day);
    }
    save.lastSnapshot = { cfgId: r.cfgId, total: r.score.total, stars: r.stars, at: nowIso };
    var grant = function (key) { save.achievements[key] = true; };
    if (r.ruleset === 'clearance' && r.youWon) grant('first_clear');
    if (r.ruleset === 'eightball' && r.youWon) grant('first_match');
    if (Content.LESSONS.every(function (l) { return save.lessonsDone[l.id]; })) grant('spin_graduate');
    if (save.dailyDays.length >= 3) grant('daily_streak_3');
    if (Content.JOURNEY.filter(function (j) { return j.mastery; }).every(function (j) { return (save.journeyStars[j.id] || 0) >= 3; })) grant('mastery_gold');
    if (save.careerPots >= 100) grant('century');
    return Object.keys(save.achievements).filter(function (key) { return save.achievements[key] && !before[key]; });
  }

  /** Whether a finished game posts to the leaderboard: not lessons, not hotseat. */
  function ranksOnBoard(cfg) {
    if (!cfg || cfg.kind === 'learn') return false;
    var hotseat = !!(cfg.players && cfg.players.length > 1 && !cfg.players.some(function (p) { return p.ai; }));
    return !hotseat;
  }

  // The browser build's settings, as its per-player account settings held
  // them (patchSettings: theme, quality, gfx, gfxV, highContrast,
  // reducedMotion, largerText, leftHanded, audio; ui.language from the
  // shared language helper). The game's own options among them carry over;
  // graphics, contrast, motion, text size, volumes and language are the
  // runtime's Options now.
  var LEGACY_KEYS = ['theme', 'quality', 'gfx', 'gfxV', 'highContrast', 'reducedMotion', 'largerText', 'leftHanded', 'audio', 'name', 'ui.language'];
  var GAME_SETTINGS = { theme: 'tournament', leftHanded: false, name: 'Guest' };
  /** A game option's value if valid, else undefined. */
  function checkSetting(key, v) {
    if (key === 'theme') return typeof v === 'string' && Content.THEMES.some(function (t) { return t.id === v; }) ? v : undefined;
    if (key === 'leftHanded') return typeof v === 'boolean' ? v : undefined;
    if (key === 'name') return typeof v === 'string' && v.trim() ? v.trim().slice(0, 24) : undefined;
    return undefined;
  }
  /** The game options found in an old settings object (other keys dropped). */
  function gameSettingsFrom(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(GAME_SETTINGS).forEach(function (k) {
      if (k === 'name') return; // the old name stayed on the device
      var v = checkSetting(k, obj[k]);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  return {
    SAVE_VERSION: SAVE_VERSION, LEGACY_KEYS: LEGACY_KEYS, GAME_SETTINGS: GAME_SETTINGS,
    blankSave: blankSave, checksumDoc: checksumDoc, seal: seal, parseSave: parseSave, merge: merge, same: same,
    journeyUnlocked: journeyUnlocked, playStageIndex: playStageIndex, summary: summary, record: record,
    ranksOnBoard: ranksOnBoard, checkSetting: checkSetting, gameSettingsFrom: gameSettingsFrom
  };
});
