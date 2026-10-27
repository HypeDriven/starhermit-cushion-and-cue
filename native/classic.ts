// The browser build's pure game scripts, shared unchanged with the node tests
// and server.js: the seeded streams (js/rng.js), the deterministic rules and
// physics engine (js/rules.js), the content (js/content.js: balls, themes,
// the 36 journey stages, challenges, lessons, practice presets, the daily,
// achievements), the session controller (js/session.js: phases, AI pacing,
// undo, lessons, the replay envelope), the progression save (js/progress.js)
// and the string tables (js/locales/*.js, js/i18n.js), evaluated as classic
// scripts so their globals are this module's exports.
import { loadClassic } from "starhermit:script";

for (const f of [
  "js/rng.js", "js/rules.js", "js/content.js", "js/session.js", "js/progress.js",
  "js/locales/en-GB.js", "js/locales/es.js", "js/locales/de.js", "js/locales/fr.js", "js/locales/pt.js", "js/locales/it.js", "js/i18n.js",
]) loadClassic(f);

// -- The shapes this client reads -------------------------------------------------
export interface Ball { n: number; x: number; y: number; potted: boolean }
export interface Player { id: string; name: string; ai: boolean; skill: number | null; group: string | null; fouls: number; pots: number }
export interface State {
  version: number; seed: number; ruleset: "clearance" | "eightball"; blackLast: boolean; tick: number; turn: number;
  shotCount: number; current: number; players: Player[]; balls: Ball[]; ballInHand: boolean; openTable: boolean;
  shotsLeft: number; mechanics: { undo: boolean; hint: boolean };
  score: { pots: number; winBonus: number; shotBonus: number; foulPenalty: number; total: number };
  foulsLog: unknown[]; terminal: { reason: string; winner?: string | null } | null; contentVersion?: number;
}
export interface Cfg {
  id: string; name: string; version?: number; kind: string; seed: number; ruleset: string; layout?: string;
  ballNumbers?: number[]; blackLast?: boolean; shotLimit?: number; par?: { shots: number };
  players?: { id: string; name: string; ai?: boolean; skill?: number }[];
  mechanics?: { undo: boolean; hint: boolean }; theme?: string | null; intro?: string; blurb?: string;
  mastery?: boolean; date?: string; cueAt?: { x: number; y: number }; balls?: unknown[]; startInHand?: boolean;
}
export interface Lesson { id: string; title: string; steps: { text: string; require: string }[]; outro: string; [k: string]: unknown }
export interface Trace { dt: number; every: number; frames: (number | null)[][] }
export interface PhysEvent { type: "hit" | "cushion" | "pocket"; tick: number; speed?: number; pocket?: number }
export interface RulesEvent { type: string; foul?: string; reason?: string; [k: string]: unknown }
export interface Shot { angle: number; power: number; spinTop: number; spinSide: number }
export interface Result {
  cfgId: string; kind: string; ruleset: string; terminal: { reason: string; winner?: string | null }; winner: string | null; youWon: boolean;
  score: State["score"]; stars: number; shots: number; pots: number; fouls: number; elapsedTicks: number;
  replay: { seed: number; commands: unknown[]; terminal: { finalHash: number } | null };
}
export interface Applied { command: { type: string }; events: RulesEvent[]; physics: PhysEvent[]; trace: Trace | null; state: State; ai: boolean }
export interface Timers { set(fn: () => void, ms: number): number; clear(h: number): void }
export interface SessionApi {
  on(evt: string, fn: (d: never) => void): SessionApi;
  start(): State;
  command(cmd: Record<string, unknown>, actionId: string): { ok: boolean; invalid?: string; trace?: Trace | null } | null;
  ackResolved(): void;
  canUndo(): boolean; undo(): boolean;
  hint(): { shot?: Shot; place?: { x: number; y: number } } | null;
  pause(reason?: string): boolean; resume(): boolean;
  getState(): State; getPhase(): string; getResult(): Result | null;
  getLesson(): { lesson: Lesson; step: number; done: boolean } | null;
  isAITurn(): boolean;
}
export interface Save {
  version: number; journeyStars: Record<string, number>; lessonsDone: Record<string, boolean>; achievements: Record<string, boolean>;
  careerPots: number; dailyDays: string[]; lastSnapshot: { cfgId: string; total: number; stars: number; at: string } | null; checksum: string | number;
}
export interface Theme { id: string; name: string; unlockStars: number; palette: Record<"cloth" | "clothDark" | "cushion" | "wood" | "woodDark" | "wall" | "floor" | "light" | "accent" | "metal" | "fog", number> }

interface RulesApi {
  TABLE: { PLAY_W: number; PLAY_H: number; MIN_X: number; MAX_X: number; MIN_Y: number; MAX_Y: number; R: number; HEAD_X: number; FOOT_X: number; POCKETS: { x: number; y: number; cap: number; kind: string }[] };
  TERMINAL: Record<"EIGHT_DONE" | "EIGHT_EARLY" | "EIGHT_SCRATCH" | "CLEAR" | "SHOTS" | "BLACK_EARLY" | "BLACK_SCRATCH" | "RESIGN", string>;
  createGame(cfg: Cfg): State;
  legalTargets(s: State): number[];
  remainingTargets(s: State): number;
  pottedCount(s: State, group: string): number;
  aimPreview(s: State, angleMilli: number): { dist: number; x: number; y: number; ball: number | null } | null;
  hashState(s: unknown): number;
  clone<T>(v: T): T;
}
interface ContentApi {
  BALLS: Record<number, { label: string; color: number; colorHC: number }>;
  THEMES: Theme[]; JOURNEY: Cfg[]; CHALLENGES: Cfg[]; LESSONS: Lesson[];
  PRACTICE: { id: string; name: string; ruleset: string; nBalls?: number; shotLimit?: number }[];
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
  practiceConfig(id: string, seed: number): Cfg;
  dailyConfig(date: string): Cfg;
  themeById(id: string): Theme;
}
interface SessionModule { create(cfg: Cfg, opts: { lesson?: Lesson | null; ranked?: boolean; timers?: Timers }): SessionApi }
interface ProgressApi {
  LEGACY_KEYS: string[]; GAME_SETTINGS: Record<string, unknown>;
  blankSave(): Save; seal(d: Save): Save; parseSave(j: unknown): Save | null; merge(a: Save | null, b: Save | null): Save; same(a: Save, b: Save): boolean;
  journeyUnlocked(s: Save, i: number): boolean; playStageIndex(s: Save): number;
  summary(s: Save): { done: number; stars: number; pots: number };
  record(s: Save, r: Result, lessonId: string | null, nowIso: string): string[];
  ranksOnBoard(cfg: Cfg | null): boolean;
  checkSetting(key: string, v: unknown): unknown;
  gameSettingsFrom(obj: unknown): Record<string, unknown>;
}
interface RngApi {
  STREAM_DECOR: number; STREAM_AV: number;
  create(seed: number): { next(): number; int(n: number): number };
  derive(seed: number, stream: number): { next(): number; int(n: number): number };
}
interface I18nApi { T(key: string, vars?: Record<string, string | number> | null): string; setLocale(tag: string): string; readonly lang: string; LOCALES: string[] }

const g = globalThis as unknown as { CCRules: RulesApi; CCContent: ContentApi; CCSession: SessionModule; CCProgress: ProgressApi; CCRNG: RngApi; CQCI18n: I18nApi };
export const Rules = g.CCRules;
export const Content = g.CCContent;
export const Session = g.CCSession;
export const Progress = g.CCProgress;
export const RNG = g.CCRNG;
export const I18n = g.CQCI18n;
