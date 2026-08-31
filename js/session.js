/* Cushion & Cue — session controller (plain script → window.CCSession).
 * Owns the CCRules state machine and the app phase model:
 *   preparing → active ↔ paused → resolving → results
 * Applies validated commands, runs deterministic AI turns (paced, async),
 * keeps an undo stack where mechanics allow, tracks lesson steps, computes
 * score/stars, and builds a replay envelope for every completed game.
 * DOM-free: the UI subscribes via on(event, fn).
 */
(function (root, factory) {
  var deps = (typeof module === 'object' && module.exports)
    ? { RNG: require('./rng.js'), Rules: require('./rules.js'), Content: require('./content.js') }
    : { RNG: root.CCRNG, Rules: root.CCRules, Content: root.CCContent };
  var api = factory(deps.RNG, deps.Rules, deps.Content);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCSession = api;
})(typeof self !== 'undefined' ? self : this, function (RNG, Rules, Content) {
  'use strict';

  var REPLAY_SCHEMA = 1;
  var AI_THINK_MS = 750;   // paced pause before an AI acts

  // Stars for a finished state relative to its config.
  function starsFor(cfg, state) {
    if (!state.terminal) return 0;
    if (state.ruleset === 'eightball') {
      var winner = state.terminal.winner;
      var human = null;
      for (var i = 0; i < state.players.length; i++) if (!state.players[i].ai) { human = state.players[i]; break; }
      if (!human) return 1; // hotseat: either side winning counts
      return winner === human.id ? 3 : 1;
    }
    if (state.terminal.reason !== Rules.TERMINAL.CLEAR) return 0; // clearance loss: no stars
    var par = (cfg && cfg.par && cfg.par.shots) || 0;
    if (par && state.shotCount <= par) return 3;
    if (par && state.shotCount <= par + 2) return 2;
    return 1;
  }

  function create(cfg, opts) {
    opts = opts || {};
    var lesson = opts.lesson || null;      // CCContent lesson object
    var ranked = !!opts.ranked;            // daily / ranked: no undo
    var listeners = {};
    var state = null;
    var phase = 'preparing';
    var undoStack = [];                    // serialized states before player shots
    var lessonStep = 0;
    var lessonDone = false;
    var aiTimer = null;
    var lastActionId = null;
    var replay = null;                     // built at start, completed at end
    var result = null;

    function emit(evt, data) {
      var fns = listeners[evt] || [];
      for (var i = 0; i < fns.length; i++) {
        try { fns[i](data); } catch (e) { /* listener errors must not break the session */ }
      }
    }

    function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return api; }

    function setPhase(p, reason) {
      if (phase === p) return;
      phase = p;
      emit('phase', { phase: p, reason: reason || '' });
    }

    function isAITurn() {
      return state && !state.terminal && !!state.players[state.current].ai;
    }

    // ---- lesson step tracking: advance on the required event kind ----
    function lessonCheck(events, cmd) {
      if (!lesson || lessonDone) return;
      var step = lesson.steps[lessonStep];
      if (!step) return;
      var ok = false;
      if (step.require === 'shot') ok = !!cmd && cmd.type === 'shoot';
      else if (step.require === 'place') ok = !!cmd && cmd.type === 'place';
      else if (step.require === 'spin-top') ok = !!cmd && cmd.type === 'shoot' && (cmd.spinTop || 0) !== 0;
      else if (step.require === 'spin-side') ok = !!cmd && cmd.type === 'shoot' && (cmd.spinSide || 0) !== 0;
      else if (step.require === 'pot') ok = events.some(function (e) { return e.type === 'pot'; });
      else if (step.require === 'clear') {
        ok = events.some(function (e) { return e.type === 'terminal' && e.reason === Rules.TERMINAL.CLEAR; });
      }
      if (!ok) return;
      lessonStep++;
      if (lessonStep >= lesson.steps.length) {
        lessonDone = true;
        emit('lesson', { done: true, outro: lesson.outro, step: lessonStep, total: lesson.steps.length });
      } else {
        emit('lesson', { done: false, step: lessonStep, total: lesson.steps.length, text: lesson.steps[lessonStep].text });
      }
    }

    function buildResult() {
      var s = state;
      result = {
        cfgId: cfg.id || 'unnamed',
        kind: cfg.kind || 'practice',
        ruleset: s.ruleset,
        terminal: s.terminal,
        winner: s.terminal.winner || null,
        youWon: s.ruleset === 'eightball'
          ? s.terminal.winner === (s.players[0].ai ? null : s.players[0].id)
          : s.terminal.reason === Rules.TERMINAL.CLEAR,
        score: {
          pots: s.score.pots, winBonus: s.score.winBonus, shotBonus: s.score.shotBonus,
          foulPenalty: s.score.foulPenalty, total: s.score.total
        },
        stars: starsFor(cfg, s),
        shots: s.shotCount,
        pots: s.players.reduce(function (n, p) { return n + p.pots; }, 0),
        fouls: s.foulsLog.length,
        elapsedTicks: s.tick,
        replay: replay
      };
      return result;
    }

    function finishReplay() {
      replay.terminal = {
        reason: state.terminal.reason,
        winner: state.terminal.winner || null,
        finalHash: Rules.hashState(state)
      };
    }

    function maybeFinish() {
      if (state && state.terminal) {
        finishReplay();
        buildResult();
        setPhase('results', state.terminal.reason);
        emit('results', result);
        return true;
      }
      return false;
    }

    function scheduleAI() {
      if (!isAITurn() || phase === 'results') return;
      emit('ai-thinking', { player: state.players[state.current].id });
      aiTimer = setTimeout(function () {
        aiTimer = null;
        if (!isAITurn() || phase !== 'active') return;
        if (state.ballInHand) {
          var place = Rules.computeAIPlace(state);
          var r1 = applyValidated({ type: 'place', x: place.x, y: place.y }, null, true);
          if (!r1) return;
          aiTimer = setTimeout(function () {
            aiTimer = null;
            if (!isAITurn() || phase !== 'active') return;
            var shot = Rules.computeAIShot(state, state.players[state.current].skill != null
              ? state.players[state.current].skill : 0.5);
            applyValidated({ type: 'shoot', angle: shot.angle, power: shot.power, spinTop: 0, spinSide: 0 }, null, true);
          }, AI_THINK_MS);
        } else {
          var shot2 = Rules.computeAIShot(state, state.players[state.current].skill != null
            ? state.players[state.current].skill : 0.5);
          applyValidated({ type: 'shoot', angle: shot2.angle, power: shot2.power, spinTop: 0, spinSide: 0 }, null, true);
        }
      }, AI_THINK_MS);
    }

    // Shared path for player + AI commands. Returns the rules result or null.
    function applyValidated(cmd, actionId, isAI) {
      if (!state) return null;
      var res = Rules.applyCommand(state, cmd);
      if (!res.ok) {
        emit('invalid', { invalid: res.invalid, command: cmd });
        return res;
      }
      if (!isAI && cmd.type === 'shoot') {
        undoStack.push(Rules.serialize(state));
        if (undoStack.length > 64) undoStack.shift();
      }
      if (actionId) lastActionId = actionId;
      state = res.state;
      if (replay) {
        replay.commands.push(cmd);
        replay.stateHashes.push(Rules.hashState(state));
      }
      lessonCheck(res.events, cmd);
      emit('applied', { command: cmd, events: res.events, physics: res.physics || [], trace: res.trace, state: state, ai: !!isAI });
      if (!maybeFinish() && !res.trace) scheduleAI();
      // shots with a trace: UI plays it, then calls ackResolved() → scheduleAI
      return res;
    }

    var api = {
      on: on,

      start: function () {
        state = Rules.createGame(cfg);
        // a lesson may begin with ball in hand (declared in content)
        if (cfg.startInHand && state.ruleset === 'clearance') state.ballInHand = true;
        replay = {
          schemaVersion: REPLAY_SCHEMA,
          contentVersion: state.contentVersion,
          seed: state.seed,
          initialHash: Rules.hashState(state),
          commands: [],
          stateHashes: [],
          terminal: null
        };
        undoStack = [];
        lessonStep = 0; lessonDone = false;
        result = null; lastActionId = null;
        setPhase('active', 'start');
        emit('started', { state: state, cfg: cfg });
        if (lesson) emit('lesson', { done: false, step: 0, total: lesson.steps.length, text: lesson.steps[0].text });
        scheduleAI();
        return state;
      },

      // Player command. actionId prevents double-commits: while a shot is
      // resolving the session rejects further commands regardless.
      command: function (cmd, actionId) {
        if (!state) return { ok: false, invalid: 'no-session' };
        if (phase === 'resolving') return { ok: false, invalid: 'resolving' };
        if (phase === 'paused') return { ok: false, invalid: 'paused' };
        if (phase === 'results' || state.terminal) return { ok: false, invalid: Rules.INVALID.ENDED };
        if (isAITurn()) return { ok: false, invalid: 'not-your-turn' };
        if (actionId && actionId === lastActionId) return { ok: false, invalid: 'duplicate-action' };
        var res = applyValidated(cmd, actionId, false);
        if (res && res.ok && res.trace) setPhase('resolving', 'shot');
        return res;
      },

      // UI calls after trace playback finishes or is skipped. Player shots
      // pass through 'resolving'; AI shots apply while 'active'.
      ackResolved: function () {
        if (phase === 'resolving') setPhase('active', 'resolved');
        if (phase !== 'active') return;
        emit('settled', { state: state });
        maybeFinish();
        scheduleAI();
      },

      canUndo: function () {
        return !!(state && state.mechanics.undo && !ranked && !isAITurn() &&
          phase === 'active' && undoStack.length);
      },

      undo: function () {
        if (!api.canUndo()) return false;
        state = Rules.deserialize(undoStack.pop());
        if (replay) {
          // rewind the replay to the undone shot so it stays replayable
          while (replay.commands.length) {
            var c = replay.commands.pop();
            replay.stateHashes.pop();
            if (c.type === 'shoot') break;
          }
        }
        emit('undone', { state: state });
        return true;
      },

      hint: function () {
        if (!state || state.terminal || !state.mechanics.hint) return null;
        var h = Rules.hint(state);
        emit('hint', h);
        return h;
      },

      pause: function (reason) {
        if (phase === 'active' || phase === 'resolving') {
          if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
          setPhase('paused', reason || 'user');
          return true;
        }
        return false;
      },

      resume: function () {
        if (phase !== 'paused') return false;
        setPhase('active', 'resume');
        scheduleAI();
        return true;
      },

      resign: function () {
        if (!state || state.terminal) return false;
        applyValidated({ type: 'resign' }, null, false);
        return true;
      },

      getState: function () { return state; },
      getPhase: function () { return phase; },
      getResult: function () { return result; },
      getReplay: function () { return replay; },
      getLesson: function () {
        if (!lesson) return null;
        return { lesson: lesson, step: lessonStep, done: lessonDone };
      },
      isAITurn: isAITurn,
      cfg: cfg,
      ranked: ranked
    };
    return api;
  }

  return { create: create, starsFor: starsFor, REPLAY_SCHEMA: REPLAY_SCHEMA };
});
