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
    balanced: { scale: 1, cap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa',
      reflections: 'on', detail: 'detailed', particles: 'low' },
    high: { scale: 1, cap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa',
      reflections: 'on', detail: 'detailed', particles: 'high' },
    ultra: { scale: 1.25, cap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa',
      reflections: 'on', detail: 'detailed', particles: 'high' }
  };

  var SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /** Best preset for a GPU, from the unmasked renderer string when exposed. */
  function detectPreset(gpu, mobile) {
    var g = String(gpu || '').toLowerCase();
    var p = 'balanced';
    if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
    else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
    // Touch / mobile devices: Auto never goes above Balanced.
    if (mobile && (p === 'high' || p === 'ultra')) p = 'balanced';
    return p;
  }

  /**
   * Resolve saved settings into concrete tiers.
   * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier|'preset' }
   */
  function resolve(saved, detected) {
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
    detectPreset: detectPreset, resolve: resolve, choosePreset: choosePreset,
    presetTier: presetTier, describe: describe
  };
});
