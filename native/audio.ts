// Sound, as the browser build's js/audio.js played its authored clips: the
// 21 Opus clips of sfx/manifest.json, each game event (strike, ball click,
// cushion, pocket drop, foul, UI click, turn chime, hint ping, rack, place,
// groups, undo, achievement, win, lose) picking one of its variants from the
// seeded AV stream (reseeded with each game's seed, so a replayed session
// sounds the same), and the hall room tone looped under everything from the
// first sound on.
//
// The browser build's four buses become the runtime's (Options › Audio owns
// the volumes, the mute and the voice limit): its clips all went through the
// effects bus (80 %), so they play on "effects" at 0.8, the UI clicks on
// "interface", and the room tone at the ambience bus's 0.5 × 0.7. The
// WebAudio synthesis the browser build played while a clip loaded is not
// ported (a live synthesis graph makes clip loads fail on the engine's web
// runtime): a clip not loaded yet is silent. Every clip loads at once in
// onStart (the engine hands each loaded clip to the mixer, natively and on
// the web); the room tone starts once the mixer runs (in a browser, after
// the first press).
import { files } from "starhermit:engine";
import { context, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { RNG } from "./classic.ts";

export type Cue =
  | "strike" | "ballClick" | "cushion" | "pocketDrop" | "foul" | "uiClick" | "turnChime" | "cueBeep"
  | "win" | "lose" | "rack" | "placeBall" | "groups" | "undo" | "achievement";

const EFFECTS = 0.8;
const AMBIENCE = 0.5 * 0.7;
const byEvent = new Map<string, string[]>();
const clips = new Map<string, AudioClip>();
let started = false;
let avRng = RNG.derive(0xc0ffee, RNG.STREAM_AV);
let ambience: Sound | null = null;
let ambienceOn = false;

function readManifest(): void {
  try {
    const list = files.readJson("sfx/manifest.json") as { name?: string; event?: string }[];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item.name !== "string" || typeof item.event !== "string") continue;
      const names = byEvent.get(item.event) ?? [];
      names.push(item.name);
      byEvent.set(item.event, names);
    }
  } catch (e) { console.warn(`sfx manifest: ${String(e)}`); }
}
/** Reads the manifest and loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function init(): void {
  readManifest();
  for (const name of new Set([...byEvent.values()].flat())) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
}
/** A new game: the variant stream restarts from its seed (js/audio.js reseed). */
export function reseed(seed: number): void { avRng = RNG.derive(seed >>> 0, RNG.STREAM_AV); }

/** Plays one of the event's clips (once loaded). */
export function cue(event: Cue): void {
  const names = byEvent.get(event);
  if (!names || !names.length) return;
  const name = names[Math.floor(avRng.next() * names.length)]!;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: event === "uiClick" ? "interface" : "effects", gain: EFFECTS }); }
  catch { /* the mixer is full this frame: skip it */ }
}

/** The room tone: on from the first gesture (as the browser build's unlock), stopped while hidden. */
export function setAmbience(on: boolean): void { ambienceOn = on; }

/** Each frame: once the mixer runs, start and keep the room tone going. */
export function update(): void {
  if (context.state !== "running") return;
  if (!started) { started = true; ambienceOn = true; }
  const tone = (byEvent.get("ambience") ?? [])[0];
  const clip = tone ? clips.get(tone) : undefined;
  try {
    if (ambienceOn && clip && !ambience) ambience = playClip(clip, { bus: "effects", gain: AMBIENCE, loop: true });
    else if (!ambienceOn && ambience) { ambience.stop(); ambience = null; }
  } catch (e) { console.warn(`ambience: ${String(e)}`); ambience = null; }
}
