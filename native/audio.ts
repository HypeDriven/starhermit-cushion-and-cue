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
// runtime): a clip not loaded yet is silent. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
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
const queue: string[] = [];
let loading = false;
let wanted = false;
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
function load(name: string): void { if (!queue.includes(name) && !clips.has(name)) queue.push(name); }
function pump(): void {
  if (loading || !queue.length) return;
  const name = queue.shift()!;
  loading = true;
  loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
}

/** Asks for the clips (the room tone first); they load once the mixer runs. */
export function init(): void {
  readManifest();
  wanted = true;
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
  catch { clips.delete(name); load(name); } // a clip the mixer lost: load it again
}

/** The room tone: on from the first gesture (as the browser build's unlock), stopped while hidden. */
export function setAmbience(on: boolean): void { ambienceOn = on; }

/** Each frame: queue the clips once the mixer runs (one load at a time), keep the room tone going. */
export function update(): void {
  if (context.state !== "running") return;
  if (wanted) {
    wanted = false;
    for (const n of byEvent.get("ambience") ?? []) load(n);
    for (const [ev, names] of byEvent) if (ev !== "ambience") for (const n of names) load(n);
    ambienceOn = true;
  }
  pump();
  const tone = (byEvent.get("ambience") ?? [])[0];
  const clip = tone ? clips.get(tone) : undefined;
  try {
    if (ambienceOn && clip && !ambience) ambience = playClip(clip, { bus: "effects", gain: AMBIENCE, loop: true });
    else if (!ambienceOn && ambience) { ambience.stop(); ambience = null; }
  } catch (e) { console.warn(`ambience: ${String(e)}`); ambience = null; }
}
