/* Cushion & Cue — UI glue (ES module). Screen routing, settings, progression
 * save (versioned + checksummed), HUD, input (pointer/touch/keyboard),
 * accessibility mirror, achievements. Owns no rules logic: everything goes
 * through CCSession/CCRules.
 */
import * as Render from './render.js';

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
  theme: 'tournament', quality: 'high',
  highContrast: false, reducedMotion: false, largerText: false, leftHanded: false,
  name: 'Guest'
};
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return Object.assign({}, defaultSettings, JSON.parse(raw));
  } catch (e) { /* keep defaults */ }
  return Object.assign({}, defaultSettings);
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

function applySettingsClasses() {
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  document.body.classList.toggle('larger-text', settings.largerText);
  document.body.classList.toggle('left-handed', settings.leftHanded);
  if (renderer) {
    renderer.setTheme(Content.themeById(settings.theme));
    renderer.setQuality(settings.quality);
    renderer.setHighContrast(settings.highContrast);
    renderer.setReducedMotion(settings.reducedMotion);
  }
}

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
function starsText(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }
function hexCss(c) { return '#' + c.toString(16).padStart(6, '0'); }

// ---------------------------------------------------------------- router ---
const SCREENS = ['home', 'journey', 'learn', 'practice', 'challenge', 'setup', 'settings', 'help', 'game'];
let currentScreen = 'home';
let returnScreen = 'home';
function showScreen(name) {
  for (const s of SCREENS) $('screen-' + s).hidden = (s !== name);
  currentScreen = name;
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
    quality: settings.quality,
    highContrast: settings.highContrast,
    reducedMotion: settings.reducedMotion,
    decorSeed: 7,
    onFallback() { toast('3D unavailable — using 2D table view.'); },
    onContextLost() {
      toast('Graphics context lost. The table view may freeze; the game state is safe. Reload to restore 3D.', true);
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
      `<span class="card-name">${i + 1}. ${j.name}</span>` +
      `<span class="card-sub">${j.ruleset === 'eightball' ? '8-ball match' :
        j.ballNumbers.length + ' balls · ' + j.shotLimit + ' shots'}${j.mastery ? ' · Mastery' : ''}</span>` +
      (unlocked ? `<span class="card-stars" aria-label="${stars} of 3 stars">${starsText(stars)}</span>`
                : '<span class="card-lock" aria-label="Locked">🔒</span>');
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
    b.innerHTML = `<span class="card-name">${l.title}</span>` +
      `<span class="card-sub">${l.steps.length} steps</span>` +
      (done ? '<span class="card-stars" aria-label="Completed">✓</span>' : '');
    b.addEventListener('click', () => openSetup(lessonConfig(l), { kind: 'learn', lesson: l }));
    li.appendChild(b); ll.appendChild(li);
  });

  const pl = $('practice-list');
  pl.innerHTML = '';
  Content.PRACTICE.forEach(p => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'card-btn';
    b.innerHTML = `<span class="card-name">${p.name}</span>` +
      `<span class="card-sub">${p.ruleset === 'eightball' ? '8-ball' : p.nBalls + ' balls · ' + p.shotLimit + ' shots'}</span>`;
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
    b.innerHTML = `<span class="card-name">${c.name}</span><span class="card-sub">${c.blurb}</span>` +
      `<span class="card-stars" aria-label="${stars} of 3 stars">${starsText(stars)}</span>`;
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
  $('setup-title').textContent = cfg.name || 'Set up';
  $('setup-rules').textContent = cfg.ruleset === 'eightball'
    ? '8-ball: pot your group, then the 8. Fouls give ball in hand.'
    : 'Clearance: pot every ball' + (cfg.blackLast ? ' (black last)' : '') +
      (cfg.shotLimit ? ' within ' + cfg.shotLimit + ' shots.' : '.');
  $('setup-duration').textContent = cfg.ruleset === 'eightball' ? '5–10 minutes'
    : (cfg.shotLimit || 8) <= 6 ? '1–2 minutes' : '2–4 minutes';
  $('setup-players').textContent = cfg.ruleset === 'eightball'
    ? (cfg.players && cfg.players.some(p => p.ai) ? 'You vs ' + cfg.players.find(p => p.ai).name : '2 players (hotseat)')
    : 'Solo';
  $('setup-ranked').textContent = cfg.kind === 'daily' ? 'Yes (daily ranking)' : 'No';
  const mech = Object.assign({ undo: true, hint: true }, cfg.mechanics || {});
  $('setup-assists').textContent =
    (mech.hint ? 'Hints' : 'No hints') + ' · ' + (mech.undo && cfg.kind !== 'daily' ? 'Undo' : 'No undo');
  $('setup-intro').textContent = cfg.intro || cfg.blurb || '';
  showScreen('setup');
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
  announce('Game started. ' + objectiveText(state));
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
      if (e.type === 'foul') { Audio.foul(); toast('Foul: ' + foulText(e.foul), true); }
      if (e.type === 'groups') {
        const st = s.getState();
        toast('Groups set: you are ' + (st.players[0].group || 'open') + '.');
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
  s.on('invalid', d => toast('Not legal: ' + invalidText(d.invalid), true));
  s.on('ai-thinking', () => { $('hud-player').textContent = 'House is aiming…'; announce('House is aiming.'); });
  s.on('undone', () => { renderer.setSnapshot(s.getState()); refreshHUD(); toast('Shot undone.'); Audio.uiClick(); });
  s.on('hint', h => {
    Audio.cueBeep();
    if (h.shot) { aimMilli = h.shot.angle; syncAim(); toast('Hint: aim guide set to the suggested shot.'); }
    else if (h.place) {
      placePoint = { x: h.place.x / 1000, y: h.place.y / 1000 };
      renderer.setPlacementGhost(placePoint.x, placePoint.y);
      $('btn-place').hidden = false;
      toast('Hint: suggested cue ball position marked.');
    }
  });
  s.on('lesson', d => {
    const banner = $('lesson-banner');
    if (d.done) { banner.textContent = 'Lesson complete! ' + (d.outro || ''); announce('Lesson complete.'); }
    else { banner.textContent = 'Step ' + (d.step + 1) + '/' + d.total + ': ' + d.text; announce(banner.textContent); }
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

// ---------------------------------------------------------------- HUD ------
function objectiveText(state) {
  if (!state) return '';
  if (state.terminal) {
    return state.terminal.reason === Rules.TERMINAL.CLEAR || state.terminal.reason === Rules.TERMINAL.EIGHT_DONE
      ? 'Table finished.' : terminalReasonText(state.terminal.reason);
  }
  if (state.ruleset === 'eightball') {
    const me = state.players[0];
    if (state.openTable || !me.group) return 'Pot any ball except the 8 to claim a group.';
    if (Rules.pottedCount(state, me.group) === 7) return 'Your group is clear — pot the 8 to win.';
    return 'Pot your ' + me.group + 's, then the 8.';
  }
  const left = Rules.remainingTargets(state);
  if (state.blackLast && left === 1) return 'Pot the black to finish.';
  return 'Pot the remaining ' + left + ' ball' + (left === 1 ? '' : 's') +
    (state.blackLast ? ' — the black goes last.' : '.');
}

function refreshHUD() {
  if (!sess) return;
  const state = sess.getState();
  if (!state) return;
  $('hud-objective').textContent = objectiveText(state);
  $('hud-player').textContent = state.terminal ? 'Finished'
    : 'Turn: ' + state.players[state.current].name;
  $('hud-score').textContent = 'Score ' + state.score.total +
    (state.ruleset === 'clearance' ? ' · Shots left ' + state.shotsLeft
     : ' · Shots ' + state.shotCount);
  $('rail-objective-text').textContent = objectiveText(state);
  $('rail-shots').textContent = state.ruleset === 'clearance'
    ? 'Shots left: ' + state.shotsLeft + ' · Taken: ' + state.shotCount
    : 'Turn ' + (state.turn + 1) + ' · Shots: ' + state.shotCount;
  $('rail-timer').textContent = 'Table time: ' + Math.round(state.tick / 240) + 's (simulated)';

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
    li.setAttribute('aria-label', 'Ball ' + b.n + (b.potted ? ', potted' : targets.indexOf(b.n) >= 0 ? ', legal target' : ', not a legal target'));
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
  if (!state) { $('sr-table-text').textContent = 'No game in progress.'; return; }
  const parts = [];
  parts.push(objectiveText(state));
  parts.push('Turn: ' + state.players[state.current].name + '. Score ' + state.score.total + '.');
  if (state.ruleset === 'clearance') parts.push(state.shotsLeft + ' shots left.');
  if (state.ballInHand) parts.push('Ball in hand: place the cue ball anywhere free.');
  const live = state.balls.filter(b => !b.potted);
  parts.push('Balls on table: ' + live.map(b => {
    const zoneX = b.x < -0.37 ? 'left' : b.x > 0.37 ? 'right' : 'center';
    const zoneY = b.y < -0.19 ? 'bottom' : b.y > 0.19 ? 'top' : 'middle';
    return (b.n === 0 ? 'cue' : String(b.n)) + ' (' + zoneY + '-' + zoneX + ')';
  }).join(', ') + '.');
  const t = Rules.legalTargets(state);
  if (t.length) parts.push('Legal targets: ' + t.join(', ') + '.');
  $('sr-table-text').textContent = parts.join(' ');
}

function foulText(f) {
  return { 'no-contact': 'cue ball hit nothing', 'wrong-first-contact': 'wrong ball first',
    'no-rail-after-contact': 'no cushion after contact', 'cue-ball-potted': 'cue ball potted (scratch)' }[f] || f;
}
function invalidText(i) {
  return { 'game-ended': 'the game is over', 'unknown-command': 'unknown command',
    'malformed-command': 'malformed command', 'bad-angle': 'bad angle', 'bad-power': 'bad power',
    'bad-spin': 'bad spin', 'not-ball-in-hand': 'no ball in hand right now',
    'must-place-cue-first': 'place the cue ball first', 'place-blocked': 'that spot is blocked',
    'out-of-bounds': 'outside the table', 'resolving': 'shot still resolving',
    'not-your-turn': 'wait for the house', 'duplicate-action': 'already committed',
    'paused': 'game is paused' }[i] || i;
}

// ---------------------------------------------------------------- input ----
function syncAim() {
  if (!sess) return;
  const state = sess.getState();
  if (state && !state.ballInHand && !state.terminal) renderer.setAim(state, aimMilli);
  else renderer.setAim(null, null);
  $('aim-readout').textContent = 'Aim: ' + (aimMilli / 1000).toFixed(2) + ' rad · Power ' + Math.round(power / 10) + '%';
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
  const txt = (spinTop === 0 && spinSide === 0) ? 'No spin'
    : [spinTop ? (spinTop > 0 ? 'follow ' + spinTop : 'draw ' + (-spinTop)) : '',
       spinSide ? (spinSide > 0 ? 'right ' + spinSide : 'left ' + (-spinSide)) : '']
      .filter(Boolean).join(', ');
  pad.setAttribute('aria-valuetext', txt);
  $('spin-value').textContent = txt;
}

function tryShoot() {
  if (!sess) return;
  Audio.unlock(); Audio.uiClick();
  const res = sess.command({ type: 'shoot', angle: aimMilli, power: Math.round(power), spinTop, spinSide }, 'shot-' + (++actionSeq));
  if (res && res.ok) announce('Shot taken.');
}

function tryPlace() {
  if (!sess || !placePoint) return;
  Audio.unlock(); Audio.uiClick();
  const cmd = { type: 'place', x: Math.round(placePoint.x * 1000), y: Math.round(placePoint.y * 1000) };
  const res = sess.command(cmd, 'place-' + (++actionSeq));
  if (res && res.ok) {
    placePoint = null;
    renderer.setPlacementGhost(null);
    announce('Cue ball placed.');
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
    if (currentScreen === 'game' && !$('overlay-pause').hidden) {
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') { e.preventDefault(); resumeGame(); }
      return;
    }
    // results overlay is modal: let its buttons own the keyboard
    if (currentScreen === 'game' && !$('overlay-results').hidden) return;
    if (currentScreen !== 'game') {
      if (e.key === 'Escape' && currentScreen !== 'home') { e.preventDefault(); goBack(); }
      return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('rail-left-open')) {
      e.preventDefault(); toggleRail(false); $('btn-rail').focus(); return;
    }
    if (!sess) return;
    const ae = document.activeElement;
    const aeTag = ae && ae.tagName;
    // let focused buttons handle their own Enter/Space (avoid double commits)
    if ((e.key === 'Enter' || e.key === ' ') && aeTag === 'BUTTON') return;
    // let native controls keep their keys
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(aeTag || '')) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': aimMilli = (aimMilli + (e.shiftKey ? 1 : 8)) % 6284; syncAim(); break;
      case 'ArrowRight': aimMilli = (aimMilli - (e.shiftKey ? 1 : 8) + 6284) % 6284; syncAim(); break;
      case 'ArrowUp': power = Math.min(1000, power + 25); syncPowerUI(); syncAim(); break;
      case 'ArrowDown': power = Math.max(0, power - 25); syncPowerUI(); syncAim(); break;
      case '+': case '=': power = Math.min(1000, power + 25); syncPowerUI(); syncAim(); break;
      case '-': case '_': power = Math.max(0, power - 25); syncPowerUI(); syncAim(); break;
      case 'Enter': case ' ':
        if (sess.getState() && sess.getState().ballInHand) tryPlace(); else tryShoot();
        break;
      case 'h': case 'H': sess.hint(); break;
      case 'u': case 'U': sess.undo(); break;
      case 'p': case 'P': case 'Escape': pauseGame(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
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
    announce('Paused.');
  }
}
function resumeGame() {
  if (!sess) return;
  if (sess.resume()) {
    $('overlay-pause').hidden = true;
    refreshHUD();
    $('canvas-host').focus();
    announce('Resumed.');
  }
}

// ---------------------------------------------------------------- results --
function showResults(r) {
  refreshHUD();
  const state = sess.getState();
  const won = r.youWon;
  const headline = r.ruleset === 'eightball'
    ? (won ? 'You win the match!' : 'The house wins.')
    : (won ? 'Table clear!' : terminalReasonText(r.terminal.reason));
  $('res-headline').textContent = headline;
  $('res-stars').textContent = starsText(r.stars);
  $('res-stars').setAttribute('aria-label', r.stars + ' of 3 stars');

  const bd = $('res-breakdown');
  bd.innerHTML = '';
  const rows = [
    ['Pots', r.score.pots], ['Win bonus', r.score.winBonus],
    ['Shot bonus', r.score.shotBonus], ['Foul penalty', r.score.foulPenalty]
  ];
  for (const [label, val] of rows) {
    const div = document.createElement('div');
    div.innerHTML = `<dt>${label}</dt><dd>${val >= 0 ? '+' : ''}${val}</dd>`;
    bd.appendChild(div);
  }
  const tot = document.createElement('div');
  tot.className = 'total-row';
  tot.innerHTML = `<dt>Total</dt><dd>${r.score.total}</dd>`;
  bd.appendChild(tot);
  $('res-detail').textContent =
    `${r.shots} shots · ${r.pots} pots · ${r.fouls} fouls · ${Math.round(r.elapsedTicks / 240)}s simulated`;

  // progression + achievements
  const newAch = updateProgression(r);
  const al = $('res-achievements');
  al.innerHTML = '';
  for (const key of newAch) {
    const a = Content.ACHIEVEMENTS.find(a => a.key === key);
    const li = document.createElement('li');
    li.textContent = '🏆 Achievement: ' + (a ? a.name : key);
    al.appendChild(li);
  }
  if (newAch.length) announce('Achievement unlocked: ' + newAch.join(', '));

  if (won) Audio.win(); else Audio.lose();
  announce(headline + ' Score ' + r.score.total + ', ' + r.stars + ' stars.', true);

  // next: journey advances, everything else goes back to its list
  const jIdx = Content.JOURNEY.findIndex(j => j.id === r.cfgId);
  $('btn-next').hidden = !(jIdx >= 0 && jIdx + 1 < Content.JOURNEY.length);
  $('overlay-results').hidden = false;
  $('btn-retry').focus();
}

function terminalReasonText(reason) {
  return {
    'shot-limit': 'Out of shots.', 'black-early': 'The black went down too soon.',
    'black-scratch': 'Foul on the black.', 'resigned': 'Resigned.'
  }[reason] || 'Game over.';
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
  const cards = [
    ['Controls', `<ul>
      <li><kbd>←</kbd><kbd>→</kbd> fine aim (hold <kbd>Shift</kbd> for finer)</li>
      <li><kbd>+</kbd>/<kbd>−</kbd> or <kbd>↑</kbd><kbd>↓</kbd> power</li>
      <li><kbd>Enter</kbd>/<kbd>Space</kbd> shoot (or place, when ball in hand)</li>
      <li><kbd>H</kbd> hint · <kbd>U</kbd> undo · <kbd>P</kbd>/<kbd>Esc</kbd> pause</li>
      <li>Drag on the table to aim; tap a free spot to place the cue ball.</li>
      <li><kbd>Tab</kbd> reaches every control.</li></ul>`],
    ['Clearance', '<p>Pot every ball before your shots run out. Where the black is marked "last", potting it early loses the round.</p>'],
    ['8-ball', '<p>The table is open until someone pots legally — that group (solids or stripes) becomes theirs. Clear your group, then the 8. Potting the 8 early, or scratching on the 8, loses.</p>'],
    ['Fouls', '<ul><li>Cue ball potted (scratch)</li><li>No ball contacted</li><li>Wrong ball hit first</li><li>No cushion after contact</li></ul><p>A foul costs 75 points and gives ball in hand.</p>'],
    ['Spin', '<p>Follow (top spin) pushes the cue ball on after contact; draw pulls it back. Side spin kicks it sideways off cushions.</p>'],
    ['Scoring', '<p>+100 per pot, +500 win bonus, +50 per unused shot, −75 per foul. Three stars at par or better, two within two shots of par.</p>']
  ];
  const host = $('help-cards');
  host.innerHTML = '';
  for (const [title, body] of cards) {
    const d = document.createElement('article');
    d.className = 'help-card';
    d.innerHTML = `<h3>${title}</h3>${body}`;
    host.appendChild(d);
  }
}

function bindSettings() {
  const themeSel = $('set-theme');
  themeSel.innerHTML = '';
  for (const t of Content.THEMES) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    themeSel.appendChild(o);
  }
  themeSel.value = settings.theme;
  themeSel.addEventListener('change', () => { settings.theme = themeSel.value; saveSettings(); applySettingsClasses(); });
  $('set-quality').value = settings.quality;
  $('set-quality').addEventListener('change', () => { settings.quality = $('set-quality').value; saveSettings(); applySettingsClasses(); });
  for (const [id, key] of [['set-contrast', 'highContrast'], ['set-motion', 'reducedMotion'], ['set-text', 'largerText'], ['set-lefthand', 'leftHanded']]) {
    $(id).checked = settings[key];
    $(id).addEventListener('change', () => { settings[key] = $(id).checked; saveSettings(); applySettingsClasses(); });
  }
  const vols = Audio.getVolumes();
  for (const bus of ['music', 'effects', 'ambience', 'voice']) {
    const el = $('vol-' + bus);
    el.value = Math.round(vols[bus] * 100);
    el.addEventListener('input', () => { Audio.unlock(); Audio.setVolume(bus, el.value / 100); });
  }
  $('set-mute').checked = vols.muted;
  $('set-mute').addEventListener('change', () => { Audio.setMuted($('set-mute').checked); });
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
    settings.name = $('profile-name').value.trim() || 'Guest';
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
    `Journey ${done}/36 · ${stars} stars · career pots ${save.careerPots}`;
}

// ---------------------------------------------------------------- time -----
function syncServerTime() {
  // optional: adjust daily boundary against the authoritative clock
  const t0 = Date.now();
  fetch('/api/v1/time').then(r => r.json()).then(d => {
    if (typeof d.epochMs === 'number') serverOffsetMs = d.epochMs - Date.now();
  }).catch(() => { /* offline: local UTC clock is fine */ });
}

// ---------------------------------------------------------------- init -----
export function init() {
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
