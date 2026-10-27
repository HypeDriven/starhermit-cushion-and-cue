// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the burst sparks and dust motes scaled within the tier by the level
// (frame().levelIndex), as the browser build scaled them by its hardware
// level (at most 4×, never below the tier's floor). The runtime owns the
// rest of the old Graphics panel: Auto and the level choice, render scale
// and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout, and the shadow-map size and MSAA samples it holds to the level.
// The panel's per-category overrides are not offered (Options choose a
// level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export type Preset = QualityTier;
export interface Budget {
  /** Room, cloth, rails, wood, pockets, balls and cue: Lambert, standard PBR or physical (sheen, clear-coat). */
  material: "lambert" | "standard" | "physical";
  /** Sphere width segments of every ball (Plain detail keeps at most 24). */
  ballSegs: number;
  /** Ball skin canvas width in px (half as tall). */
  ballTex: number;
  /** Rails, wood surround and pockets merged into one mesh each. */
  mergeTable: boolean;
  /** Pooled burst sparks (one instanced draw). */
  burst: number;
  /** Dust motes over the rails (Particles high; low tier ≤ 20). */
  motes: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: Preset;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting (ball, rail and sight reflections). */
  reflections: boolean;
  /** Felt sheen, wood grain, sights, leather lips, plank floor, rug, contact shadows, the spot pool. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  budget: Budget;
}

const TABLE: Record<Preset, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, detailed: false, particles: "off" },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low" },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high" },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high" },
};
const BUDGETS: Record<Preset, Budget> = {
  low: { material: "lambert", ballSegs: 16, ballTex: 256, mergeTable: true, burst: 16, motes: 12, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", ballSegs: 24, ballTex: 512, mergeTable: true, burst: 24, motes: 20, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", ballSegs: 40, ballTex: 512, mergeTable: false, burst: 48, motes: 48, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", ballSegs: 56, ballTex: 1024, mergeTable: false, burst: 64, motes: 72, bloomRes: 1, aoRes: 1 },
};
export const BURST_MAX = 256;
export const MOTE_MAX = 288;
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<Preset, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: Preset, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: sparks and motes grow
  // with the level above the tier's first, at most 4× the tier's budget.
  const k = Math.min(4, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.burst = Math.min(BURST_MAX, Math.round(b.burst * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
