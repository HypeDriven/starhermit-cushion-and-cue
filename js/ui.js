/* Cushion & Cue — UI glue (ES module). Screen routing, settings, progression
 * save (versioned + checksummed), HUD, input (pointer/touch/keyboard),
 * accessibility mirror, achievements. Owns no rules logic: everything goes
 * through CCSession/CCRules.
 */
import * as Render from './render.js';
import { mountGraphicsPanel, probeGpu } from './gfx-ui.js';

const Rules = window.CCRules;
const Content = window.CCContent;
const Session = window.CCSession;
const Audio = window.CCAudio;

const SETTINGS_KEY = 'cushion-and-cue-settings-v1';
const SAVE_KEY = 'cushion-and-cue-save-v1';
const SAVE_VERSION = 1;

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- settings -
const defaultSettings = {
  theme: 'tournament', quality: 'auto', gfx: {}, gfxV: 1,
  highContrast: false, reducedMotion: false, largerText: false, leftHanded: false,
  name: 'Guest'
};
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = Object.assign({}, defaultSettings, { gfxV: 0 }, JSON.parse(raw));
      if (!s.gfxV) {
        // v0 had one High/Medium/Low select defaulting to High: map it onto
        // the preset model (the old default becomes Auto).
        s.quality = { low: 'low', medium: 'balanced' }[s.quality] || 'auto';
        s.gfxV = 1;
      }
      if (!s.gfx || typeof s.gfx !== 'object') s.gfx = {};
      return s;
    }
  } catch (e) { /* keep defaults */ }
  return Object.assign({}, defaultSettings);
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  pushSettings();
}

// ---------------------------------------------------------------- platform -
// Every player-facing string follows the game language (js/i18n.js, keyed by
// the US-English text).
const T = (key, vars) => (window.CQCI18n ? window.CQCI18n.T(key, vars) : String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m)));
const N = (key) => key;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let platformSettingsReady = false;
// Preferences mirrored to the platform settings KV (the name is the account
// nickname when signed in, so it stays local).
function pushSettings() {
  const P = window.CQCPlatform;
  if (!P || !P.hosted || !platformSettingsReady) return;
  const { name, ...prefs } = settings;
  P.patchSettings(Object.assign(prefs, { audio: Audio.getVolumes() }));
}

// Key bindings: KeyboardEvent.code per action, platform overrides applied.
const DEFAULT_KEYS = {
  aimLeft: ['ArrowLeft'], aimRight: ['ArrowRight'],
  powerUp: ['ArrowUp', 'Equal', 'NumpadAdd'], powerDown: ['ArrowDown', 'Minus', 'NumpadSubtract'],
  shoot: ['Enter', 'Space'], hint: ['KeyH'], undo: ['KeyU'], pause: ['KeyP'], back: ['Escape'],
};
let bindings = DEFAULT_KEYS;
let keyAction = {};
function setBindings(b) {
  bindings = b;
  keyAction = {};
  for (const [a, codes] of Object.entries(b)) for (const c of codes || []) keyAction[c] = a;
}
setBindings(DEFAULT_KEYS);
const KEY_GLYPH = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Equal: '+', Minus: '−', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', Escape: 'Esc' };
const kbd = (action) => (bindings[action] || []).map((c) => `<kbd>${KEY_GLYPH[c] || c.replace(/^Key|^Digit/, '')}</kbd>`).join('/');

function applySettingsClasses() {
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  document.body.classList.toggle('larger-text', settings.largerText);
  document.body.classList.toggle('left-handed', settings.leftHanded);
  if (renderer) {
    renderer.setTheme(Content.themeById(settings.theme));
    renderer.setGraphics(gfxSaved());
    renderer.setHighContrast(settings.highContrast);
    renderer.setReducedMotion(settings.reducedMotion);
  }
}

// Graphics settings as CCGfx reads them: preset in settings.quality (kept
// under that key for compatibility), overrides/scale/toggles in settings.gfx.
function gfxSaved() { return Object.assign({}, settings.gfx, { preset: settings.quality }); }
let gfxPanel = null;

// ---------------------------------------------------------------- save -----
function blankSave() {
  return { version: SAVE_VERSION, journeyStars: {}, lessonsDone: {}, achievements: {},
           careerPots: 0, dailyDays: [], lastSnapshot: null, checksum: '' };
}
function checksumDoc(doc) {
  const copy = Object.assign({}, doc); delete copy.checksum;
  return Rules.hashState(copy); // FNV over stable stringify
}
let save = loadSave();
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return blankSave();
    const doc = JSON.parse(raw);
    if (doc.version !== SAVE_VERSION) return blankSave();
    if (doc.checksum !== checksumDoc(doc)) return blankSave(); // corrupt: start clean
    return doc;
  } catch (e) { return blankSave(); }
}
function persistSave() {
  save.checksum = checksumDoc(save);
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
  if (window.CQCPlatform && typeof window.CQCPlatform.onSave === 'function')
    window.CQCPlatform.onSave(JSON.stringify(save)); // mirror to the cloud slot
}
// Validates a save doc (local or from the cloud slot); null on bad shape or
// checksum. Remote-preferred loads go through here.
function parseSave(json) {
  try {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    if (!doc || doc.version !== SAVE_VERSION) return null;
    if (doc.checksum !== checksumDoc(doc)) return null;
    return doc;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- state ----
let renderer = null;
let sess = null;
let pendingConfig = null;
let pendingOpts = null;
let aimMilli = 0;          // current aim, integer milliradians
let power = 450;
let spinTop = 0, spinSide = 0;
let placePoint = null;     // chosen ball-in-hand spot {x,y} in meters
let actionSeq = 0;
let serverOffsetMs = null; // daily sync: serverTime - localTime
let lastMode = null;       // for retry/next

// ---------------------------------------------------------------- helpers --
function announce(msg, assertive) {
  const el = assertive ? $('sr-alert') : $('sr-live');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = msg; });
}
function toast(msg, assertive) {
  announce(msg, assertive);
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('toast-region').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
// Overlays (results, pause…) pad their bottom by the toast stack's height
// (layout px; overlays and toasts share #app's zoom) so a toast never covers
// the card's buttons.
(function watchToasts() {
  const root = document.getElementById('toast-region');
  if (!root || typeof MutationObserver === 'undefined') return;
  new MutationObserver(() => {
    document.documentElement.style.setProperty('--toast-h', root.childElementCount ? `${root.offsetHeight + 12}px` : '0px');
  }).observe(root, { childList: true });
})();
function starsText(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }
function hexCss(c) { return '#' + c.toString(16).padStart(6, '0'); }

// ---------------------------------------------------------------- router ---
const SCREENS = ['home', 'journey', 'learn', 'practice', 'challenge', 'setup', 'settings', 'help', 'game'];
let currentScreen = 'home';
let returnScreen = 'home';
function showScreen(name) {
  for (const s of SCREENS) $('screen-' + s).hidden = (s !== name);
  currentScreen = name;
  if (name === 'settings' && gfxPanel) gfxPanel.refresh();
  const first = $('screen-' + name).querySelector('h1, h2, button, [tabindex]');
  if (first && name !== 'game') {
    // headings are not focusable by default; make them programmatically so
    // that screen changes actually move focus instead of dropping it to body
    if (!first.hasAttribute('tabindex') && /^H[1-6]$/.test(first.tagName)) first.setAttribute('tabindex', '-1');
    first.focus();
  }
  if (name === 'game') $('canvas-host').focus();
}

// ---------------------------------------------------------------- renderer -
function ensureRenderer() {
  if (renderer) return;
  renderer = Render.create($('canvas-host'), {
    theme: Content.themeById(settings.theme),
    graphics: gfxSaved(),
    gpu: probeGpu().gpu,
    detected: probeGpu().detected,
    highContrast: settings.highContrast,
    reducedMotion: settings.reducedMotion,
    decorSeed: 7,
    onFallback() { toast(T('3D unavailable — using 2D table view.')); },
    onContextLost() {
      toast(T('Graphics context lost. The table view may freeze; the game state is safe. Reload to restore 3D.'), true);
    }
  });
  window.addEventListener('resize', () => renderer.resize());
}

// ---------------------------------------------------------------- lists ----
function journeyUnlocked(i) {
  if (i === 0) return true;
  return (save.journeyStars[Content.JOURNEY[i - 1].id] || 0) > 0;
}
function buildLists() {
  const jl = $('journey-list');
  jl.innerHTML = '';
  Content.JOURNEY.forEach((j, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card-btn';
    const stars = save.journeyStars[j.id] || 0;
    const unlocked = journeyUnlocked(i);
    b.disabled = !unlocked;
    b.innerHTML =
      `<span class="card-name">${i + 1}. ${esc(T(j.name))}</span>` +
      `<span class="card-sub">${esc(j.ruleset === 'eightball' ? T('8-ball match') :
        T('{balls} balls · {shots} shots', { balls: j.ballNumbers.length, shots: j.shotLimit }))}${j.mastery ? ' · ' + esc(T('Mastery')) : ''}</span>` +
      (unlocked ? `<span class="card-stars" aria-label="${esc(T('{n} of 3 stars', { n: stars }))}">${starsText(stars)}</span>`
                : `<span class="card-lock" aria-label="${esc(T('Locked'))}">🔒</span>`);
    b.addEventListener('click', () => openSetup(j, { kind: 'journey' }));
    li.appendChild(b); jl.appendChild(li);
  });

  const ll = $('lesson-list');
  ll.innerHTML = '';
  Content.LESSONS.forEach(l => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card-btn';
    const done = !!save.lessonsDone[l.id];
    b.innerHTML = `<span class="card-name">${esc(T(l.title))}</span>` +
      `<span class="card-sub">${esc(T('{n} steps', { n: l.steps.length }))}</span>` +
      (done ? `<span class="card-stars" aria-label="${esc(T('Completed'))}">✓</span>` : '');
    b.addEventListener('click', () => openSetup(lessonConfig(l), { kind: 'learn', lesson: l }));
    li.appendChild(b); ll.appendChild(li);
  });

  const pl = $('practice-list');
  pl.innerHTML = '';
  Content.PRACTICE.forEach(p => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card-btn';
    b.innerHTML = `<span class="card-name">${esc(T(p.name))}</span>` +
      `<span class="card-sub">${esc(p.ruleset === 'eightball' ? T('8-ball') : T('{balls} balls · {shots} shots', { balls: p.nBalls, shots: p.shotLimit }))}</span>`;
    b.addEventListener('click', () => {
      const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
      openSetup(Content.practiceConfig(p.id, seed), { kind: 'practice' });
    });
    li.appendChild(b); pl.appendChild(li);
  });

  const cl = $('challenge-list');
  cl.innerHTML = '';
  Content.CHALLENGES.forEach(c => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card-btn';
    const stars = save.journeyStars['ch:' + c.id] || 0;
    b.innerHTML = `<span class="card-name">${esc(T(c.name))}</span><span class="card-sub">${esc(T(c.blurb))}</span>` +
      `<span class="card-stars" aria-label="${esc(T('{n} of 3 stars', { n: stars }))}">${starsText(stars)}</span>`;
    b.addEventListener('click', () => openSetup(c, { kind: 'challenge' }));
    li.appendChild(b); cl.appendChild(li);
  });
}

function lessonConfig(lesson) {
  return {
    id: 'lesson-' + lesson.id, name: lesson.title, version: lesson.version, kind: 'learn',
    seed: lesson.seed, ruleset: lesson.ruleset, layout: lesson.layout,
    cueAt: lesson.cueAt, balls: lesson.balls, shotLimit: lesson.shotLimit,
    blackLast: !!lesson.blackLast, startInHand: !!lesson.startInHand,
    par: { shots: lesson.shotLimit }, mechanics: { undo: true, hint: true }
  };
}

// ---------------------------------------------------------------- setup ----
function openSetup(cfg, opts) {
  pendingConfig = cfg;
  pendingOpts = opts || {};
  renderSetup();
  showScreen('setup');
}

// Setup screen text for pendingConfig (re-rendered on a language change).
function renderSetup() {
  const cfg = pendingConfig;
  if (!cfg) return;
  $('setup-title').textContent = cfg.date ? T('Daily — {date}', { date: cfg.date }) : cfg.name ? T(cfg.name) : T('Set up');
  $('setup-rules').textContent = cfg.ruleset === 'eightball'
    ? T('8-ball: pot your group, then the 8. Fouls give ball in hand.')
    : cfg.shotLimit
      ? T(cfg.blackLast ? 'Clearance: pot every ball (black last) within {n} shots.' : 'Clearance: pot every ball within {n} shots.', { n: cfg.shotLimit })
      : T(cfg.blackLast ? 'Clearance: pot every ball (black last).' : 'Clearance: pot every ball.');
  $('setup-duration').textContent = cfg.ruleset === 'eightball' ? T('5–10 minutes')
    : (cfg.shotLimit || 8) <= 6 ? T('1–2 minutes') : T('2–4 minutes');
  $('setup-players').textContent = cfg.ruleset === 'eightball'
    ? (cfg.players && cfg.players.some(p => p.ai) ? T('You vs {name}', { name: T(cfg.players.find(p => p.ai).name) }) : T('2 players (hotseat)'))
    : T('Solo');
  $('setup-ranked').textContent = cfg.kind === 'daily' ? T('Yes (daily ranking)') : T('No');
  const mech = Object.assign({ undo: true, hint: true }, cfg.mechanics || {});
  $('setup-assists').textContent =
    (mech.hint ? T('Hints') : T('No hints')) + ' · ' + (mech.undo && cfg.kind !== 'daily' ? T('Undo') : T('No undo'));
  $('setup-intro').textContent = cfg.intro ? T(cfg.intro) : cfg.blurb ? T(cfg.blurb) : '';
}

// ---------------------------------------------------------------- game -----
function utcToday() {
  const now = serverOffsetMs != null ? new Date(Date.now() + serverOffsetMs) : new Date();
  return now.toISOString().slice(0, 10);
}

function startGame(cfg, opts) {
  opts = opts || {};
  ensureRenderer();
  Audio.unlock();
  Audio.reseed(cfg.seed >>> 0);
  Audio.rack();
  lastMode = { cfg, opts };
  // a restart can land mid-replay: drop the old playback before rebinding
  renderer.cancelTrace();
  toggleRail(false);
  sess = Session.create(cfg, { lesson: opts.lesson || null, ranked: cfg.kind === 'daily' });
  wireSession(sess);
  $('btn-skip').hidden = true;
  lockInput(false);
  aimMilli = 0; power = 450; spinTop = 0; spinSide = 0; placePoint = null;
  syncPowerUI(); syncSpinUI();
  $('lesson-banner').hidden = !opts.lesson;
  showScreen('game');
  renderer.resize();
  sess.start();
  const state = sess.getState();
  renderer.setSnapshot(state);
  refreshHUD();
  announce(T('Game started.') + ' ' + objectiveText(state));
}

function quitToHome() {
  toggleRail(false);
  if (renderer) renderer.cancelTrace();
  if (sess) { sess.pause('quit'); sess = null; }
  $('overlay-pause').hidden = true;
  $('overlay-results').hidden = true;
  buildLists();
  updateHomeProgress();
  showScreen('home');
}

function wireSession(s) {
  s.on('applied', d => {
    updateMirror();
    for (const e of d.events) {
      if (e.type === 'foul') { Audio.foul(); toast(T('Foul: {reason}', { reason: foulText(e.foul) }), true); }
      if (e.type === 'groups') {
        Audio.groupsSet();
        const st = s.getState();
        toast(T('Groups set: you are {group}.', { group: groupName(st.players[0].group) }));
      }
    }
    if (d.trace) {
      $('btn-skip').hidden = false;
      lockInput(true);
      Audio.strike(power / 1000);
      renderer.playTrace(d.trace, d.physics, {
        onPhysicsEvent(e) {
          if (e.type === 'hit') Audio.ballClick(e.speed);
          else if (e.type === 'cushion') Audio.cushion(e.speed);
          else if (e.type === 'pocket') { Audio.pocketDrop(); renderer.burstAt(0, 0, 0xffe9a0, false); }
        },
        onDone() {
          renderer.setSnapshot(s.getState());
          $('btn-skip').hidden = true;
          lockInput(false);
          // ack first: the session is still in 'resolving' here, so a HUD
          // refresh before this leaves Shoot/Hint/Undo disabled for good.
          s.ackResolved();
          refreshHUD();
        }
      });
    } else {
      renderer.setSnapshot(s.getState());
      refreshHUD();
      if (!s.getState().terminal) Audio.turnChime();
    }
  });
  s.on('invalid', d => toast(T('Not legal: {reason}', { reason: invalidText(d.invalid) }), true));
  s.on('ai-thinking', () => { aiAiming = true; $('hud-player').textContent = T('House is aiming…'); announce(T('House is aiming.')); });
  s.on('undone', () => { renderer.setSnapshot(s.getState()); refreshHUD(); toast(T('Shot undone.')); Audio.undo(); });
  s.on('hint', h => {
    Audio.cueBeep();
    if (h.shot) { aimMilli = h.shot.angle; syncAim(); toast(T('Hint: aim guide set to the suggested shot.')); }
    else if (h.place) {
      placePoint = { x: h.place.x / 1000, y: h.place.y / 1000 };
      renderer.setPlacementGhost(placePoint.x, placePoint.y);
      $('btn-place').hidden = false;
      toast(T('Hint: suggested cue ball position marked.'));
    }
  });
  s.on('lesson', d => {
    lessonEvent = d;
    renderLessonBanner();
    announce(d.done ? T('Lesson complete.') : $('lesson-banner').textContent);
  });
  s.on('results', r => showResults(r));
}

function lockInput(locked) {
  for (const id of ['btn-shoot', 'btn-hint', 'btn-undo', 'btn-place', 'power-slider', 'spin-pad']) {
    const el = $(id);
    if (locked) el.setAttribute('disabled', '');
    else el.removeAttribute('disabled');
  }
  refreshHUD();
}

// Lesson step banner (re-rendered on a language change).
let lessonEvent = null;
let aiAiming = false;
function renderLessonBanner() {
  const banner = $('lesson-banner');
  const d = lessonEvent;
  if (!d) return;
  banner.textContent = d.done
    ? T('Lesson complete!') + (d.outro ? ' ' + T(d.outro) : '')
    : T('Step {n}/{total}: {text}', { n: d.step + 1, total: d.total, text: T(d.text) });
}

function groupName(g) {
  return g === 'solid' || g === 'solids' ? T('solids') : g === 'stripe' || g === 'stripes' ? T('stripes') : g ? T(g) : T('open');
}

// ---------------------------------------------------------------- HUD ------
function objectiveText(state) {
  if (!state) return '';
  if (state.terminal) {
    return state.terminal.reason === Rules.TERMINAL.CLEAR || state.terminal.reason === Rules.TERMINAL.EIGHT_DONE
      ? T('Table finished.') : terminalReasonText(state.terminal.reason);
  }
  if (state.ruleset === 'eightball') {
    const me = state.players[0];
    if (state.openTable || !me.group) return T('Pot any ball except the 8 to claim a group.');
    if (Rules.pottedCount(state, me.group) === 7) return T('Your group is clear — pot the 8 to win.');
    return T('Pot your {group}, then the 8.', { group: groupName(me.group) });
  }
  const left = Rules.remainingTargets(state);
  if (state.blackLast && left === 1) return T('Pot the black to finish.');
  if (left === 1) return T('Pot the remaining ball.');
  return T(state.blackLast ? 'Pot the remaining {n} balls — the black goes last.' : 'Pot the remaining {n} balls.', { n: left });
}

function refreshHUD() {
  if (!sess) return;
  const state = sess.getState();
  if (!state) return;
  $('hud-objective').textContent = objectiveText(state);
  if (!(aiAiming && sess.isAITurn())) {
    aiAiming = false;
    $('hud-player').textContent = state.terminal ? T('Finished')
      : T('Turn: {name}', { name: T(state.players[state.current].name) });
  } else $('hud-player').textContent = T('House is aiming…');
  $('hud-score').textContent = T('Score {n}', { n: state.score.total }) + ' · ' +
    (state.ruleset === 'clearance' ? T('Shots left {n}', { n: state.shotsLeft })
     : T('Shots {n}', { n: state.shotCount }));
  $('rail-objective-text').textContent = objectiveText(state);
  $('rail-shots').textContent = state.ruleset === 'clearance'
    ? T('Shots left: {left} · Taken: {taken}', { left: state.shotsLeft, taken: state.shotCount })
    : T('Turn {n} · Shots: {shots}', { n: state.turn + 1, shots: state.shotCount });
  $('rail-timer').textContent = T('Table time: {n}s (simulated)', { n: Math.round(state.tick / 240) });

  const targets = Rules.legalTargets(state);
  const ul = $('rail-targets');
  ul.innerHTML = '';
  for (const b of state.balls) {
    if (b.n === 0) continue;
    const li = document.createElement('li');
    li.textContent = b.n;
    const hc = settings.highContrast;
    li.style.background = hexCss(hc ? Content.BALLS[b.n].colorHC : Content.BALLS[b.n].color);
    if (b.n === 8) li.style.color = '#f0e8d8';
    if (b.potted) li.className = 'done';
    else if (targets.indexOf(b.n) >= 0) li.style.borderColor = '#ffd970';
    li.setAttribute('aria-label', T(b.potted ? 'Ball {n}, potted' : targets.indexOf(b.n) >= 0 ? 'Ball {n}, legal target' : 'Ball {n}, not a legal target', { n: b.n }));
    ul.appendChild(li);
  }
  renderer.setLegalTargets(targets);

  const inHand = state.ballInHand && !state.terminal;
  const myTurn = !sess.isAITurn() && !state.terminal && sess.getPhase() === 'active';
  $('btn-place').hidden = !(inHand && placePoint);
  $('btn-shoot').hidden = inHand;
  $('btn-shoot').disabled = !myTurn || inHand;
  $('btn-hint').disabled = !myTurn || !state.mechanics.hint;
  $('btn-undo').disabled = !sess.canUndo();
  renderer.setPlacement(inHand);
  if (!inHand) { placePoint = null; renderer.setPlacementGhost(null); }
  syncAim();
  updateMirror();
}

function updateMirror() {
  if (!sess) return;
  const state = sess.getState();
  if (!state) { $('sr-table-text').textContent = T('No game in progress.'); return; }
  const parts = [];
  parts.push(objectiveText(state));
  parts.push(T('Turn: {name}. Score {n}.', { name: T(state.players[state.current].name), n: state.score.total }));
  if (state.ruleset === 'clearance') parts.push(T('{n} shots left.', { n: state.shotsLeft }));
  if (state.ballInHand) parts.push(T('Ball in hand: place the cue ball anywhere free.'));
  const live = state.balls.filter(b => !b.potted);
  parts.push(T('Balls on table: {list}.', { list: live.map(b => {
    const zoneX = b.x < -0.37 ? N('left') : b.x > 0.37 ? N('right') : N('center');
    const zoneY = b.y < -0.19 ? N('bottom') : b.y > 0.19 ? N('top') : N('middle');
    return (b.n === 0 ? T('cue') : String(b.n)) + ' (' + T(zoneY) + '-' + T(zoneX) + ')';
  }).join(', ') }));
  const t = Rules.legalTargets(state);
  if (t.length) parts.push(T('Legal targets: {list}.', { list: t.join(', ') }));
  $('sr-table-text').textContent = parts.join(' ');
}

function foulText(f) {
  return T({ 'no-contact': N('cue ball hit nothing'), 'wrong-first-contact': N('wrong ball first'),
    'no-rail-after-contact': N('no cushion after contact'), 'cue-ball-potted': N('cue ball potted (scratch)') }[f] || f);
}
function invalidText(i) {
  return T({ 'game-ended': N('the game is over'), 'unknown-command': N('unknown command'),
    'malformed-command': N('malformed command'), 'bad-angle': N('bad angle'), 'bad-power': N('bad power'),
    'bad-spin': N('bad spin'), 'not-ball-in-hand': N('no ball in hand right now'),
    'must-place-cue-first': N('place the cue ball first'), 'place-blocked': N('that spot is blocked'),
    'out-of-bounds': N('outside the table'), 'resolving': N('shot still resolving'),
    'not-your-turn': N('wait for the house'), 'duplicate-action': N('already committed'),
    'paused': N('game is paused') }[i] || i);
}

// ---------------------------------------------------------------- input ----
function syncAim() {
  if (!sess) return;
  const state = sess.getState();
  if (state && !state.ballInHand && !state.terminal) renderer.setAim(state, aimMilli);
  else renderer.setAim(null, null);
  $('aim-readout').textContent = T('Aim: {aim} rad · Power {power}%', { aim: (aimMilli / 1000).toFixed(2), power: Math.round(power / 10) });
}
function syncPowerUI() {
  $('power-slider').value = power;
  $('power-value').textContent = Math.round(power / 10) + '%';
}
function syncSpinUI() {
  const pad = $('spin-pad');
  const marker = $('spin-marker');
  marker.style.left = (50 + spinSide / 2) + '%';
  marker.style.top = (50 - spinTop / 2) + '%';
  pad.setAttribute('aria-valuenow', String(spinSide));
  const txt = (spinTop === 0 && spinSide === 0) ? T('No spin')
    : [spinTop ? (spinTop > 0 ? T('follow {n}', { n: spinTop }) : T('draw {n}', { n: -spinTop })) : '',
       spinSide ? (spinSide > 0 ? T('right {n}', { n: spinSide }) : T('left {n}', { n: -spinSide })) : '']
      .filter(Boolean).join(', ');
  pad.setAttribute('aria-valuetext', txt);
  $('spin-value').textContent = txt;
}

function tryShoot() {
  if (!sess) return;
  Audio.unlock(); Audio.uiClick();
  const res = sess.command({ type: 'shoot', angle: aimMilli, power: Math.round(power), spinTop, spinSide }, 'shot-' + (++actionSeq));
  if (res && res.ok) announce(T('Shot taken.'));
}

function tryPlace() {
  if (!sess || !placePoint) return;
  Audio.unlock();
  const cmd = { type: 'place', x: Math.round(placePoint.x * 1000), y: Math.round(placePoint.y * 1000) };
  const res = sess.command(cmd, 'place-' + (++actionSeq));
  if (res && res.ok) {
    Audio.placeBall();
    placePoint = null;
    renderer.setPlacementGhost(null);
    announce(T('Cue ball placed.'));
  }
}

function bindGameInput() {
  const host = $('canvas-host');

  // pointer/touch: drag aims from the cue ball; tap sets placement ghost
  let dragging = false, downAt = null;
  host.addEventListener('pointerdown', e => {
    Audio.unlock();
    if (!sess || sess.getPhase() !== 'active' || sess.isAITurn()) return;
    const state = sess.getState();
    if (!state || state.terminal) return;
    const p = renderer.tablePointFromScreen(e.clientX, e.clientY);
    if (!p) return;
    host.setPointerCapture(e.pointerId);
    dragging = true; downAt = p;
    if (state.ballInHand) {
      placePoint = p;
      renderer.setPlacementGhost(p.x, p.y);
      $('btn-place').hidden = false;
      Audio.uiClick();
    } else {
      const cue = state.balls[0];
      aimFromPoint(cue, p);
    }
    e.preventDefault();
  });
  host.addEventListener('pointermove', e => {
    if (!dragging || !sess) return;
    const state = sess.getState();
    const p = renderer.tablePointFromScreen(e.clientX, e.clientY);
    if (!p) return;
    if (state.ballInHand) {
      placePoint = p;
      renderer.setPlacementGhost(p.x, p.y);
    } else {
      aimFromPoint(state.balls[0], p);
    }
  });
  const endDrag = e => {
    if (dragging) { dragging = false; Audio.uiClick(); }
    downAt = null;
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);

  function aimFromPoint(cue, p) {
    const dx = p.x - cue.x, dy = p.y - cue.y;
    if (dx * dx + dy * dy < 1e-6) return;
    aimMilli = Math.round(((Math.atan2(dy, dx) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * 1000) % 6284;
    syncAim();
  }

  // keyboard
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = keyAction[e.code];
    if (currentScreen === 'game' && !$('overlay-pause').hidden) {
      if (action === 'back' || action === 'pause') { e.preventDefault(); resumeGame(); }
      return;
    }
    // results overlay is modal: let its buttons own the keyboard
    if (currentScreen === 'game' && !$('overlay-results').hidden) return;
    if (currentScreen !== 'game') {
      if (action === 'back' && currentScreen !== 'home') { e.preventDefault(); goBack(); }
      return;
    }
    if (action === 'back' && document.body.classList.contains('rail-left-open')) {
      e.preventDefault(); toggleRail(false); $('btn-rail').focus(); return;
    }
    if (!sess || !action) return;
    const ae = document.activeElement;
    const aeTag = ae && ae.tagName;
    // let focused buttons handle their own Enter/Space (avoid double commits)
    if ((e.code === 'Enter' || e.code === 'Space') && aeTag === 'BUTTON') return;
    // let native controls keep their keys
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(aeTag || '')) return;
    switch (action) {
      case 'aimLeft': aimMilli = (aimMilli + (e.shiftKey ? 1 : 8)) % 6284; syncAim(); break;
      case 'aimRight': aimMilli = (aimMilli - (e.shiftKey ? 1 : 8) + 6284) % 6284; syncAim(); break;
      case 'powerUp': power = Math.min(1000, power + 25); syncPowerUI(); syncAim(); break;
      case 'powerDown': power = Math.max(0, power - 25); syncPowerUI(); syncAim(); break;
      case 'shoot':
        if (sess.getState() && sess.getState().ballInHand) tryPlace(); else tryShoot();
        break;
      case 'hint': sess.hint(); break;
      case 'undo': sess.undo(); break;
      case 'pause': case 'back': pauseGame(); break;
    }
    e.preventDefault();
  });

  $('power-slider').addEventListener('input', () => { power = Number($('power-slider').value); syncAim(); syncPowerUI(); });

  // spin pad
  const pad = $('spin-pad');
  let spinDrag = false;
  function setSpinFromEvent(e) {
    const r = pad.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    if (nx * nx + ny * ny > 1) return;
    spinSide = Math.round(nx * 100);
    spinTop = Math.round(-ny * 100);
    syncSpinUI();
  }
  pad.addEventListener('pointerdown', e => { pad.setPointerCapture(e.pointerId); spinDrag = true; setSpinFromEvent(e); e.preventDefault(); });
  pad.addEventListener('pointermove', e => { if (spinDrag) setSpinFromEvent(e); });
  pad.addEventListener('pointerup', () => { spinDrag = false; });
  pad.addEventListener('keydown', e => {
    const step = 10;
    let used = true;
    if (e.key === 'ArrowLeft') spinSide = Math.max(-100, spinSide - step);
    else if (e.key === 'ArrowRight') spinSide = Math.min(100, spinSide + step);
    else if (e.key === 'ArrowUp') spinTop = Math.min(100, spinTop + step);
    else if (e.key === 'ArrowDown') spinTop = Math.max(-100, spinTop - step);
    else if (e.key === '0' || e.key === 'Home') { spinTop = 0; spinSide = 0; }
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); syncSpinUI(); }
  });

  $('btn-shoot').addEventListener('click', tryShoot);
  $('btn-place').addEventListener('click', tryPlace);
  $('btn-hint').addEventListener('click', () => sess && sess.hint());
  $('btn-undo').addEventListener('click', () => sess && sess.undo());
  $('btn-skip').addEventListener('click', () => renderer && renderer.skipTrace());
  $('btn-pause').addEventListener('click', pauseGame);
  $('btn-rail').addEventListener('click', () => { Audio.uiClick(); toggleRail(); });
  $('btn-rail-close').addEventListener('click', () => { Audio.uiClick(); toggleRail(false); $('btn-rail').focus(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && sess && sess.getPhase() === 'active') pauseGame('hidden');
  });
}

// Objective rail is a drawer on narrow/short layouts; the toggle is the only
// way to reach it there, so keep the button's state and the body class in step.
function toggleRail(open) {
  const want = open == null ? !document.body.classList.contains('rail-left-open') : !!open;
  document.body.classList.toggle('rail-left-open', want);
  $('btn-rail').setAttribute('aria-expanded', String(want));
  if (want) $('rail-left').focus();
}

function goBack() {
  showScreen(currentScreen === 'settings' || currentScreen === 'help' ? returnScreen : 'home');
  if (currentScreen === 'game' && sess && sess.getPhase() === 'paused') {
    $('overlay-pause').hidden = false;
    $('btn-resume').focus();
  }
}

function pauseGame(reason) {
  if (!sess) return;
  if (sess.pause(reason)) {
    $('overlay-pause').hidden = false;
    $('btn-resume').focus();
    announce(T('Paused.'));
  }
}
function resumeGame() {
  if (!sess) return;
  if (sess.resume()) {
    $('overlay-pause').hidden = true;
    refreshHUD();
    $('canvas-host').focus();
    announce(T('Resumed.'));
  }
}

// ---------------------------------------------------------------- results --
// Signed in only: post a finished table's total (not lessons, not hotseat)
// and show the player's rank on the high-score board.
function postToLeaderboard(r) {
  const line = $('res-leaderboard');
  const P = window.CQCPlatform;
  const cfg = lastMode && lastMode.cfg;
  const hotseat = !!(cfg && cfg.players && cfg.players.length > 1 && !cfg.players.some(p => p.ai));
  if (!P || !P.hosted || !cfg || cfg.kind === 'learn' || hotseat) { line.hidden = true; return; }
  line.hidden = false;
  lbResult = null;
  renderLeaderboardLine();
  P.submitScore(r.score.total).then(res => {
    lbResult = res;
    renderLeaderboardLine();
  });
}
let lbResult = null;
function renderLeaderboardLine() {
  const line = $('res-leaderboard');
  if (!line || line.hidden) return;
  const res = lbResult;
  line.textContent = !res ? T('Posting score to the leaderboard…') : !res.posted ? T('Score not posted to the leaderboard.')
    : res.rank ? T('Leaderboard rank: #{rank}', { rank: res.rank }) : T('Score posted to the leaderboard.');
}

// Results card text (re-rendered on a language change; no side effects).
let lastResults = null;
function renderResultsText() {
  if (!lastResults) return;
  const { r, newAch } = lastResults;
  const won = r.youWon;
  const headline = r.ruleset === 'eightball'
    ? (won ? T('You win the match!') : T('The house wins.'))
    : (won ? T('Table clear!') : terminalReasonText(r.terminal.reason));
  $('res-headline').textContent = headline;
  $('res-stars').textContent = starsText(r.stars);
  $('res-stars').setAttribute('aria-label', T('{n} of 3 stars', { n: r.stars }));

  const bd = $('res-breakdown');
  bd.innerHTML = '';
  const rows = [
    [T('Pots'), r.score.pots], [T('Win bonus'), r.score.winBonus],
    [T('Shot bonus'), r.score.shotBonus], [T('Foul penalty'), r.score.foulPenalty]
  ];
  for (const [label, val] of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = (val >= 0 ? '+' : '') + val;
    div.append(dt, dd);
    bd.appendChild(div);
  }
  const tot = document.createElement('div');
  tot.className = 'total-row';
  const tdt = document.createElement('dt'); tdt.textContent = T('Total');
  const tdd = document.createElement('dd'); tdd.textContent = r.score.total;
  tot.append(tdt, tdd);
  bd.appendChild(tot);
  $('res-detail').textContent = T('{shots} shots · {pots} pots · {fouls} fouls · {secs}s simulated',
    { shots: r.shots, pots: r.pots, fouls: r.fouls, secs: Math.round(r.elapsedTicks / 240) });
  const al = $('res-achievements');
  al.innerHTML = '';
  for (const key of newAch) {
    const a = Content.ACHIEVEMENTS.find(a => a.key === key);
    const li = document.createElement('li');
    li.textContent = '🏆 ' + T('Achievement: {name}', { name: a ? T(a.name) : key });
    al.appendChild(li);
  }
  renderLeaderboardLine();
  return headline;
}

function showResults(r) {
  refreshHUD();
  const state = sess.getState();
  const won = r.youWon;
  // progression + achievements
  const newAch = updateProgression(r);
  lastResults = { r, newAch };
  const headline = renderResultsText();
  if (newAch.length) {
    announce(T('Achievement unlocked: {name}', { name: newAch.map(k => { const a = Content.ACHIEVEMENTS.find(x => x.key === k); return a ? T(a.name) : k; }).join(', ') }));
    setTimeout(() => Audio.achievement(), 700); // after the win/lose motif
  }
  // key art banner only on a win; stays hidden if the image failed to load
  const art = $('res-art');
  art.hidden = !won || art.dataset.failed === '1';
  postToLeaderboard(r);

  if (won) Audio.win(); else Audio.lose();
  announce(T('{headline} Score {score}, {stars} stars.', { headline, score: r.score.total, stars: r.stars }), true);

  // next: journey advances, everything else goes back to its list
  const jIdx = Content.JOURNEY.findIndex(j => j.id === r.cfgId);
  $('btn-next').hidden = !(jIdx >= 0 && jIdx + 1 < Content.JOURNEY.length);
  $('overlay-results').hidden = false;
  // keep the headline in view on short screens: focus without scrolling the card
  $('btn-retry').focus({ preventScroll: true });
  $('overlay-results').querySelector('.overlay-card').scrollTop = 0;
}

function terminalReasonText(reason) {
  return T({
    'shot-limit': N('Out of shots.'), 'black-early': N('The black went down too soon.'),
    'black-scratch': N('Foul on the black.'), 'resigned': N('Resigned.')
  }[reason] || N('Game over.'));
}

function updateProgression(r) {
  const before = Object.assign({}, save.achievements);
  save.careerPots += r.pots;

  if (r.kind === 'journey') {
    const cur = save.journeyStars[r.cfgId] || 0;
    if (r.stars > cur) save.journeyStars[r.cfgId] = r.stars;
  }
  if (r.kind === 'challenge') {
    const k = 'ch:' + r.cfgId;
    if (r.stars > (save.journeyStars[k] || 0)) save.journeyStars[k] = r.stars;
  }
  if (r.kind === 'learn' && sess) {
    const ls = sess.getLesson();
    if (ls && ls.done) save.lessonsDone[ls.lesson.id] = true;
  }
  if (r.kind === 'daily') {
    const day = r.cfgId.replace('daily-', '');
    if (save.dailyDays.indexOf(day) < 0) save.dailyDays.push(day);
  }
  save.lastSnapshot = { cfgId: r.cfgId, total: r.score.total, stars: r.stars, at: new Date().toISOString() };

  // idempotent achievement checks
  const grant = key => { save.achievements[key] = true; };
  if (r.ruleset === 'clearance' && r.youWon) grant('first_clear');
  if (r.ruleset === 'eightball' && r.youWon) grant('first_match');
  if (Content.LESSONS.every(l => save.lessonsDone[l.id])) grant('spin_graduate');
  if (save.dailyDays.length >= 3) grant('daily_streak_3');
  if (Content.JOURNEY.filter(j => j.mastery).every(j => (save.journeyStars[j.id] || 0) >= 3)) grant('mastery_gold');
  if (save.careerPots >= 100) grant('century');

  persistSave();
  return Object.keys(save.achievements).filter(k => save.achievements[k] && !before[k]);
}

// ---------------------------------------------------------------- screens --
function buildHelp() {
  const p = (text) => `<p>${esc(text)}</p>`;
  const li = (text) => `<li>${esc(text)}</li>`;
  const cards = [
    [T('Controls'), `<ul>
      <li>${kbd('aimLeft')} ${kbd('aimRight')} ${esc(T('fine aim (hold Shift for finer)'))}</li>
      <li>${kbd('powerUp')} / ${kbd('powerDown')} ${esc(T('power'))}</li>
      <li>${kbd('shoot')} ${esc(T('shoot (or place, when ball in hand)'))}</li>
      <li>${kbd('hint')} ${esc(T('hint'))} · ${kbd('undo')} ${esc(T('undo'))} · ${kbd('pause')}/${kbd('back')} ${esc(T('pause'))}</li>
      ${li(T('Drag on the table to aim; tap a free spot to place the cue ball.'))}
      <li><kbd>Tab</kbd> ${esc(T('reaches every control.'))}</li></ul>`],
    [T('Clearance'), p(T('Pot every ball before your shots run out. Where the black is marked "last", potting it early loses the round.'))],
    [T('8-ball'), p(T('The table is open until someone pots legally — that group (solids or stripes) becomes theirs. Clear your group, then the 8. Potting the 8 early, or scratching on the 8, loses.'))],
    [T('Fouls'), `<ul>${li(T('Cue ball potted (scratch)'))}${li(T('No ball contacted'))}${li(T('Wrong ball hit first'))}${li(T('No cushion after contact'))}</ul>${p(T('A foul costs 75 points and gives ball in hand.'))}`],
    [T('Spin'), p(T('Follow (top spin) pushes the cue ball on after contact; draw pulls it back. Side spin kicks it sideways off cushions.'))],
    [T('Scoring'), p(T('+100 per pot, +500 win bonus, +50 per unused shot, −75 per foul. Three stars at par or better, two within two shots of par.'))]
  ];
  const host = $('help-cards');
  host.innerHTML = '';
  for (const [title, body] of cards) {
    const d = document.createElement('article');
    d.className = 'help-card';
    d.innerHTML = `<h3>${esc(title)}</h3>${body}`;
    host.appendChild(d);
  }
}

// Re-read the settings form from `settings` and the audio volumes (after the
// platform values were applied).
function syncSettingsForm() {
  $('set-theme').value = settings.theme;
  for (const [id, key] of [['set-contrast', 'highContrast'], ['set-motion', 'reducedMotion'], ['set-text', 'largerText'], ['set-lefthand', 'leftHanded']]) $(id).checked = settings[key];
  const vols = Audio.getVolumes();
  for (const bus of ['music', 'effects', 'ambience', 'voice']) $('vol-' + bus).value = Math.round(vols[bus] * 100);
  $('set-mute').checked = vols.muted;
  if (gfxPanel) gfxPanel.refresh();
}

function fillThemes() {
  const themeSel = $('set-theme');
  themeSel.innerHTML = '';
  for (const t of Content.THEMES) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = T(t.name);
    themeSel.appendChild(o);
  }
  themeSel.value = settings.theme;
}

function bindSettings() {
  const themeSel = $('set-theme');
  fillThemes();
  themeSel.addEventListener('change', () => { settings.theme = themeSel.value; saveSettings(); applySettingsClasses(); });
  gfxPanel = mountGraphicsPanel({
    getSaved: gfxSaved,
    setSaved(next) {
      settings.quality = next.preset || 'auto';
      settings.gfx = Object.assign({}, next);
      delete settings.gfx.preset;
      saveSettings();
      if (renderer) renderer.setGraphics(gfxSaved());
    },
    getRenderer: () => renderer
  });
  for (const [id, key] of [['set-contrast', 'highContrast'], ['set-motion', 'reducedMotion'], ['set-text', 'largerText'], ['set-lefthand', 'leftHanded']]) {
    $(id).checked = settings[key];
    $(id).addEventListener('change', () => { settings[key] = $(id).checked; saveSettings(); applySettingsClasses(); });
  }
  const vols = Audio.getVolumes();
  for (const bus of ['music', 'effects', 'ambience', 'voice']) {
    const el = $('vol-' + bus);
    el.value = Math.round(vols[bus] * 100);
    el.addEventListener('input', () => { Audio.unlock(); Audio.setVolume(bus, el.value / 100); });
    el.addEventListener('change', pushSettings);
  }
  $('set-mute').checked = vols.muted;
  $('set-mute').addEventListener('change', () => { Audio.setMuted($('set-mute').checked); pushSettings(); });
  $('set-tutorial').addEventListener('click', () => {
    const l = Content.LESSONS[0];
    openSetup(lessonConfig(l), { kind: 'learn', lesson: l });
  });
}

function bindMenus() {
  $('btn-play').addEventListener('click', () => {
    Audio.unlock(); Audio.uiClick();
    // short path to play: first unbeaten journey stage
    const idx = Content.JOURNEY.findIndex((j, i) => journeyUnlocked(i) && !(save.journeyStars[j.id] > 0));
    const j = Content.JOURNEY[idx < 0 ? Content.JOURNEY.length - 1 : idx];
    openSetup(j, { kind: 'journey' });
  });
  $('btn-daily').addEventListener('click', () => {
    Audio.unlock(); Audio.uiClick();
    openSetup(Content.dailyConfig(utcToday()), { kind: 'daily' });
  });
  $('btn-journey').addEventListener('click', () => { Audio.uiClick(); showScreen('journey'); });
  $('btn-learn').addEventListener('click', () => { Audio.uiClick(); showScreen('learn'); });
  $('btn-practice').addEventListener('click', () => { Audio.uiClick(); showScreen('practice'); });
  $('btn-challenge').addEventListener('click', () => { Audio.uiClick(); showScreen('challenge'); });
  $('btn-settings').addEventListener('click', () => { returnScreen = currentScreen; Audio.uiClick(); showScreen('settings'); });
  $('btn-help').addEventListener('click', () => { returnScreen = currentScreen; Audio.uiClick(); showScreen('help'); });

  for (const b of document.querySelectorAll('.btn-back')) {
    b.addEventListener('click', () => {
      Audio.uiClick();
      goBack();
    });
  }

  $('setup-start').addEventListener('click', () => {
    Audio.uiClick();
    startGame(pendingConfig, pendingOpts);
  });

  $('profile-name').value = settings.name;
  $('profile-name').addEventListener('change', () => {
    settings.name = $('profile-name').value.trim() || T('Guest');
    $('profile-name').value = settings.name;
    saveSettings();
  });

  // pause overlay
  $('btn-resume').addEventListener('click', resumeGame);
  $('btn-pause-restart').addEventListener('click', () => {
    $('overlay-pause').hidden = true;
    if (lastMode) startGame(lastMode.cfg, lastMode.opts);
  });
  $('btn-pause-settings').addEventListener('click', () => {
    $('overlay-pause').hidden = true;
    returnScreen = 'game';
    showScreen('settings');
  });
  $('btn-pause-quit').addEventListener('click', quitToHome);

  // results overlay
  $('btn-retry').addEventListener('click', () => {
    $('overlay-results').hidden = true;
    if (lastMode) startGame(lastMode.cfg, lastMode.opts);
  });
  $('btn-next').addEventListener('click', () => {
    $('overlay-results').hidden = true;
    const jIdx = Content.JOURNEY.findIndex(j => j.id === (lastMode && lastMode.cfg.id));
    if (jIdx >= 0 && jIdx + 1 < Content.JOURNEY.length) openSetup(Content.JOURNEY[jIdx + 1], { kind: 'journey' });
  });
  $('btn-results-home').addEventListener('click', quitToHome);
}

function updateHomeProgress() {
  const stars = Object.keys(save.journeyStars).filter(k => k.indexOf('ch:') !== 0)
    .reduce((n, k) => n + save.journeyStars[k], 0);
  const done = Content.JOURNEY.filter(j => (save.journeyStars[j.id] || 0) > 0).length;
  $('home-progress').textContent =
    T('Journey {done}/36 · {stars} stars · career pots {pots}', { done, stars, pots: save.careerPots });
}

// ---------------------------------------------------------------- time -----
function syncServerTime() {
  // Signed in only: adjust the daily boundary against the authoritative
  // clock. Standalone makes no own-server requests and uses local UTC.
  const P = window.CQCPlatform;
  if (!P || !P.hosted) { serverOffsetMs = null; return; }
  fetch('/api/v1/time', { headers: P.headers() })
    .then(r => r.json()).then(d => {
      if (typeof d.epochMs === 'number') serverOffsetMs = d.epochMs - Date.now();
    }).catch(() => { /* unreachable: local UTC clock is fine */ });
}

// Account + cloud-sync status line on the home screen. Offline keeps the
// identical local-only behaviour; hosted shows the account nickname.
function renderAccountLine() {
  const el = document.getElementById('account-line');
  const P = window.CQCPlatform;
  if (!el || !P) return;
  const canSign = P.canSignIn(), canInvite = P.hosted && !!P.inviteLink();
  $('btn-signin').hidden = !canSign;
  $('btn-invite').hidden = !canInvite;
  $('platform-row').hidden = !canSign && !canInvite;
  if (!P.hosted) {
    el.textContent = T('Offline — progress is stored on this device.');
    return;
  }
  const name = P.profile ? P.profile.name : '…';
  el.textContent = T('Playing as {name}', { name }) + ' · ' +
    (P.sync === 'synced' ? T('progress synced') : P.sync === 'saving' ? T('saving…') : T('cloud sync unavailable'));
}

function inviteFriend() {
  const link = window.CQCPlatform.inviteLink();
  if (!link) return;
  const fail = () => toast(T('Could not copy — invite link: {link}', { link }));
  try { navigator.clipboard.writeText(link).then(() => toast(T('Invite link copied to the clipboard.')), fail); } catch (e) { fail(); }
}

// Another device saved since this one last loaded: reload the cloud slot,
// merge it with local progress (better stars, every lesson, daily and
// achievement from either side, the larger career pot count), adopt the merge
// and save it back. A game in progress is untouched.
let merging = false;
function mergeCloudConflict() {
  const P = window.CQCPlatform;
  if (!P || merging) return;
  merging = true;
  P.loadCloud().then((remoteJson) => {
    if (P.saveConflicted()) return; // the reload failed: writes stay blocked
    const remote = remoteJson ? parseSave(remoteJson) : null;
    save = Session.mergeSaves(remote, save);
    persistSave(); // also pushes the merge to the cloud slot
    buildLists();
    updateHomeProgress();
    renderAccountLine();
  }).catch(() => {}).then(() => { merging = false; });
}

// The language changed: re-render every visible screen, the HUD, open
// overlays and live labels in place. The table, the shot replay and the
// session are untouched.
function onLanguageChange() {
  renderAccountLine();
  updateHomeProgress();
  buildLists();
  buildHelp();
  renderSetup();
  fillThemes();
  if (gfxPanel) gfxPanel.relabel();
  syncSpinUI();
  if (sess) {
    refreshHUD();
    renderLessonBanner();
    if (!$('overlay-results').hidden) renderResultsText();
  }
}

// Signed-in boot work: nickname, remote save (wins), settings KV, bindings.
function syncFromPlatform() {
  const P = window.CQCPlatform;
  if (!P || !P.hosted) return;
  P.fetchProfile().then(() => {
    renderAccountLine();
    // The account nickname replaces the editable local name when signed in
    // (the input stays as the offline fallback).
    if (P.profile) {
      settings.name = P.profile.name;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
      const nameInput = document.getElementById('profile-name');
      if (nameInput) { nameInput.value = P.profile.name; nameInput.disabled = true; }
    }
  }).catch(() => {});
  P.loadCloud().then((remoteJson) => {
    const remote = remoteJson ? parseSave(remoteJson) : null;
    if (remote) {
      save = remote;
      persistSave(); // local cache mirrors the remote doc
      updateHomeProgress();
    }
    renderAccountLine();
  }).catch(() => {});
  platformSettingsReady = false;
  P.getSettings().then((remote) => {
    platformSettingsReady = true;
    let changed = false;
    for (const k of Object.keys(defaultSettings)) {
      if (k === 'name' || remote == null || remote[k] == null || typeof remote[k] !== typeof defaultSettings[k]) continue;
      settings[k] = remote[k]; changed = true;
    }
    const a = remote && remote.audio;
    if (a && typeof a === 'object') {
      for (const bus of ['music', 'effects', 'ambience', 'voice']) if (typeof a[bus] === 'number') Audio.setVolume(bus, a[bus]);
      if (typeof a.muted === 'boolean') Audio.setMuted(a.muted);
      changed = true;
    }
    if (changed) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
      applySettingsClasses();
      syncSettingsForm();
    }
  }, () => { platformSettingsReady = true; });
  P.loadBindings(DEFAULT_KEYS).then((b) => { setBindings(b); buildHelp(); }).catch(() => {});
}

// ---------------------------------------------------------------- init -----
export function init() {
  // Platform handshake: StarHermit.init() reads the launch token; signed in,
  // the remote save, platform settings and key bindings win.
  const P = window.CQCPlatform;
  if (P) {
    try { P.init(); } catch (e) { /* offline */ }
    P.onSync(renderAccountLine);
    P.onAuth((signedIn) => {
      const nameInput = document.getElementById('profile-name');
      if (!signedIn && nameInput) nameInput.disabled = false;
      renderAccountLine();
      syncFromPlatform();
      syncServerTime();
    });
    P.onSaveConflict(mergeCloudConflict);
    $('btn-signin').addEventListener('click', () => P.signIn());
    $('btn-invite').addEventListener('click', () => { Audio.unlock(); inviteFriend(); });
    syncFromPlatform();
    renderAccountLine();
  }
  if (window.CQCI18n) window.CQCI18n.onChange(onLanguageChange);
  applySettingsClasses();
  buildLists();
  buildHelp();
  bindMenus();
  bindSettings();
  bindGameInput();
  updateHomeProgress();
  syncServerTime();
  document.addEventListener('pointerdown', () => Audio.unlock(), { once: true });
  document.addEventListener('keydown', () => Audio.unlock(), { once: true });
  showScreen('home');
}

export { init as default };
