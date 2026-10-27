/* Cushion & Cue — localization core (classic script → CQCI18n; Node).
 *
 * Every player-facing string is authored in US English and looked up by that
 * English text: T('Play') → the current locale's translation (en-US is the key
 * itself). Placeholders use {name}. Dictionaries come from js/locales/*.js
 * (loaded first, into the global CC_LOCALES); en-GB, es-ES and fr-CA list only
 * their differences from en-US, es-419 and fr-FR.
 *
 * On the StarHermit engine the locale is the runtime's interface language
 * (native/i18n.ts calls setLocale with preferences().language: the player's
 * choice in Options › Language, else the account's preferred language or the
 * device's); the screens are drawn every frame, so a change shows at once.
 */
(function (root) {
  'use strict';
  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var src = root.CC_LOCALES || {};
  function merge(a, b) { var o = {}, k; for (k in a || {}) o[k] = a[k]; for (k in b || {}) o[k] = b[k]; return o; }
  var DICTS = {
    'en-US': {},
    'en-GB': src['en-GB'] || {},
    'es-419': src['es-419'] || {},
    'es-ES': merge(src['es-419'], src['es-ES']),
    'de-DE': src['de-DE'] || {},
    'fr-FR': src['fr-FR'] || {},
    'fr-CA': merge(src['fr-FR'], src['fr-CA']),
    'pt-BR': src['pt-BR'] || {},
    'it-IT': src['it-IT'] || {}
  };
  var lang = 'en-US', dict = DICTS[lang];

  function fmt(s, vars) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; });
  }
  function T(key, vars) {
    if (key == null) return '';
    var s = String(key);
    var out = Object.prototype.hasOwnProperty.call(dict, s) ? dict[s] : s;
    return vars ? fmt(out, vars) : out;
  }
  function N(key) { return key; }

  /** Switches to a shipped locale (anything else falls back to en-US); the locale in use. */
  function setLocale(next) {
    lang = DICTS[next] ? next : 'en-US';
    dict = DICTS[lang];
    return lang;
  }

  var api = {
    LOCALES: LOCALES, DICTS: DICTS, T: T, N: N, fmt: fmt,
    get lang() { return lang; },
    setLocale: setLocale
  };
  root.CQCI18n = api;
})(typeof self !== 'undefined' ? self : this);
