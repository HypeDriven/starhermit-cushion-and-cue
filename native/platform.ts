// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (journey and challenge stars, lessons, achievements, career
//   pots, daily days, the last game) is the browser build's checksummed save
//   document (js/progress.js), unchanged: it is the game's save
//   (starhermit:storage `saves`) on the device and in the player's cloud
//   slot, two devices' copies merged on a conflict (the better stars, every
//   lesson / achievement / daily, the larger pot count, the later last
//   game). The slot the browser build wrote (the JS SDK's zipped save.json,
//   the same document) shows as foreign and is merged in and replaced once;
// - the game's own options (table theme, left-handed layout, the offline
//   player name) are `settings` (game.<key>, synced with the account); the
//   browser build's per-player settings are migrated (theme, left-handed),
//   then all its keys removed. Volumes, mute, graphics, language, reduced
//   motion, high contrast and text size are the runtime's Options;
// - the player (signed in or a guest), the invite link, the platform's
//   clock for the daily, and posting a finished table through
//   score-script.js (a practice session whose socket carries { type:
//   'result', scores }, as the JS SDK's submitScores did) with the rank on
//   the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Progress, type Save } from "./classic.ts";

// --- the save ------------------------------------------------------------------------
let doc: Save = Progress.blankSave();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** The progression save (mutate it, then persist()). */
export function save(): Save { return doc; }
/** Seals the save and writes it (device at once, the account debounced). */
export function persist(): void {
  Progress.seal(doc);
  try { saves.save(doc as unknown as JsonValue, { schema: 1 }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Merges another copy of the save into the live one (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const d = Progress.parseSave(other);
  if (!d) return false;
  const next = Progress.merge(d, doc);
  if (Progress.same(next, doc)) return false;
  doc = next;
  persist();
  return true;
}

saves.onConflict((local, remote) => ({
  merged: Progress.merge(Progress.parseSave(remote.data), Progress.parseSave(local?.data)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});

/** The browser build's cloud save: merged with this device's progress and saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let parsed: unknown = null;
  try { parsed = old.text ? JSON.parse(old.text) : null; } catch { parsed = null; }
  const remote = Progress.parseSave(parsed);
  const changed = !!remote && !Progress.same(Progress.merge(remote, doc), doc);
  if (remote) doc = Progress.merge(remote, doc);
  Progress.seal(doc);
  try { saves.save(doc as unknown as JsonValue, { schema: 1, replaceForeign: true }); }
  catch (e) { console.warn(`save migration: ${String(e)}`); }
  if (changed) merged();
}

/** For the home screen's account line: offline (a guest) | saving | synced | error. */
export function syncState(): "offline" | "saving" | "synced" | "error" {
  if (!player()) return "offline";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading" || st === "uploading" || st === "foreign" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options ---------------------------------------------------------------
export interface Settings { theme: string; leftHanded: boolean; name: string }
export const settings: Settings = { theme: "tournament", leftHanded: false, name: "Guest" };
type Key = keyof Settings;
function readSetting(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Progress.checkSetting(key, v);
  if (ok !== undefined) (settings as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptSetting(key: Key, value: unknown): void {
  const v = Progress.checkSetting(key, value);
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (settings as unknown as Record<string, unknown>)[key] = v;
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setSetting<K extends Key>(key: K, value: Settings[K]): void {
  if (settings[key] === value) return;
  settings[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`setting ${key}: ${String(e)}`); }
}
// The browser build's per-player settings (patchSettings and ui.language):
// the game's options among them carry over (unless this game set them
// since), then all are removed.
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const old: Record<string, unknown> = {};
  for (const key of keys) if (Progress.LEGACY_KEYS.includes(key)) old[key] = store.legacy(key);
  for (const [k, v] of Object.entries(Progress.gameSettingsFrom(old))) adoptSetting(k as Key, v);
  for (const key of keys) if (Progress.LEGACY_KEYS.includes(key)) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  doc = Progress.parseSave(cur?.data) ?? Progress.blankSave();
  for (const k of Object.keys(settings) as Key[]) readSetting(k);
  store.onChange((key) => { if (key in settings) readSetting(key as Key); });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ----------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = null;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the StarHermit high-score board ---------------------------------------------------
let board: Leaderboard | null = null;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}

/** Signed in only: post a finished table's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<{ posted: boolean; rank: number | null }> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.round(total);
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
