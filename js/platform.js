/* Cushion & Cue — StarHermit platform adapter (browser global: window.CQCPlatform).
 * A thin layer over window.StarHermit (starhermit-sdk.js, loaded first): the
 * SDK reads the launch token, renews it and talks to the API; this adapter
 * keeps the game's own API — profile nickname, the cloud-save mirror of the
 * checksummed save doc (remote wins on boot; debounced saves with a pagehide
 * flush; sync status), the settings KV, sign-in, invite link and key
 * bindings. Offline play is unchanged: no token → localStorage only and zero
 * /api calls.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CQCPlatform = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var SAVE_DEBOUNCE_MS = 2000;
  var SH = null;
  var hosted = false;
  var profile = null;          // { name } for the signed-in player
  var sync = 'offline';        // offline | saving | synced (cloud mirror)
  var syncListeners = [], authListeners = [];
  var started = false;

  function sdk() { return SH || (SH = root.StarHermit || null); }

  function setSync(state) {
    if (sync === state) return;
    sync = state;
    for (var i = 0; i < syncListeners.length; i++) {
      try { syncListeners[i](state); } catch (e) { /* listener errors never break */ }
    }
  }

  function headers(extra) {
    var h = extra || {};
    var s = sdk();
    if (s && s.token) h.Authorization = 'Bearer ' + s.token;
    return h;
  }

  // Nickname via GET /api/v1/users/{id}/profile (SDK: nickname, then
  // "Player <id>" fallback). Never /api/v1/me.
  function profileFor(pid) {
    var s = sdk();
    if (!s || !hosted || !pid) return Promise.resolve('player');
    return s.profile(pid).then(function (p) { return p ? p.displayName : 'Player ' + String(pid).slice(0, 6); });
  }
  function fetchProfile() {
    var s = sdk();
    if (!s || !hosted) return Promise.resolve(null);
    return profileFor(s.userId).then(function (n) {
      profile = { name: String(n).slice(0, 40) };
      return profile;
    });
  }

  /* Cloud save: the SDK's zip slot at /api/v1/me/cloud-saves/game:<slug>
   * holds the wrapped {sum,payload} doc. Remote wins on boot (validated
   * through parseSave in js/ui.js); localStorage stays the offline cache. */
  function loadCloud() {
    var s = sdk();
    if (!s || !hosted) return Promise.resolve(null);
    return s.loadJSON().then(function (obj) { if (sync === 'offline') setSync('synced'); return obj ? JSON.stringify(obj) : null; }, function () { return null; });
  }
  function onSave(docJson) {
    var s = sdk();
    if (!s || !hosted) return;
    try { s.saveJSON(JSON.parse(docJson), SAVE_DEBOUNCE_MS); } catch (e) { return; }
    setSync('saving');
  }
  function flushSave(keepalive) {
    var s = sdk();
    if (!s || !hosted) return Promise.resolve(false);
    return s.flushSave(keepalive === true);
  }

  // ---- settings KV (player preferences) ----
  function getSettings() {
    var s = sdk();
    return s && hosted ? s.getSettings().catch(function () { return {}; }) : Promise.resolve({});
  }
  var patchPending = null, patchTimer = null, patchWaiters = [];
  function patchSettings(obj) {
    var s = sdk();
    if (!s || !hosted) return Promise.resolve(null);
    patchPending = Object.assign(patchPending || {}, obj);
    if (patchTimer) clearTimeout(patchTimer);
    return new Promise(function (resolve) {
      patchWaiters.push(resolve);
      patchTimer = setTimeout(function () {
        var body = patchPending, waiters = patchWaiters;
        patchPending = null; patchTimer = null; patchWaiters = [];
        var done = function (v) { waiters.forEach(function (w) { w(v); }); };
        s.patchSettings(body).then(done, function () { done(null); });
      }, 400);
    });
  }

  // ---- key bindings: { action: [codes] } with platform overrides applied ----
  function loadBindings(defaults) {
    var s = sdk();
    if (!s || !hosted) return Promise.resolve(copyBindings(defaults));
    return s.loadBindings(defaults).catch(function () { return copyBindings(defaults); });
  }
  function copyBindings(d) {
    var out = {};
    Object.keys(d || {}).forEach(function (k) { out[k] = d[k].slice(); });
    return out;
  }

  function init() {
    var s = sdk();
    if (!s) return false;
    if (!started) {
      started = true;
      s.init();
      s.on('saved', function (ok) { if (hosted) setSync(ok ? 'synced' : 'offline'); });
      s.on('auth', function (a) {
        var was = hosted;
        hosted = !!(a && a.signedIn && s.slug);
        if (!hosted) { profile = null; setSync('offline'); }
        if (was !== hosted) authListeners.forEach(function (fn) { try { fn(hosted); } catch (e) { /* ignore */ } });
      });
      try {
        root.addEventListener('pagehide', function () { flushSave(true); });
        root.document.addEventListener('visibilitychange', function () { if (root.document.hidden) flushSave(true); });
      } catch (e) { /* no window events available */ }
    }
    hosted = !!(s.signedIn && s.slug);
    return hosted;
  }

  return {
    init: init,
    headers: headers,
    profileFor: profileFor,
    fetchProfile: fetchProfile,
    refreshToken: function () { var s = sdk(); return s ? s.refresh().then(function (t) { return !!t; }) : Promise.resolve(false); },
    loadCloud: loadCloud,
    onSave: onSave,
    flushSave: flushSave,
    getSettings: getSettings,
    patchSettings: patchSettings,
    loadBindings: loadBindings,
    canSignIn: function () { var s = sdk(); return !!(s && s.canSignIn()); },
    signIn: function () { var s = sdk(); return !!(s && s.signIn()); },
    inviteLink: function () { var s = sdk(); return s && hosted ? s.inviteLink() : null; },
    onSync: function (fn) { if (typeof fn === 'function') syncListeners.push(fn); },
    onAuth: function (fn) { if (typeof fn === 'function') authListeners.push(fn); },
    get hosted() { return hosted; },
    get profile() { return profile; },
    get sync() { return sync; },
    get userId() { var s = sdk(); return s ? s.userId : null; },
    get slug() { var s = sdk(); return s ? s.slug : null; }
  };
});
