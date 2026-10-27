// Cushion & Cue on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules and physics, content, session
// controller, progression save and string tables are the browser build's
// js/*.js (classic.ts); this module is what js/ui.js did around them — the
// screen router (home → journey | learn | practice | challenges → setup →
// game ⇄ pause → results → next | retry | home; settings and help from home
// and pause), the session's events (fouls, groups, hints, undo, lessons,
// results with progression, achievements and the leaderboard post), the
// aim / power / spin / place inputs (actions, the table drag, the spin pad
// and the power slider) and the lifecycle — with the screens and HUD drawn
// by screens.ts (starhermit:ui) and the table by render.ts
// (starhermit:scene).
//
// Every shot still resolves synchronously in js/rules.js before a frame is
// drawn; its replay plays one 60 Hz trace frame a fixed step (the runtime's
// 60 steps a second), physics events firing on the step their tick is
// reached, and the session's AI pacing (750 ms) is counted in the same steps
// (session timers), so a session replays identically and play scripts are
// exact. Held aim and power keys repeat on fixed steps too.
import { frame, onFixedUpdate, onPreferencesChange, onQuit, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { isDown, isKeyDown, onAction } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, Progress, Rules, Session, type Applied, type Cfg, type Lesson, type PhysEvent, type Result, type SessionApi, type State, type Timers, type Trace } from "./classic.ts";
import { N, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

export type ScreenName = "home" | "journey" | "learn" | "practice" | "challenge" | "setup" | "settings" | "help" | "game";
export type Overlay = null | "pause" | "results";
export interface Mode { kind: string; lesson?: Lesson | null }
export type LbState = null | "posting" | { posted: boolean; rank: number | null };
export interface ResultsView { r: Result; newAch: string[]; next: boolean }

const STEP_HZ = 60;
export const settings = platform.settings;
export const app = {
  screen: "home" as ScreenName,
  returnScreen: "home" as ScreenName,
  overlay: null as Overlay,
  /** The objective rail as a drawer (narrow and short layouts). */
  drawer: false,
  /** Frame the screen or overlay opened on (focus moves two frames later; its key must not also close it). */
  openedFrame: 0,
  focusNext: false,
  toasts: [] as { text: () => string; until: number }[],
  results: null as ResultsView | null,
  lb: null as LbState,
};

// ------------------------------------------------------------------ the game's state
export let sess: SessionApi | null = null;
export let pendingConfig: Cfg | null = null;
export let pendingMode: Mode = { kind: "journey" };
let lastMode: { cfg: Cfg; mode: Mode } | null = null;
export const aim = { milli: 0, power: 450, spinTop: 0, spinSide: 0 };
export let placePoint: { x: number; y: number } | null = null;
let actionSeq = 0;
export let lessonEvent: { done: boolean; step: number; total: number; text?: string; outro?: string } | null = null;
export let aiAiming = false;
interface Playback { trace: Trace; physics: PhysEvent[]; fi: number; pi: number; tick0: number }
let playback: Playback | null = null;
let pendingResults = false;
export const replaying = (): boolean => !!playback;

const now = (): number => frame().time;
export function announce(msg: string, assertive = false): void {
  if (msg) ui.announce(msg.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
/** A toast (bottom centre, 3.2 s); `text` re-runs each frame so a visible toast follows a language change. */
export function toast(text: () => string, assertive = false): void {
  announce(text(), assertive);
  app.toasts.push({ text, until: now() + 3.2 });
  if (app.toasts.length > 4) app.toasts.shift();
}

// ------------------------------------------------------------------ fixed-step timers
// The session's AI pacing and the achievement chime, counted in fixed steps.
let steps = 0;
let timerSeq = 0;
const timers = new Map<number, { at: number; fn: () => void }>();
export const stepTimers: Timers = {
  set(fn, ms) { const id = ++timerSeq; timers.set(id, { at: steps + Math.max(1, Math.round((ms * STEP_HZ) / 1000)), fn }); return id; },
  clear(h) { timers.delete(h); },
};
function runTimers(): void {
  for (const [id, t] of [...timers]) {
    if (t.at > steps) continue;
    timers.delete(id);
    t.fn();
  }
}

// ------------------------------------------------------------------ screens
function opened(): void {
  app.openedFrame = frame().frame;
  app.focusNext = true;
}
export function showScreen(name: ScreenName): void {
  app.screen = name;
  if (name !== "game") app.drawer = false;
  opened();
}
export function openSettings(): void { app.returnScreen = app.screen; showScreen("settings"); }
export function openHelp(): void { app.returnScreen = app.screen; showScreen("help"); }
export function goBack(): void {
  showScreen(app.screen === "settings" || app.screen === "help" ? app.returnScreen : "home");
  if (app.screen === "game" && sess && sess.getPhase() === "paused") { app.overlay = "pause"; opened(); }
}
export function toggleDrawer(open?: boolean): void {
  app.drawer = open == null ? !app.drawer : open;
}

// ------------------------------------------------------------------ setup
export function lessonConfig(lesson: Lesson): Cfg {
  const l = lesson as Lesson & Record<string, unknown>;
  return {
    id: "lesson-" + lesson.id, name: lesson.title, version: l.version as number, kind: "learn",
    seed: l.seed as number, ruleset: l.ruleset as string, layout: l.layout as string,
    cueAt: l.cueAt as { x: number; y: number }, balls: l.balls as unknown[], shotLimit: l.shotLimit as number,
    blackLast: !!l.blackLast, startInHand: !!l.startInHand,
    par: { shots: l.shotLimit as number }, mechanics: { undo: true, hint: true },
  };
}
export function openSetup(cfg: Cfg, mode: Mode): void {
  pendingConfig = cfg;
  pendingMode = mode;
  showScreen("setup");
}
export function openPlay(): void {
  const j = Content.JOURNEY[Progress.playStageIndex(platform.save())]!;
  openSetup(j, { kind: "journey" });
}
export function utcToday(): string { return new Date(platform.nowMs()).toISOString().slice(0, 10); }
export function openDaily(): void { openSetup(Content.dailyConfig(utcToday()), { kind: "daily" }); }
export function openPractice(id: string): void {
  const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  openSetup(Content.practiceConfig(id, seed), { kind: "practice" });
}
export function openLesson(l: Lesson): void { openSetup(lessonConfig(l), { kind: "learn", lesson: l }); }

// ------------------------------------------------------------------ the game
export function startGame(cfg: Cfg, mode: Mode): void {
  audio.reseed(cfg.seed >>> 0);
  audio.cue("rack");
  lastMode = { cfg, mode };
  // a restart can land mid-replay: drop the old playback before rebinding
  playback = null;
  pendingResults = false;
  timers.clear();
  if (sess) sess.pause("quit");
  app.drawer = false;
  app.overlay = null;
  app.results = null;
  app.lb = null;
  sess = Session.create(cfg, { lesson: mode.lesson ?? null, ranked: cfg.kind === "daily", timers: stepTimers });
  wireSession(sess);
  aim.milli = 0; aim.power = 450; aim.spinTop = 0; aim.spinSide = 0; placePoint = null;
  lessonEvent = null;
  aiAiming = false;
  render.setTheme(Content.themeById(settings.theme));
  showScreen("game");
  const state = sess.start();
  render.setSnapshot(state);
  syncTable();
  announce(`${T("Game started.")} ${objectiveText(state)}`);
}
export function restartGame(): void { if (lastMode) startGame(lastMode.cfg, lastMode.mode); }
export function quitToHome(): void {
  playback = null;
  pendingResults = false;
  timers.clear();
  if (sess) { sess.pause("quit"); sess = null; }
  app.overlay = null;
  app.results = null;
  render.setSnapshot(null);
  render.setAim(null, null);
  render.setPlacementGhost(null);
  showScreen("home");
}

function wireSession(s: SessionApi): void {
  s.on("applied", (d: Applied) => {
    if (s !== sess) return;
    for (const e of d.events) {
      if (e.type === "foul") { audio.cue("foul"); toast(() => T("Foul: {reason}", { reason: foulText(e.foul ?? "") }), true); }
      if (e.type === "groups") {
        audio.cue("groups");
        toast(() => T("Groups set: you are {group}.", { group: groupName(s.getState()?.players[0]?.group ?? null) }));
      }
    }
    if (d.trace) {
      audio.cue("strike");
      playback = { trace: d.trace, physics: d.physics || [], fi: 0, pi: 0, tick0: render.lastTick() };
      render.applyFrame(d.trace.frames[0]);
    } else {
      render.setSnapshot(s.getState());
      if (!s.getState().terminal) audio.cue("turnChime");
    }
    syncTable();
  });
  s.on("invalid", (d: { invalid: string }) => { if (s === sess) toast(() => T("Not legal: {reason}", { reason: invalidText(d.invalid) }), true); });
  s.on("ai-thinking", () => { if (s !== sess) return; aiAiming = true; announce(T("House is aiming.")); });
  s.on("undone", () => {
    if (s !== sess) return;
    render.setSnapshot(s.getState());
    syncTable();
    toast(() => T("Shot undone."));
    audio.cue("undo");
  });
  s.on("hint", (h: { shot?: { angle: number }; place?: { x: number; y: number } } | null) => {
    if (s !== sess || !h) return;
    audio.cue("cueBeep");
    if (h.shot) { aim.milli = h.shot.angle; syncTable(); toast(() => T("Hint: aim guide set to the suggested shot.")); }
    else if (h.place) {
      placePoint = { x: h.place.x / 1000, y: h.place.y / 1000 };
      syncTable();
      toast(() => T("Hint: suggested cue ball position marked."));
    }
  });
  s.on("lesson", (d: NonNullable<typeof lessonEvent>) => {
    if (s !== sess) return;
    lessonEvent = d;
    announce(d.done ? T("Lesson complete.") : lessonText());
  });
  // The session emits "results" again when the final shot's replay settles
  // (js/session.js re-enters 'resolving' after finishing); record it once
  // (the browser build recorded it twice: career pots counted double).
  let recorded = false;
  s.on("results", (r: Result) => { if (s === sess && !recorded) { recorded = true; recordResults(r); } });
}

export function lessonText(): string {
  const d = lessonEvent;
  if (!d) return "";
  return d.done
    ? T("Lesson complete!") + (d.outro ? " " + T(d.outro) : "")
    : T("Step {n}/{total}: {text}", { n: d.step + 1, total: d.total, text: T(d.text ?? "") });
}

/** What the table shows besides the balls: legal-target rings, the placement ghost, the aim guide. */
export function syncTable(): void {
  if (!sess) return;
  const state = sess.getState();
  if (!state) return;
  render.setLegalTargets(Rules.legalTargets(state));
  const inHand = state.ballInHand && !state.terminal;
  if (!inHand) placePoint = null;
  render.setPlacementGhost(inHand && placePoint ? placePoint.x : null, placePoint?.y ?? 0);
  if (!playback && !state.ballInHand && !state.terminal) render.setAim(state, aim.milli);
  else render.setAim(null, null);
}

// ------------------------------------------------------------------ playback (one trace frame a fixed step)
function stepPlayback(): void {
  const p = playback;
  if (!p) return;
  p.fi = Math.min(p.trace.frames.length - 1, p.fi + 1);
  render.applyFrame(p.trace.frames[p.fi]);
  // fire physics events whose sample tick has been reached
  const tickReached = p.fi * p.trace.every;
  while (p.pi < p.physics.length && p.physics[p.pi]!.tick <= p.tick0 + tickReached) physicsEvent(p.physics[p.pi++]!);
  if (p.fi >= p.trace.frames.length - 1) finishPlayback();
}
function physicsEvent(e: PhysEvent): void {
  if (e.type === "hit") audio.cue("ballClick");
  else if (e.type === "cushion") audio.cue("cushion");
  else if (e.type === "pocket") { audio.cue("pocketDrop"); render.pocketBurst(e.pocket ?? 0); }
}
export function skipReplay(): void {
  const p = playback;
  if (!p) return;
  render.applyFrame(p.trace.frames[p.trace.frames.length - 1]);
  finishPlayback();
}
function finishPlayback(): void {
  playback = null;
  const s = sess;
  if (!s) return;
  render.setSnapshot(s.getState());
  // ack first: the session is still 'resolving' here
  s.ackResolved();
  syncTable();
  if (pendingResults) { pendingResults = false; openResults(); }
}

// ------------------------------------------------------------------ commands
export function canAct(): boolean {
  if (!sess || playback || app.overlay) return false;
  const st = sess.getState();
  return !!st && !st.terminal && sess.getPhase() === "active" && !sess.isAITurn();
}
export function tryShoot(): void {
  if (!sess) return;
  audio.cue("uiClick");
  if (playback) { toast(() => T("Not legal: {reason}", { reason: invalidText("resolving") }), true); return; }
  const res = sess.command({ type: "shoot", angle: aim.milli, power: Math.round(aim.power), spinTop: aim.spinTop, spinSide: aim.spinSide }, "shot-" + ++actionSeq);
  if (res && res.ok) announce(T("Shot taken."));
}
export function tryPlace(): void {
  if (!sess || !placePoint || playback) return;
  const res = sess.command({ type: "place", x: Math.round(placePoint.x * 1000), y: Math.round(placePoint.y * 1000) }, "place-" + ++actionSeq);
  if (res && res.ok) {
    audio.cue("placeBall");
    placePoint = null;
    syncTable();
    announce(T("Cue ball placed."));
  }
}
export function doHint(): void { if (sess && !playback) sess.hint(); }
export function doUndo(): void { if (sess && !playback) sess.undo(); }
export function shootOrPlace(): void {
  const st = sess?.getState();
  if (st && st.ballInHand) tryPlace(); else tryShoot();
}
function aimBy(d: number): void {
  aim.milli = (((aim.milli + d) % 6284) + 6284) % 6284;
  syncTable();
}
function powerBy(d: number): void {
  aim.power = Math.max(0, Math.min(1000, aim.power + d));
  syncTable();
}
export function setPower(v: number): void { aim.power = Math.max(0, Math.min(1000, Math.round(v))); }
export function setSpin(top: number, side: number): void {
  aim.spinTop = Math.max(-100, Math.min(100, Math.round(top)));
  aim.spinSide = Math.max(-100, Math.min(100, Math.round(side)));
}
/** Aim from the cue ball toward a table point (the drag). */
function aimFromPoint(p: { x: number; y: number }): void {
  const cue = sess?.getState()?.balls[0];
  if (!cue) return;
  const dx = p.x - cue.x, dy = p.y - cue.y;
  if (dx * dx + dy * dy < 1e-6) return;
  aim.milli = Math.round(((Math.atan2(dy, dx) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) * 1000) % 6284;
  syncTable();
}
// The table drag: a press on the cloth aims from the cue ball toward it (or,
// with ball in hand, marks the placement spot), the drag follows, the release ticks.
let dragging = false;
let wasDown = false;
export function tablePointer(winX: number, winY: number, down: boolean, inside: boolean): void {
  const pressed = down && !wasDown;
  wasDown = down;
  if (pressed && inside && canAct()) {
    const p = render.tablePoint(winX, winY);
    if (!p) return;
    dragging = true;
    const st = sess!.getState();
    if (st.ballInHand) { placePoint = p; syncTable(); audio.cue("uiClick"); }
    else aimFromPoint(p);
    return;
  }
  if (dragging && down) {
    const p = render.tablePoint(winX, winY);
    if (!p || !sess) return;
    if (sess.getState().ballInHand) { placePoint = p; syncTable(); } else aimFromPoint(p);
  } else if (dragging && !down) {
    dragging = false;
    audio.cue("uiClick");
  }
}

// ------------------------------------------------------------------ pause
export function pauseGame(reason?: string): void {
  if (!sess || app.overlay) return;
  if (sess.pause(reason)) {
    app.overlay = "pause";
    opened();
    announce(T("Paused."));
  }
}
export function resumeGame(): void {
  if (!sess) return;
  if (sess.resume()) {
    app.overlay = null;
    ui.setFocus(null);
    syncTable();
    announce(T("Resumed."));
  }
}
export function pauseToSettings(): void {
  app.overlay = null;
  app.returnScreen = "game";
  showScreen("settings");
}

// ------------------------------------------------------------------ results
function recordResults(r: Result): void {
  const save = platform.save();
  const ls = sess?.getLesson();
  const newAch = Progress.record(save, r, ls && ls.done ? ls.lesson.id : null, new Date().toISOString());
  platform.persist();
  const jIdx = Content.JOURNEY.findIndex((j) => j.id === r.cfgId);
  app.results = { r, newAch, next: jIdx >= 0 && jIdx + 1 < Content.JOURNEY.length };
  app.lb = null;
  if (platform.signedIn() && lastMode && Progress.ranksOnBoard(lastMode.cfg)) {
    app.lb = "posting";
    const mine = app.results;
    void platform.postLeaderboard(r.score.total).then((res) => { if (app.results === mine) app.lb = res; });
  }
  platform.flush();
  if (playback) pendingResults = true;
  else openResults();
}
function openResults(): void {
  const R = app.results;
  if (!R) return;
  const { r, newAch } = R;
  app.overlay = "results";
  opened();
  if (newAch.length) {
    announce(T("Achievement unlocked: {name}", { name: newAch.map((k) => { const a = Content.ACHIEVEMENTS.find((x) => x.key === k); return a ? T(a.name) : k; }).join(", ") }));
    stepTimers.set(() => audio.cue("achievement"), 700); // after the win/lose motif
  }
  audio.cue(r.youWon ? "win" : "lose");
  announce(T("{headline} Score {score}, {stars} stars.", { headline: resultsHeadline(r), score: r.score.total, stars: r.stars }), true);
}
export function resultsHeadline(r: Result): string {
  return r.ruleset === "eightball"
    ? (r.youWon ? T("You win the match!") : T("The house wins."))
    : (r.youWon ? T("Table clear!") : terminalReasonText(r.terminal.reason));
}
export function retryGame(): void { app.overlay = null; restartGame(); }
export function nextStage(): void {
  app.overlay = null;
  const jIdx = Content.JOURNEY.findIndex((j) => j.id === lastMode?.cfg.id);
  if (jIdx >= 0 && jIdx + 1 < Content.JOURNEY.length) {
    quitToHome();
    openSetup(Content.JOURNEY[jIdx + 1]!, { kind: "journey" });
  }
}

// ------------------------------------------------------------------ texts
export function groupName(g: string | null): string {
  return g === "solid" || g === "solids" ? T("solids") : g === "stripe" || g === "stripes" ? T("stripes") : g ? T(g) : T("open");
}
export function terminalReasonText(reason: string): string {
  return T(({ "shot-limit": N("Out of shots."), "black-early": N("The black went down too soon."), "black-scratch": N("Foul on the black."), resigned: N("Resigned.") } as Record<string, string>)[reason] ?? N("Game over."));
}
export function objectiveText(state: State | null): string {
  if (!state) return "";
  if (state.terminal) {
    return state.terminal.reason === Rules.TERMINAL.CLEAR || state.terminal.reason === Rules.TERMINAL.EIGHT_DONE
      ? T("Table finished.") : terminalReasonText(state.terminal.reason);
  }
  if (state.ruleset === "eightball") {
    const me = state.players[0]!;
    if (state.openTable || !me.group) return T("Pot any ball except the 8 to claim a group.");
    if (Rules.pottedCount(state, me.group) === 7) return T("Your group is clear — pot the 8 to win.");
    return T("Pot your {group}, then the 8.", { group: groupName(me.group) });
  }
  const left = Rules.remainingTargets(state);
  if (state.blackLast && left === 1) return T("Pot the black to finish.");
  if (left === 1) return T("Pot the remaining ball.");
  return T(state.blackLast ? "Pot the remaining {n} balls — the black goes last." : "Pot the remaining {n} balls.", { n: left });
}
/** "Turn: …" or the house aiming; "Finished". */
export function turnText(state: State): string {
  if (aiAiming && sess && sess.isAITurn()) return T("House is aiming…");
  aiAiming = false;
  return state.terminal ? T("Finished") : T("Turn: {name}", { name: T(state.players[state.current]!.name) });
}
export function foulText(f: string): string {
  return T(({ "no-contact": N("cue ball hit nothing"), "wrong-first-contact": N("wrong ball first"),
    "no-rail-after-contact": N("no cushion after contact"), "cue-ball-potted": N("cue ball potted (scratch)") } as Record<string, string>)[f] ?? f);
}
export function invalidText(i: string): string {
  return T(({ "game-ended": N("the game is over"), "unknown-command": N("unknown command"),
    "malformed-command": N("malformed command"), "bad-angle": N("bad angle"), "bad-power": N("bad power"),
    "bad-spin": N("bad spin"), "not-ball-in-hand": N("no ball in hand right now"),
    "must-place-cue-first": N("place the cue ball first"), "place-blocked": N("that spot is blocked"),
    "out-of-bounds": N("outside the table"), resolving: N("shot still resolving"),
    "not-your-turn": N("wait for the house"), "duplicate-action": N("already committed"),
    paused: N("game is paused") } as Record<string, string>)[i] ?? i);
}
/** The screen-reader summary of the table (the browser build's #sr-table mirror). */
export function mirrorText(): string {
  const state = sess?.getState();
  if (!state) return T("No game in progress.");
  const parts = [objectiveText(state), T("Turn: {name}. Score {n}.", { name: T(state.players[state.current]!.name), n: state.score.total })];
  if (state.ruleset === "clearance") parts.push(T("{n} shots left.", { n: state.shotsLeft }));
  if (state.ballInHand) parts.push(T("Ball in hand: place the cue ball anywhere free."));
  const live = state.balls.filter((b) => !b.potted);
  parts.push(T("Balls on table: {list}.", { list: live.map((b) => {
    const zoneX = b.x < -0.37 ? N("left") : b.x > 0.37 ? N("right") : N("center");
    const zoneY = b.y < -0.19 ? N("bottom") : b.y > 0.19 ? N("top") : N("middle");
    return (b.n === 0 ? T("cue") : String(b.n)) + " (" + T(zoneY) + "-" + T(zoneX) + ")";
  }).join(", ") }));
  const t = Rules.legalTargets(state);
  if (t.length) parts.push(T("Legal targets: {list}.", { list: t.join(", ") }));
  return parts.join(" ");
}

// ------------------------------------------------------------------ actions
/** Labels of the widgets that keep the arrows (screens.ts sets them each frame). */
export const keepsArrows = { power: "", spin: "", table: "" };
const shift = (): boolean => isKeyDown("ShiftLeft") || isKeyDown("ShiftRight");
const REPEAT_DELAY = 24, REPEAT_EVERY = 2; // 0.4 s, then 30 a second
const held: Record<string, number> = {};
function arrowAction(action: string): boolean {
  const f = ui.focused();
  if (f && (f === keepsArrows.power || f === keepsArrows.spin)) return false;
  if (action === "aim_left") aimBy(shift() ? 1 : 8);
  else if (action === "aim_right") aimBy(shift() ? -1 : -8);
  else if (action === "power_up") powerBy(25);
  else if (action === "power_down") powerBy(-25);
  else return false;
  return true;
}
onAction((e) => {
  if (ui.capturingKeys()) return;
  if (e.action in AIM) { if (!e.pressed) delete held[e.action]; }
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  if (app.screen !== "game") {
    if (e.action === "back" && fresh && app.screen !== "home") goBack();
    return;
  }
  if (app.overlay === "pause") {
    if ((e.action === "back" || e.action === "pause") && fresh) resumeGame();
    return;
  }
  // the results card is modal: its buttons own the keyboard
  if (app.overlay === "results") return;
  if (e.action === "back" && app.drawer) { toggleDrawer(false); return; }
  if (!sess) return;
  const f = ui.focused();
  switch (e.action) {
    case "aim_left": case "aim_right": case "power_up": case "power_down":
      if (arrowAction(e.action)) { held[e.action] = 0; if (f && f !== keepsArrows.table) ui.setFocus(keepsArrows.table || null); }
      break;
    case "shoot":
      // focused buttons take their own Enter / Space / South (never a double commit)
      if (f && f !== keepsArrows.table) break;
      shootOrPlace();
      break;
    case "hint": doHint(); break;
    case "undo": doUndo(); break;
    case "skip": skipReplay(); break;
    case "pause": case "back": if (fresh) pauseGame(); break;
  }
});
const AIM: Record<string, true> = { aim_left: true, aim_right: true, power_up: true, power_down: true };
function repeatHeld(): void {
  for (const a of Object.keys(held)) {
    if (!isDown(a) || app.screen !== "game" || app.overlay) { delete held[a]; continue; }
    const n = ++held[a]!;
    if (n >= REPEAT_DELAY && (n - REPEAT_DELAY) % REPEAT_EVERY === 0) arrowAction(a);
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const key = `${f.quality}:${f.levelIndex}`;
  if (key === lookKey) return;
  lookKey = key;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyPrefs(): void {
  const p = preferences();
  applyContrast(p.highContrast);
  render.setHighContrast(p.highContrast);
  render.setReducedMotion(p.reducedMotion);
}

onStart(() => {
  setFixedRate(STEP_HZ);
  initStyles();
  platform.initPlatform();
  applyPrefs();
  audio.init();
  applyLook();
  render.setTheme(Content.themeById(settings.theme));
  showScreen("home");
});
onPreferencesChange(() => applyPrefs());
platform.onProgressMerged(() => undefined);
onSessionEnded(() => { toast(() => T("Signed out of StarHermit — progress stays on this device.")); });
onSuspend(() => {
  // Hiding the window pauses an active game.
  if (sess && sess.getPhase() === "active" && app.screen === "game") pauseGame("hidden");
  audio.setAmbience(false);
  platform.flush();
});
onResume(() => audio.setAmbience(true));
onQuit(() => platform.flush());

onFixedUpdate(() => {
  steps++;
  runTimers();
  stepPlayback();
  repeatHeld();
});
let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until > t);
});
onRender(() => {
  drawScreens();
  render.update(frameDt);
});
