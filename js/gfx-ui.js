/* Cushion & Cue — Graphics section of the Settings screen (ES module).
 * Quality preset (Auto + four presets), render scale, one override per
 * CCGfx category, adaptive resolution, frame-rate readout and a summary line
 * "GPU · cost · W×H px". Its strings are localized from navigator.language
 * (the rest of the game is English only). Controls carry stable ids:
 * #set-quality, #gfx-scale, #gfx-<category>, #gfx-adaptive, #gfx-fps,
 * #gfx-summary, #gfx-note.
 */
import { gpuName } from './render.js';

const Gfx = window.CCGfx;

// ---------------------------------------------------------------- strings --
const EN = {
  legend: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  scale: 'Render scale', fromPreset: 'From preset ({tier})',
  cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Table detail', particles: 'Particles' },
  tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA',
    msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed' },
  adaptive: 'Adaptive resolution', fps: 'Show frame rate',
  noShadows: 'no shadows', noAA: 'no anti-aliasing', unknownGpu: 'unknown GPU',
  postFailed: 'Post-processing is unavailable on this device, so the table is drawn without it.'
};
const STRINGS = {
  'en-US': EN,
  'en-GB': Object.assign({}, EN, { cats: Object.assign({}, EN.cats, { grade: 'Colour grade' }) }),
  'es-419': {
    legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    scale: 'Escala de renderizado', fromPreset: 'Del ajuste ({tier})',
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
      antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de la mesa', particles: 'Partículas' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Simple', detailed: 'Detallado' },
    adaptive: 'Resolución adaptativa', fps: 'Mostrar cuadros por segundo',
    noShadows: 'sin sombras', noAA: 'sin antialiasing', unknownGpu: 'GPU desconocida',
    postFailed: 'El posprocesado no está disponible en este dispositivo; la mesa se dibuja sin él.'
  },
  'es-ES': {
    legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    scale: 'Escala de renderizado', fromPreset: 'Del ajuste ({tier})',
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Etalonaje de color',
      antialias: 'Suavizado de bordes', reflections: 'Reflejos', detail: 'Detalle de la mesa', particles: 'Partículas' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Simple', detailed: 'Detallado' },
    adaptive: 'Resolución adaptativa', fps: 'Mostrar fotogramas por segundo',
    noShadows: 'sin sombras', noAA: 'sin suavizado', unknownGpu: 'GPU desconocida',
    postFailed: 'El posprocesado no está disponible en este dispositivo; la mesa se dibuja sin él.'
  },
  'de-DE': {
    legend: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    scale: 'Renderskalierung', fromPreset: 'Voreinstellung ({tier})',
    cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Tischdetails', particles: 'Partikel' },
    tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Einfach', detailed: 'Detailliert' },
    adaptive: 'Adaptive Auflösung', fps: 'Bildrate anzeigen',
    noShadows: 'keine Schatten', noAA: 'keine Kantenglättung', unknownGpu: 'unbekannte GPU',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; der Tisch wird ohne sie dargestellt.'
  },
  'fr-FR': {
    legend: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    scale: 'Échelle de rendu', fromPreset: 'Préréglage ({tier})',
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
      antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détails de la table', particles: 'Particules' },
    tiers: { off: 'Non', on: 'Oui', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé' },
    adaptive: 'Résolution adaptative', fps: 'Afficher les images par seconde',
    noShadows: 'sans ombres', noAA: 'sans anticrénelage', unknownGpu: 'GPU inconnu',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; la table est affichée sans.'
  },
  'fr-CA': {
    legend: 'Graphiques', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    scale: 'Échelle de rendu', fromPreset: 'Préréglage ({tier})',
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Correction des couleurs',
      antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détails de la table', particles: 'Particules' },
    tiers: { off: 'Non', on: 'Oui', low: 'Bas', medium: 'Moyen', high: 'Élevé', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé' },
    adaptive: 'Résolution adaptative', fps: 'Afficher la fréquence d’images',
    noShadows: 'sans ombres', noAA: 'sans anticrénelage', unknownGpu: 'GPU inconnu',
    postFailed: 'Le post-traitement n’est pas offert sur cet appareil; la table est affichée sans.'
  },
  'pt-BR': {
    legend: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    scale: 'Escala de renderização', fromPreset: 'Predefinição ({tier})',
    cats: { shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor',
      antialias: 'Antisserrilhado', reflections: 'Reflexos', detail: 'Detalhe da mesa', particles: 'Partículas' },
    tiers: { off: 'Não', on: 'Sim', low: 'Baixo', medium: 'Médio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado' },
    adaptive: 'Resolução adaptativa', fps: 'Mostrar taxa de quadros',
    noShadows: 'sem sombras', noAA: 'sem antisserrilhado', unknownGpu: 'GPU desconhecida',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; a mesa é desenhada sem ele.'
  },
  'it-IT': {
    legend: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    scale: 'Scala di rendering', fromPreset: 'Preimpostazione ({tier})',
    cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
      antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio del tavolo', particles: 'Particelle' },
    tiers: { off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato' },
    adaptive: 'Risoluzione adattiva', fps: 'Mostra frequenza fotogrammi',
    noShadows: 'senza ombre', noAA: 'senza antialiasing', unknownGpu: 'GPU sconosciuta',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il tavolo viene disegnato senza.'
  }
};
export const LOCALES = Object.keys(STRINGS);

export function pickLocale(langs) {
  const list = (langs && langs.length ? langs : ['en-US']).map(String);
  for (const l of list) {
    const hit = LOCALES.find(k => k.toLowerCase() === l.toLowerCase());
    if (hit) return hit;
  }
  for (const l of list) {
    const lang = l.toLowerCase();
    if (/^es-(es)$/.test(lang)) return 'es-ES';
    if (lang.startsWith('es')) return 'es-419';
    if (lang.startsWith('en')) return /^en-(gb|ie|au|nz|za|in)/.test(lang) ? 'en-GB' : 'en-US';
    if (lang === 'fr-ca') return 'fr-CA';
    if (lang.startsWith('fr')) return 'fr-FR';
    if (lang.startsWith('pt')) return 'pt-BR';
    if (lang.startsWith('de')) return 'de-DE';
    if (lang.startsWith('it')) return 'it-IT';
  }
  return 'en-US';
}
export function strings(locale) { return STRINGS[locale] || EN; }

// ---------------------------------------------------------------- GPU ------
let probed = null;
/** GPU name + Auto preset, probed once with a throwaway context. */
export function probeGpu() {
  if (probed) return probed;
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      gpu = gpuName(gl);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch (e) { /* no WebGL: the 2D table ignores graphics settings */ }
  const mobile = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
    /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
  probed = { gpu, detected: Gfx.detectPreset(gpu, mobile) };
  return probed;
}

// ---------------------------------------------------------------- panel ----
/**
 * mountGraphicsPanel({ getSaved, setSaved, getRenderer })
 *  getSaved(): { preset, render_scale, adaptive, show_fps, <cat> }
 *  setSaved(obj): persist + apply (the caller forwards to the renderer)
 */
export function mountGraphicsPanel(opts) {
  const locale = pickLocale(navigator.languages || [navigator.language]);
  const t = strings(locale);
  const fs = document.getElementById('set-graphics');
  const body = document.getElementById('gfx-body');
  fs.setAttribute('lang', locale);
  document.getElementById('gfx-legend').textContent = t.legend;
  const { gpu, detected } = probeGpu();
  const tierName = v => t.tiers[v] || v;

  const row = (labelText, control, extraClass) => {
    const l = document.createElement('label');
    if (extraClass) l.className = extraClass;
    const span = document.createElement('span');
    span.textContent = labelText;
    l.append(span, control);
    return { label: l, span };
  };

  // Quality (static select from index.html, relabelled here)
  const qSel = document.getElementById('set-quality');
  document.getElementById('gfx-quality-label').textContent = t.quality;

  // Render scale
  const scale = document.createElement('input');
  Object.assign(scale, { type: 'range', id: 'gfx-scale', min: 50, max: 200, step: 5 });
  const scaleOut = document.createElement('output');
  scaleOut.id = 'gfx-scale-value';
  scaleOut.htmlFor = 'gfx-scale';
  const scaleWrap = document.createElement('span');
  scaleWrap.className = 'gfx-scale';
  scaleWrap.append(scale, scaleOut);
  body.appendChild(row(t.scale, scaleWrap).label);

  // Category overrides
  const catSel = {};
  for (const cat of Object.keys(Gfx.CATEGORIES)) {
    const sel = document.createElement('select');
    sel.id = 'gfx-' + cat;
    sel.dataset.gfxCat = cat;
    const def = document.createElement('option');
    def.value = 'preset';
    sel.appendChild(def);
    for (const tier of Gfx.CATEGORIES[cat]) {
      const o = document.createElement('option');
      o.value = tier; o.textContent = tierName(tier);
      sel.appendChild(o);
    }
    catSel[cat] = sel;
    body.appendChild(row(t.cats[cat], sel).label);
  }

  const check = (id, text) => {
    const box = document.createElement('input');
    box.type = 'checkbox'; box.id = id;
    const l = document.createElement('label');
    l.className = 'check';
    l.append(box, document.createTextNode(' ' + text));
    body.appendChild(l);
    return box;
  };
  const adaptive = check('gfx-adaptive', t.adaptive);
  const fps = check('gfx-fps', t.fps);

  const summary = document.createElement('p');
  summary.id = 'gfx-summary';
  summary.className = 'muted gfx-summary';
  summary.setAttribute('aria-live', 'polite');
  const note = document.createElement('p');
  note.id = 'gfx-note';
  note.className = 'gfx-note';
  note.textContent = t.postFailed;
  note.hidden = true;
  body.append(summary, note);

  function describe(r, pixels) {
    const parts = [
      r.shadows === 'off' ? t.noShadows : `${t.cats.shadows} ${Gfx.SHADOW_MAP[r.shadows]}²`,
      r.ao !== 'off' ? t.cats.ao : null,
      r.bloom === 'on' ? t.cats.bloom : null,
      r.reflections === 'on' ? t.cats.reflections : null,
      r.antialias === 'off' ? t.noAA : r.antialias.toUpperCase(),
      pixels && pixels[0] ? `${pixels[0]}×${pixels[1]} px` : null
    ];
    return parts.filter(Boolean).join(' · ');
  }

  function refresh() {
    const saved = opts.getSaved();
    const r = Gfx.resolve(saved, detected);
    // Quality labels (Auto shows the detected tier)
    for (const o of qSel.options) {
      o.textContent = o.value === 'auto' ? t.auto.replace('{tier}', t.presets[detected]) : t.presets[o.value];
    }
    qSel.value = r.auto ? 'auto' : r.preset;
    for (const cat in catSel) {
      const sel = catSel[cat];
      sel.options[0].textContent = t.fromPreset.replace('{tier}', tierName(Gfx.presetTier(r.preset, cat)));
      sel.value = Gfx.CATEGORIES[cat].includes(saved[cat]) ? saved[cat] : 'preset';
    }
    scale.value = Math.round(r.renderScale * 100);
    scaleOut.textContent = scale.value + '%';
    adaptive.checked = r.adaptive;
    fps.checked = r.showFps;
    const rend = opts.getRenderer();
    const info = rend && rend.graphicsInfo ? rend.graphicsInfo() : null;
    const gpuText = (info && info.gpu !== 'unknown GPU' ? info.gpu : gpu) || t.unknownGpu;
    summary.textContent = `${gpuText} · ${describe(r, info && info.pixels)}`;
    note.hidden = !(info && info.postFailed);
    document.body.dataset.gfxPreset = r.preset;
  }

  function update(mutate) {
    const saved = Object.assign({}, opts.getSaved());
    const next = mutate(saved) || saved;
    opts.setSaved(next);
    refresh();
  }

  qSel.addEventListener('change', () => update(s => Gfx.choosePreset(s, qSel.value)));
  scale.addEventListener('input', () => { scaleOut.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => update(s => { s.render_scale = Number(scale.value) / 100; }));
  for (const cat in catSel) {
    catSel[cat].addEventListener('change', () => update(s => {
      if (catSel[cat].value === 'preset') delete s[cat]; else s[cat] = catSel[cat].value;
    }));
  }
  adaptive.addEventListener('change', () => update(s => { s.adaptive = adaptive.checked; }));
  fps.addEventListener('change', () => update(s => { s.show_fps = fps.checked; }));

  refresh();
  return { refresh, detected, gpu };
}
