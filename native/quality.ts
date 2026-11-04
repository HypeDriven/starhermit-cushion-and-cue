// The look per graphics level. The engine-owned effects come from the
// frame's level (levelSettings()): shadows on/off and the key light's map
// size (the game sets it; since minor 23 the runtime keeps a game's
// mapSize), ambient occlusion (resolution and samples), bloom resolution,
// the grade, anti-aliasing, the texture-size cap and anisotropy. The game's
// own art comes from the browser build's four presets and budgets (js/gfx.js
// TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU its Auto gave
// it), keyed by the runtime's quality tier (frame().quality); the burst
// sparks and dust motes scale with the level's particle budget over the
// tier's anchor level (at most 4× the tier's budget). The runtime owns the
// rest of the old Graphics panel: Auto and the level choice, render scale
// and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout, and the MSAA samples. The panel's per-category overrides are not
// offered (Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Room, cloth, rails, wood, pockets, balls and cue: Lambert, standard PBR or physical (sheen, clear-coat). */
  material: "lambert" | "standard" | "physical";
  /** Sphere width segments of every ball (Plain detail keeps at most 24). */
  ballSegs: number;
  /** Ball skin canvas width in px (half as tall), at most the level's texture size. */
  ballTex: number;
  /** Rails, wood surround and pockets merged into one mesh each. */
  mergeTable: boolean;
  /** Pooled burst sparks (one instanced draw). */
  burst: number;
  /** Dust motes over the rails (Particles high; low tier ≤ 20). */
  motes: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  /** The level's ambient occlusion (null = off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** The level's anisotropic filtering for the cloth and ball skins. */
  anisotropy: number;
  /** Image-based lighting (ball, rail and sight reflections). */
  reflections: boolean;
  /** Felt sheen, wood grain, sights, leather lips, plank floor, rug, contact shadows, the spot pool. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles">;
const ART: Record<Preset, Art> = {
  low: { reflections: false, detailed: false, particles: "off" },
  balanced: { reflections: true, detailed: true, particles: "low" },
  high: { reflections: true, detailed: true, particles: "high" },
  ultra: { reflections: true, detailed: true, particles: "high" },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", ballSegs: 16, ballTex: 256, mergeTable: true, burst: 16, motes: 12 },
  balanced: { material: "standard", ballSegs: 24, ballTex: 512, mergeTable: true, burst: 24, motes: 20 },
  high: { material: "physical", ballSegs: 40, ballTex: 512, mergeTable: false, burst: 48, motes: 48 },
  ultra: { material: "physical", ballSegs: 56, ballTex: 1024, mergeTable: false, burst: 64, motes: 72 },
};
export const BURST_MAX = 256;
export const MOTE_MAX = 288;
/** Each tier's first level: its budgets are tuned there. */
const ANCHOR: Record<Preset, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings (the frame's level by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // The level's particle budget over the tier's anchor: sparks and motes
  // grow with the level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.burst = Math.min(BURST_MAX, Math.round(b.burst * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.ballTex = Math.min(b.ballTex, s.maxTextureSize);
  return {
    preset, ...ART[preset], budget: b,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    anisotropy: s.anisotropy,
  };
}
