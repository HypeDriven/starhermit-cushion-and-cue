/* Cushion & Cue — graphics quality model (pure, no three.js).
 * UMD: window.CCGfx in the browser, require() in Node tests.
 * Presets, per-category overrides, GPU detection and a cost summary, so the
 * settings panel and the renderer agree on what each setting means.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CCGfx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PRESETS = ['low', 'balanced', 'high', 'ultra'];

  // Category -> allowed tiers, cheapest first.
  var CATEGORIES = {
    shadows: ['off', 'low', 'medium', 'high'],
    ao: ['off', 'on', 'high'],
    bloom: ['off', 'on'],
    grade: ['off', 'on'],
    antialias: ['off', 'fxaa', 'smaa', 'msaa'],
    reflections: ['off', 'on'],
    detail: ['plain', 'detailed'],
    particles: ['off', 'low', 'high']
  };

  // Each preset: a tier per category, a render scale (multiplies the device
  // pixel ratio) and a device-pixel-ratio cap so Low stays as cheap as before.
  var TABLE = {
    low: { scale: 1, cap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off',
      reflections: 'off', detail: 'plain', particles: 'off' },
    balanced: { scale: 0.9, cap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa',
      reflections: 'on', detail: 'detailed', particles: 'low' },
    high: { scale: 1, cap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa',
      reflections: 'on', detail: 'detailed', particles: 'high' },
    ultra: { scale: 1.25, cap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa',
      reflections: 'on', detail: 'detailed', particles: 'high' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // Auto picks the preset from the StarHermit hardware level (gpu-level.js → StarHermitGpu, loaded first):
  // 0 = Galaxy S20 / Intel UHD or weaker and every software renderer, 20 = RTX 5090, each level ≈ 1.23×.
  // Low from 0, Balanced from 4, High from 10, Ultra from 17; phones, tablets and ≤ 4 GB machines are
  // capped at level 9 (Balanced) by the shared module.
  var PRESET_LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
  function gpuApi() { return globalThis.StarHermitGpu; }

  /** Hardware level (0–20) for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
  function detectLevel(gpu, system) {
    var G = gpuApi();
    if (!G) return PRESET_LEVELS.balanced;
    return G.detectLevel(Object.assign({ webgl: true, webgl2: true }, system || {}, { gpu: String(gpu || '') }));
  }

  /** The preset Auto starts from for a hardware level. */
  function presetForLevel(level) {
    var G = gpuApi();
    if (G) return G.presetForLevel(level, PRESET_LEVELS);
    return level >= 17 ? 'ultra' : level >= 10 ? 'high' : level >= 4 ? 'balanced' : 'low';
  }

  /** Best preset for this GPU (the level already caps phones and tablets at Balanced). */
  function detectPreset(gpu, system) {
    return presetForLevel(detectLevel(gpu, system));
  }

  /*
   * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it
   * (Low → level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Counts are
   * tuned at the floor level and scale up within the preset on faster GPUs (StarHermitGpu.scaleBudget, ≤ 4×).
   *   material   'lambert' | 'standard' | 'physical' (room, cloth, rails, wood, balls; clearcoat/sheen when detailed);
   *   ballSegs   sphere width segments of every ball (height = ¾);
   *   ballTex    ball skin texture width in px (height is half);
   *   mergeTable rails, wood surround and pockets merged into one mesh each (fewer draw calls);
   *   burst      pooled burst sparks (one instanced draw); motes  dust motes in the lamp light;
   *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame.
   */
  var BUDGETS = {
    low:      { material: 'lambert',  ballSegs: 16, ballTex: 256,  mergeTable: true,  burst: 16, motes: 12, bloomRes: 0.5, aoRes: 0.5 },
    balanced: { material: 'standard', ballSegs: 24, ballTex: 512,  mergeTable: true,  burst: 24, motes: 20, bloomRes: 0.5, aoRes: 0.5 },
    high:     { material: 'physical', ballSegs: 40, ballTex: 512,  mergeTable: false, burst: 48, motes: 48, bloomRes: 0.5, aoRes: 0.5 },
    ultra:    { material: 'physical', ballSegs: 56, ballTex: 1024, mergeTable: false, burst: 64, motes: 72, bloomRes: 1, aoRes: 1 }
  };
  var SCALED = ['burst', 'motes'];

  /** A preset's concrete budget for a hardware level (counts scale up within the preset, never down). */
  function budgetFor(preset, level) {
    var b = Object.assign({}, BUDGETS[preset] || BUDGETS.balanced);
    var floor = PRESET_LEVELS[preset] || 0, G = gpuApi();
    SCALED.forEach(function (k) {
      b[k] = Math.round(G ? G.scaleBudget(b[k], Math.max(Number(level) || 0, floor), floor) : b[k]);
    });
    return b;
  }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier|'preset' }
   */
  function resolve(saved, detected, level) {
    var s = saved || {};
    var auto = PRESETS.indexOf(s.preset) < 0;
    var preset = auto ? (PRESETS.indexOf(detected) >= 0 ? detected : 'balanced') : s.preset;
    var row = TABLE[preset];
    var out = {
      preset: preset, auto: auto, cap: row.cap,
      renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2)
    };
    out.scale = row.scale * out.renderScale;
    for (var cat in CATEGORIES) {
      out[cat] = CATEGORIES[cat].indexOf(s[cat]) >= 0 ? s[cat] : row[cat];
    }
    out.budget = budgetFor(preset, level);
    out.adaptive = s.adaptive !== false;
    out.showFps = !!s.show_fps;
    // The composer runs only when something needs it; otherwise canvas MSAA/none.
    out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
      out.antialias === 'fxaa' || out.antialias === 'smaa';
    return out;
  }

  /** Choosing a preset clears every override (scale/adaptive/fps are kept). */
  function choosePreset(saved, preset) {
    var s = saved || {};
    var out = { preset: preset === 'auto' || PRESETS.indexOf(preset) >= 0 ? preset : 'auto' };
    if (s.render_scale != null) out.render_scale = s.render_scale;
    if (s.adaptive != null) out.adaptive = s.adaptive;
    if (s.show_fps != null) out.show_fps = s.show_fps;
    return out;
  }

  /** The preset's own tier for a category (for "From preset (...)" labels). */
  function presetTier(preset, cat) {
    return TABLE[preset] ? TABLE[preset][cat] : undefined;
  }

  function describe(r, pixels) {
    var parts = [
      r.shadows === 'off' ? 'no shadows' : SHADOW_MAP[r.shadows] + '² shadows',
      r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
      r.bloom === 'on' ? 'bloom' : null,
      r.reflections === 'on' ? 'reflections' : null,
      r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
      pixels ? pixels[0] + '×' + pixels[1] + ' px' : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  return {
    PRESETS: PRESETS, CATEGORIES: CATEGORIES, SHADOW_MAP: SHADOW_MAP,
    PRESET_LEVELS: PRESET_LEVELS, BUDGETS: BUDGETS, detectLevel: detectLevel, presetForLevel: presetForLevel, budgetFor: budgetFor,
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe
  };
});
