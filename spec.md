# Cushion & Cue — Game Design Document (running spec)

This document describes Cushion & Cue as it ships today: present tense, every statement true of the code in this folder unless it sits in the closing "Design intent not yet implemented" list. A change to observable behaviour updates this document in the same commit.

## 1. Overview

**Pitch.** An intimate late-night cue hall in the browser: drag to aim, dial power and spin, and clear a scattered table inside a shot limit — or beat the house at 8-ball — on a deterministic physics table that replays identically from its seed.

| | |
|---|---|
| Genre | Turn-based precision sport (pool / cue sports) |
| Players | Solo clearance; 8-ball vs deterministic house AI or two-player hotseat on one device |
| Session length | 1–4 minutes per clearance table, 5–10 minutes per 8-ball match |
| Platforms | Desktop and mobile browsers (portrait and landscape); keyboard, mouse, touch |
| Rendering | Three.js top-down cue-hall scene (`vendor/three.module.min.js`) with an automatic 2D canvas fallback when WebGL is unavailable; all menus, HUD and controls are semantic HTML |
| Backend | Optional: `server.js` is the StarHermit authoritative game script; the client itself is fully playable offline |

**File map**

| Path | Role |
|---|---|
| `index.html` | Single page: home, list screens, setup, settings, help, game screen, pause/results overlays, screen-reader mirror |
| `css/style.css` | Dark cue-hall theme, responsive game layout, drawers, overlays, accessibility modes |
| `js/rng.js` | `CCRNG`: mulberry32 PRNG, FNV-1a string hash, four derived streams (rules, decor, AV, AI) |
| `js/rules.js` | `CCRules`: pure deterministic rules + physics engine, legality, fouls, scoring, AI shot solver, hints |
| `js/content.js` | `CCContent`: ball colours, five themes, 36 journey stages, 5 challenges, 6 lessons, 7 practice presets, daily generator, 6 achievements |
| `js/session.js` | `CCSession`: phase model (preparing → active ↔ paused → resolving → results), AI pacing, undo stack, lesson tracking, stars, replay envelope |
| `js/audio.js` | `CCAudio`: WebAudio buses, authored Opus clips from `sfx/manifest.json` with synthesized fallbacks, looped hall ambience |
| `js/render.js` | Three.js scene (table, balls, cue, aim guide, particles, camera fit) and the 2D canvas fallback, same API |
| `js/ui.js` | Screen router, settings + save persistence, HUD, input (pointer/touch/keyboard), toasts, live regions, progression, achievements |
| `js/bootstrap.js` | Calls `ui.init()` after DOM ready; surfaces a start-up failure in the page and the alert live region |
| `server.js` | Zero-dependency static host + REST session API (`/api/v1/time`, `/api/v1/session/*`) running `rules.js` authoritatively |
| `assets/key-art.webp`, `assets/results-clear.webp`, `assets/cloth.webp` | Home key art, win banner, felt weave texture (see §8, §15) |
| `sfx/*.opus`, `sfx/manifest.txt`, `sfx/manifest.json` | 21 authored clips; canonical manifest; generator/loader manifest |
| `coverart.png`, `icon.png`, `favicon.svg` | Store cover (1200×675), 256 px icon, tab icon |
| `tests/run-tests.js`, `tests/solver.js`, `tests/e2e.mjs` | Unit/rules/content/session tests, offline content solver, Playwright playthrough |
| `tools/validate.js` | Dev-only content validator (legality, reachability, bounded duration) |
| `starhermit.txt`, `LICENSE.md` | Platform manifest (`server=server.js`), PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

1. **The table is the truth.** Every shot resolves synchronously in `rules.js` before a single frame is drawn; the replay is cosmetic and "Skip replay" always lands on the exact authoritative end state. Rules in: fixed-step physics, quantized inputs, seeded scatter, replay hashes. Rules out: any animation-driven or wall-clock-dependent outcome, camera tricks that change picking.
2. **Aim like a player, not a spreadsheet.** The primary interaction is dragging on the cloth from the cue ball; the guide line, ghost ball and pocket glow show where the cue ball goes, not where the object ball ends up. Rules in: one drag to aim, one slider for power, one pad for spin, a hint that only sets the aim. Rules out: trajectory prediction of object balls, auto-aim, precision numeric entry as the main path.
3. **One rule at a time.** Learn lessons, journey intros and the black-last flag each add exactly one idea; mastery stages recombine what has been taught before anything new appears. Rules in: lessons that require the player to perform the rule, journey intros only on stages that introduce something. Rules out: tooltips that solve the shot, stages that mix a new rule with a new opponent.
4. **Quiet hall, honest feedback.** Amber-on-walnut palette, no music bed, a low room tone, and short material transients tied to physics events; fouls buzz, wins get four rising notes. Rules in: every input has an audible and visible acknowledgement, all cues also appear as text (toasts, live regions). Rules out: spectacle that hides state — particles and shake are tiered, disabled under reduced motion, and never gate readability.
5. **Fair by construction.** Daily tables come from a hash of the date, practice from a fresh seed, journey/challenges from fixed seeds; the house AI draws its imprecision from a seed-and-shot-count stream, so a replayed session is identical. Rules in: inspectable seeds, no hidden boosts, undo disabled only where the mode is ranked. Rules out: rubber-banding, adaptive difficulty, anything purchasable.

## 3. Player experience

**Target player.** Someone who enjoys pool's feel but has minutes, not hours: short deterministic tables with a par, a clear next stage, and a house opponent that gets better only when they say so.

**First 60 seconds** (a fresh save, `ui.js bindMenus` → `openSetup` → `startGame`):
1. Home shows the key-art hero and a dominant **Play** button. Play opens the setup card for journey stage 1, *First Stroke* (3 balls, 5 shots, solo, "No" ranked, hints + undo on) with its intro line: "Pot every ball before you run out of shots. Aim with a drag, set power, and strike."
2. Start lays out the table (rack clatter), the HUD reads "Pot the remaining 3 balls." and the live region announces it. Legal targets carry a ground ring; the aim guide is already visible at angle 0.
3. The player drags on the cloth (or presses ←/→), sees the guide swing, presses Shoot/Enter. The replay plays with strike, click, cushion and pocket sounds; a Skip replay button appears during it.
4. Any foul toasts "Foul: …" assertively and, if it granted ball in hand, the Shoot button gives way to a "Place here" flow with a ghost ball.
5. Clearing the table opens the results card: headline, stars, breakdown, win banner, and **Next** to stage 2. Learn (six lessons that each demand the rule be performed) and Help (six cards, including the controls map) are one tap from home for anyone who wants instruction first.

**Session shape.** Home → one or two journey stages or a daily → results → Next/Retry/Home. Practice and Challenges are side doors for a specific mood (a hotseat match, a fixed-seed puzzle). Progress is visible on home as "Journey n/36 · stars · career pots".

**Emotional beat.** The pause between pressing Shoot and the last ball dropping: the player has committed a quantized shot, the table resolves it without mercy, and the replay lets them watch whether their read of the angle was right. Wins are quiet satisfaction (four mallet notes, an eight ball dropping in the banner), losses are a soft descending motif and an immediate Retry.

## 4. Core loop and rules contract

All rules live in `js/rules.js`; nothing else mutates state except through `applyCommand`.

### Table and entities (`TABLE`, `PHYS`)
- Playing surface 2.24 m × 1.12 m between cushion faces, origin at centre, `R = 0.0286 m` ball radius. Head spot at x = −0.56, foot spot (rack apex) at x = +0.56.
- Six pockets: four corners with capture radius 0.078 m, two sides (x = 0) with 0.068 m. Cushions are open within 0.10 m of a pocket centre.
- Balls: cue (0), solids 1–7, eight (8), stripes 9–15 (`ballGroup`). Colours and high-contrast alternates are in `content.js BALLS`; the number is always printed on the ball and listed in the target rail, so colour is never the only cue.
- State (`createGame`): version, config id, seed, ruleset, `blackLast`, tick, turn, shot count, phase, players (`group`, `fouls`, `pots`, `ai`, `skill`), balls, `ballInHand`, `openTable`, `breakDone`, `shotsLeft`, mechanics `{undo, hint}`, par, score components, fouls log, terminal.

### Layouts (`rackPositions`, `scatterPositions`)
- `rack` (8-ball): apex 1 on the foot spot, 8 in the centre of row 3, 7 and 9 in the rear corners, the other twelve shuffled by the rules stream; cue ball on the head spot.
- `scatter` (clearance, daily, practice, journey): seeded non-overlapping positions at least 0.03 m from cushions, 0.14 m from pocket centres and 2.4 R apart; cue ball near the head spot unless `cueAt` is given.
- `explicit` (lessons): authored coordinates.

### Legal actions (`legalActions`, `checkCommand`)
- `shoot {angle 0..6283 mrad, power 0..1000 ‰, spinTop −100..100, spinSide −100..100}` — integers only; rejected with `must-place-cue-first` while ball in hand.
- `place {x, y}` in millimetres — only while ball in hand; rejected `out-of-bounds` outside the cushions or `place-blocked` within 2.05 R of another ball. Placement is anywhere on the table (no head-string restriction).
- `resign` — any time before terminal. Invalid reasons: `game-ended`, `unknown-command`, `malformed-command`, `bad-angle`, `bad-power`, `bad-spin`, `not-ball-in-hand`, `must-place-cue-first`, `place-blocked`, `out-of-bounds`; the session adds `resolving`, `paused`, `not-your-turn`, `duplicate-action`.

### Shot resolution (`simulateShot`, `applyCommand`)
Fixed step 1/240 s, at most 2400 ticks (10 s) per shot. Each tick in order: (1) rolling friction 0.5 m/s² and integration, stop below 0.01 m/s; (2) pocket capture; (3) ball–ball collisions in stable id order, two passes, restitution 0.95, positional correction; on the cue ball's first contact, top/back spin adds `spinTop × 0.5 × impact` along the incoming line (follow/draw); (4) cushions with restitution 0.75 except near pocket mouths, side spin kicks the cue ball tangentially (`spinSide × 0.6 × speed`) then decays ×0.4 per cushion; hard backstop 0.15 m outside the rails. Initial cue speed is `power/1000 × 4.2 m/s`. Every fourth tick is sampled into a 60 Hz trace; the last frame is exact (9-decimal quantized) and equals the new state. Physics events (`hit`, `cushion`, `pocket`) carry tick and speed for audio/VFX sync. After a shot `state.tick` advances by 2400 so tick bases are monotonic.

### Adjudication (`applyShotOutcome`, `legalTargets`)
Legality is judged against the targets computed *before* the shot. Fouls, in the order detected: `cue-ball-potted`, `no-contact`, `wrong-first-contact`, `no-rail-after-contact` (no ball potted and no cushion after first contact). A foul adds −75 to the score, increments the player's foul count and logs it.
- **Clearance** (solo): every non-potted ball is a target, except the 8 while `blackLast` and other balls remain. Each shot decrements `shotsLeft`. Terminal: `table-clear` (all targets gone, or black potted last without foul), `shot-limit`, `black-early`, `black-scratch`. A foul never passes the turn but grants ball in hand.
- **8-ball** (two players): open table until the first legal pot after the break, which assigns groups (`groups` event). Targets: on an open table any ball but the 8; then the player's group; then the 8 once seven of the group are down. Potting the 8 on the break re-spots it on the foot spot (`respotEight`); otherwise 8 potted = `eight-complete` (win) if the group was cleared and no foul, `eight-scratch` (loss) on a foul, `eight-early` (loss) otherwise. After a foul the opponent gets ball in hand; after a shot with no own-group pot the turn passes; a legal pot keeps the turn. `resigned` awards the win to the opponent.

### Scoring (`addScore`, `finish`) — integers
`total = pots + winBonus + shotBonus + foulPenalty` with +100 per potted object ball (any group), +500 on `table-clear`/`eight-complete`, +50 per unused shot on a clearance win, −75 per fouled shot. **Worked example** (journey stage 1, shot limit 5, par 3): three pots in four shots, no fouls → pots 300 + win 500 + shot bonus 1 × 50 + 0 = **850**. Stars (`session.js starsFor`): clearance win at or under par = 3, within par + 2 = 2, otherwise 1, loss = 0; 8-ball: 3 if the human wins, 1 otherwise (hotseat always 1). The example scores 2 stars (4 ≤ 3 + 2).

### RNG and seeding (`js/rng.js`)
One master seed per config; `derive(seed, STREAM_*)` yields independent mulberry32 streams: rules (layouts), decor (wall frames in the 3D room, seed 7), AV (audio variant choice, reseeded per game), AI (`computeAIShot` uses `seed ^ STREAM_AI ^ shotCount × 0x9e3779b9`). `hashState` is FNV-1a over a stable stringify and is used for replay chains, save checksums and server hashes.

### AI, hints, undo
- `computeAIShot(state, skill)`: for every legal target and pocket, a ghost-ball line; rejects cuts thinner than dot 0.15 and blocked paths; scores by distance and cut; power from distances (≤ 900). No shot found → roll into the nearest legal ball. Imprecision: angle ± (1 − skill) × 0.055 rad, power ± 18 % × (1 − skill), seeded. `computeAIPlace` scans a grid behind the head string.
- `hint(state)` = the same solver at skill 0.97, or a placement when in hand. The UI only moves the aim guide/placement ghost; the player still chooses power and spin.
- Undo (`session.js`): the serialized state before each *player* shot is pushed (max 64); allowed when `mechanics.undo`, not ranked, not the AI's turn and phase active. Undo also rewinds the replay envelope.

## 5. Modes and progression

| Mode | Entry | Content | Undo / hint | Ranked |
|---|---|---|---|---|
| Play | Home → Play | First unbeaten unlocked journey stage (last stage once all are beaten) | as journey | no |
| Journey | Home → Journey | 36 authored stages (`content.js J`): 31 clearance tables from 3 balls/5 shots up to 10 balls/10 shots, 5 house matches at AI skill 0.25 → 0.80, five mastery stages (10, 18, 25, 31, 36); themes advance every ~9 stages | on / on | no |
| Daily Challenge | Home → Daily | One clearance per UTC day: `hashString('cushion-and-cue-daily-v1-' + date)` picks 5–7 balls, black-last 50 %, shot limit n + 2, par n + 1, a random theme | off / on | yes (label only) |
| Learn | Home → Learn | Six lessons: Aim and strike, Power control, Follow and draw, Side spin, Fouls and ball in hand (starts in hand), The 8 goes last. Steps advance on a required event (`shot`, `pot`, `place`, `spin-top`, `spin-side`, `clear`) | on / on | no |
| Practice | Home → Practice | Solo Warm-up/Club/Pro (4/7/10 balls), Match vs Casual/League/Shark AI (0.3/0.6/0.85), Two players hotseat; seed = `Date.now() ^ random` | on / on | no |
| Challenges | Home → Challenges | Sprint Six, Black Watch, Sharpshooter (9 balls in 8 shots), Marathon, House Final (AI 0.85); fixed seeds, stars saved under `ch:<id>` | on / on | no |

Unlocks: journey stage *n* unlocks once stage *n − 1* has ≥ 1 star (`journeyUnlocked`). Best stars per stage/challenge are kept. The setup screen shows rules, expected duration, players, ranked flag and assists before Start. Themes carry `unlockStars` values (0/10/25/45/70) but the Settings theme list offers all five regardless. Achievements (`updateProgression`, idempotent): First Clear, Match Winner, Spin Graduate (all lessons), Regular (daily on three days), Mastery Gold (3★ on all mastery stages), Century Break (100 career pots).

## 6. Controls and interaction

| Input | Desktop | Touch | Feedback |
|---|---|---|---|
| Aim | Drag on the table from anywhere; ←/→ = 8 mrad, Shift = 1 mrad | Drag on the table (pointer capture, `touch-action: none`) | Guide line, ghost ring at the first ball hit, cue stick, pocket glow when the guide ends near a pocket, "Aim: x.xx rad · Power n%" readout, click on release |
| Power | Slider 0–100 %; ↑/↓ or +/− = 2.5 % | Slider (44 px tall) | Percentage label, readout |
| Spin | Spin pad drag/click; when focused ←→↑↓ = 10, 0/Home = reset | Pad drag | Marker moves, "follow 30, left 20" text and `aria-valuetext` |
| Shoot | Shoot button, Enter or Space (when focus is on the table) | Shoot button (full width on narrow layouts) | UI click, cue strike, replay, controls disabled, Skip replay appears |
| Place (ball in hand) | Tap/click a free spot then "Place here" or Enter; H proposes a spot | Same | Ghost cue ball, "Place here" button, place tap sound, "Cue ball placed." announcement |
| Hint | H or Hint button | Button | Bell ping, aim guide moves, toast |
| Undo | U or Undo button | Button | Rewind swish, toast "Shot undone." |
| Pause | P, Esc or Pause button; Esc/P resumes | Button | Overlay with Resume focused |
| Objective drawer | Objective button (narrow layouts); Esc closes | Same | Drawer slides in, focus moves into it |
| Back | Back buttons; Esc on any non-home screen | Same | UI click |

Input locking (`ui.js lockInput`, `session.js command`): while a shot replays, Shoot/Hint/Undo/Place, the power slider and spin pad are disabled and the session rejects commands with `resolving`; on the AI's turn with `not-your-turn`; while paused with `paused`. Each player command carries an action id (`shot-n`, `place-n`) so a repeated commit is rejected as `duplicate-action`. Keyboard shortcuts yield to focused buttons and native inputs so Enter never fires twice. Hiding the tab pauses an active game.

## 7. Screens and UI flow

`home → {journey | learn | practice | challenge} → setup → game ⇄ pause-overlay → results-overlay → (setup of next stage | game restart | home)`; `settings` and `help` are reachable from home and (settings) from pause, returning to the screen they came from (`returnScreen`). Screen changes move focus to the first heading or control; the game screen focuses the table host (`showScreen`).

- **Desktop ≥ 1024 px:** top bar (objective, turn, score) over a three-column grid: objective rail 230 px (objective, shots, legal-target chips, simulated table time) · table · action rail 280 px (Pause/Hint/Undo/Skip, power, spin pad, aim readout, Place/Shoot pinned to the bottom).
- **< 1024 px:** the objective rail becomes a left drawer (`Objective` toggle, `aria-expanded`, Close button, hidden from the tab order when closed); the action rail wraps below the table.
- **Portrait phone (≤ 700 px):** `100dvh` column; the table keeps an 8:5 aspect and at most 58 % of the height so the thumb tray with the full-width Shoot button stays on screen.
- **Landscape phone (height ≤ 500 px):** table + 220 px action column, 40 px top bar; the objective rail is a drawer.
- Safe areas: all screen padding and the top bar/toast positions add `env(safe-area-inset-*)`. Left-handed mode mirrors the rails and the drawer side.
- Must never be cut off: the whole table including all six pockets (the 3D camera pulls back until the cushion corners project inside ±0.94 NDC, `fitCamera`), the Shoot/Place button, the top-bar objective, the results card (scrollable, max 90 vh; the banner hides under 560 px height).

## 8. Art direction

**Hero.** The table: the only saturated surface in a dark walnut room, lit by one warm key light. UI chrome is matte and recedes.

**Palette** (`css/style.css`): background `#14100c`, panels `#1f1a14` / `#2a231b`, ink `#f0e8d8`, dim ink `#b7ab94`, accent (brass) `#e8c46a` with accent ink `#241a08`, danger `#d4634e`, focus ring `#ffd970`, borders `#3a3125`/`#443a2c`. High contrast swaps to `#000000`/`#101010`/`#1a1a1a`, ink `#ffffff`, accent `#ffd700`, focus white. Guide/selection lines are `#fff2b0`. Themes (`content.js THEMES`) recolour cloth/cushion/wood/walls/floor/fog: Tournament Green cloth `#1e6a44` wood `#6e4526`, Midnight Blue `#274b7a`, Oxblood Lounge `#7a2e2e`, Slate Club `#4c5a5e`, Ivory Hall `#8a7f68`. Ball colours: 1/9 `#e8b93c`, 2/10 `#2e5fb8`, 3/11 `#d43b2e`, 4/12 `#6a3d9a`, 5/13 `#e07b28`, 6/14 `#2e7d46`, 7/15 `#8a3b2a`, 8 `#1c1c20`, cue `#f4efe4`.

**Shape language.** Rounded 10–14 px panels, circular target chips and spin pad, a single straight guide line; the 3D room is boxes and cylinders with seeded framed panels on the walls — restrained, never decorative enough to compete with the balls.

**Typography.** `system-ui` stack, 16 px base (19 px with Larger text), uppercase 0.85 rem rail headings with 0.08 em tracking, tabular numerals in the breakdown, `<kbd>` badges on buttons.

**Motion.** Trace playback at 60 Hz sampled frames; pooled particle bursts (48) on pockets; a 0.4 s low-amplitude camera shake only on "big" bursts; 0.18 s drawer and toast transitions. Reduced motion (setting or body class) removes transitions, particles and shake; Low quality also drops particles, shadows and antialiasing. Under reduced motion the replay still plays because it conveys the rules outcome.

**Visual assets the design calls for** (all shipped, §15): key art behind the home title (`assets/key-art.webp`, CSS background with panel-colour fallback; hidden in high contrast); a felt weave on the cloth tinted by the theme (`assets/cloth.webp`, mirrored-repeat 8×4, flat colour while loading or on failure); a win banner on the results card (`assets/results-clear.webp`, hidden on loss or load error); cover art (`coverart.png`) derived from the key art.

## 9. Audio direction

**Mix.** No music bed. Four gain buses under a master (`js/audio.js`): effects (impacts, UI, default 0.8), voice (chimes and the hint ping, 0.7), music (fanfares and the achievement jingle, 0.6), ambience (looped hall room tone, 0.5), each with a Settings slider plus Mute all; volumes persist in `localStorage['cushion-and-cue-audio-v1']`. The context unlocks on the first pointer/key gesture. Authored clips are loaded lazily from `sfx/manifest.json`; each event may list several variants and the seeded AV stream (reseeded with the game seed) picks one, so a replayed session sounds the same. While a clip is loading or if it fails, the event's WebAudio synthesis plays instead, so the game is never silent. The ambience starts as filtered noise and swaps to `hall-ambience.opus` once decoded.

**SFX event table** (source of `sfx/manifest.txt`)

| Event id | File(s) | Sound | Usage |
|---|---|---|---|
| `strike` | cue-strike-soft, cue-strike-hard | Leather tip on phenolic ball, soft tap / sharp crack | Start of every shot replay (`Audio.strike(power)`) |
| `ballClick` | ball-click-soft/-medium/-hard | Two resin balls colliding | Physics `hit` events during playback |
| `cushion` | cushion-thump-soft/-hard | Ball into rubber cushion, padded thud | Physics `cushion` events |
| `pocketDrop` | pocket-drop | Hollow knock then rattle into the pocket | Physics `pocket` events, with particle burst |
| `foul` | foul-buzz | Low descending referee buzz | Rules `foul` event with the assertive toast |
| `uiClick` | ui-click, ui-confirm | Dry wooden tick / two soft knocks | Menu buttons, Back, Start, Shoot press, drag release, drawer toggle |
| `turnChime` | turn-chime | Two ascending mallet notes | Trace-less non-terminal transitions (placements) |
| `cueBeep` | hint-beep | Single glass-like bell ping | Hint shown |
| `win` | win-fanfare | Four rising mallet notes | Results, player won |
| `lose` | lose-fanfare | Three descending marimba notes | Results, player lost |
| `rack` | rack-setup | Balls settling into a wooden rack | Game start, restart, retry (`startGame`) |
| `placeBall` | cue-place | One ball set down on felt | Ball-in-hand placement accepted |
| `groups` | groups-set | Two knuckle knocks on the rail | 8-ball groups assigned |
| `undo` | undo-rewind | Short reversed swish | Shot undone |
| `achievement` | achievement-sparkle | Glockenspiel arpeggio with shimmer | New achievement on the results card, 0.7 s after win/lose |
| `ambience` | hall-ambience | Late-night pool hall room tone (10 s loop) | Ambience bus from first gesture |

Every audible cue has a text twin: fouls, hints, undo and group assignment toast; results, pauses and turn changes are announced in the live regions.

## 10. Localization

The shipped build is **English only**: all strings live inline in `index.html` (static screens) and `js/ui.js` (HUD, toasts, help cards, results) and `js/content.js` (stage, lesson and achievement names). `<html lang="en">` is fixed and no language selection exists. The nine target locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) are listed under design intent in §17. Layout already tolerates expansion: buttons and cards wrap, the setup facts grid has 140 px labels with wrapping values, and toasts are width-free.

## 11. Accessibility

- **Keyboard-only path:** skip link to `#main`; every screen is reachable by Tab/Enter; on the game screen the table host has `tabindex=0` and `role=application` with an instruction label; ←/→ aim, ↑/↓ or +/− power, Enter shoot/place, H/U/P shortcuts, Esc back/close/pause; the spin pad is a `role=slider` with arrow keys and `aria-valuetext`. Overlays are `role=dialog aria-modal` with Resume/Retry focused on open; returning from Settings while paused re-focuses Resume.
- **Focus:** `:focus-visible` 3 px `#ffd970` outline; headings receive `tabindex=-1` so screen changes move focus.
- **Announcements:** `#sr-live` (polite: game start, shots, placements, hints, lesson steps, resume) and `#sr-alert` (assertive: fouls, invalid actions, results); toasts mirror into the polite region. `#sr-table` is a focusable off-screen summary of objective, turn, score, ball-in-hand, every ball's coarse zone (top/middle/bottom × left/center/right) and legal targets, refreshed after every state change.
- **Contrast and colour:** ink `#f0e8d8` on `#14100c` (≈ 14:1); accent buttons use dark ink; a High contrast mode (black panels, white ink, `#ffd700` accent, brighter ball colours, key art removed). Ball identity is always the printed number plus the target-chip list.
- **Reduced motion:** setting removes CSS transitions/animations, particles and camera shake (also honoured when the 3D renderer receives it).
- **Targets:** 44 px minimum (`--tap`) on all buttons, sliders and the name field; 8 px gaps; the spin pad is 96–120 px.
- **Larger text** (19 px base) and **Left-handed** layout toggles; tutorial replay from Settings.

## 12. StarHermit integration

Per the platform conventions (https://wiki.starhermit.com/):

| Feature | Status |
|---|---|
| Packaging | `starhermit.txt` (`name=Cushion & Cue`, `launch=index.html`, `owner`, `server=server.js`, `version`, `contentVersion`, `cover=coverart.png`); `LICENSE.md` at root |
| Server script | `server.js` runs `rules.js` authoritatively: `POST /api/v1/session/start {config}`, `POST /api/v1/session/:id/command {commandId, command}` (idempotent by commandId, state hash per transition, 422 on invalid), `GET /api/v1/session/:id` (reconnect source of truth), `POST …/resign`; in-memory store capped at 500 sessions; 16 KB body limit; refuses paths outside the root and never serves `tests/`, `tools/`, `node_modules/` or dotfiles |
| Platform time | Client fetches `GET /api/v1/time` once at start and offsets the daily date by `epochMs − Date.now()`; falls back to the local UTC clock offline |
| Identity | Local display name only (`profile-name`, saved in settings); no platform login, presence or avatar |
| Saves | Local `localStorage['cushion-and-cue-save-v1']`, versioned and FNV-checksummed (a corrupt document resets cleanly); no cloud save |
| Achievements | Six stable lowercase keys unlocked idempotently in the local save; not submitted to the platform |
| Leaderboards, matchmaking, invitations, chat, voice, presence, replays upload | Not used. The client never calls the session API; replay envelopes are built locally (`session.getReplay()`) but not transmitted |

## 13. Technical architecture

- **Module contract.** `rng` → `rules` → `content` → `session` are UMD scripts usable from Node and the browser without a bundler; `render`, `ui`, `bootstrap` are ES modules (three.js via an import map). `ui` never touches rules state except through `session.command/undo/hint`; `render` consumes snapshots and traces only.
- **Determinism and replay.** Fixed step, integer inputs, quantized outputs (`q6`/`q9`), stable collision order, no `Date.now()` in rules; the session records `{schemaVersion 1, contentVersion, seed, initialHash, commands, stateHashes, terminal{reason, winner, finalHash}}` and `tests/run-tests.js` proves identical hash chains for the same seed and commands. AI turns are paced by a 750 ms timer but their content is seed-derived.
- **Phase model** (`session.js`): `preparing → active ↔ paused → resolving → results`; a trace that finishes while paused is settled on resume exactly once; pausing clears AI timers.
- **Persistence.** Settings `cushion-and-cue-settings-v1` (theme, quality, contrast, motion, text, handedness, name), audio volumes, save (journey/challenge stars, lessons, achievements, career pots, daily days, last snapshot, checksum).
- **Rendering.** `Render.create` tries Three.js (`PerspectiveCamera` 38°, key directional light with 1024² shadows on High, pixel ratio cap 2/1.5/1 by quality, pooled particles, ground-plane raycast for picking) and falls back to a 2D canvas with the same API on any error (toast "3D unavailable"). WebGL context loss is reported with the state kept safe. Cloth texture and key art are progressive enhancements with flat/colour fallbacks.
- **Budgets.** One draw call per ball plus ring/decal, ≤ 48 particles, one shadow map; a 16-ball rack is ~60 meshes. Physics: ≤ 2400 ticks × 16 balls per shot, solved synchronously (single-digit milliseconds in tests). Assets: three WebP files 134 KB total, 21 Opus clips.
- **How the e2e drives the UI.** `tests/e2e.mjs` serves the folder on an ephemeral port with `/api/v1/time`, launches system Chrome through `playwright-core`, and only uses visible controls: home buttons, journey list, help, settings selects/checkboxes, Play → Start, drag-aim on the canvas, spin-pad clicks, the power slider, Hint/Shoot buttons alternated with H/Enter keys, Skip replay, U undo, Place here, pause/settings/Esc, results buttons; it fails on any console error or page error.

## 14. Testing and acceptance criteria

`npm test` (`tests/run-tests.js`, 2 867 assertions) verifies: RNG determinism and stream independence; `createGame` for every layout; every `INVALID` reason reachable; the four fouls; clearance endings and score components; 8-ball group assignment, turn passing, 8-early/8-scratch/clean-8/resign; serialize round-trip and version rejection; replay hash chains; AI shots legal and NaN-free over 30 seeds; every journey stage, challenge and lesson legal and solvable inside its shot limit by `tests/solver.js`; daily determinism and ranked no-undo; achievement keys; session phases, double-commit rejection, undo, lesson progression, replay envelope, pause-during-resolve settling once. `tools/validate.js` reruns the content checks from the CLI.

`npm run test:e2e` passes on desktop 1280×800 and mobile 390×844 (touch): journey list shows 36 stages with only stage 1 unlocked, help and settings work and persist, First Stroke plays to "Table clear!" with Shoot/Hint enabled before every shot, undo restores the shot counter, the objective drawer opens/closes on mobile, progression and home summary update.

QA bar (agents/qa.md) as checkable statements: the first stage's setup intro and the HUD objective tell a new player what to do; Learn lessons require each rule to be performed; every feature (all six modes, hotseat, settings, drawer, pause, undo, hint, place) is reachable by clicking visible controls; no console errors or warnings in the e2e runs; no element is clipped at 1280×800, 390×844 portrait or ≤ 500 px-high landscape; all cues have text equivalents.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280×720, 37 KB) | Home hero backdrop; base of the cover | FLUX.2 klein, seed 7201, 1536×864, 28 steps | generated in this pass, wired (`.home-hero` background) |
| `assets/results-clear.webp` (1024×448, 13 KB) | Win banner on the results card | FLUX.2 klein, seed 7202, 28 steps | generated in this pass, wired (`#res-art`) |
| `assets/cloth.webp` (512×512, 84 KB) | Felt weave tinted by theme cloth colour | FLUX.2 klein, seed 7203, levels-normalised to light grey | generated in this pass, wired (`render.js` cloth material map) |
| `coverart.png` (1200×675, 389 KB) | Store cover: key art + title/tagline (ffmpeg drawtext, DejaVu) | derived from key-art seed 7201 | replaced in this pass (previous file was a generic template) |
| `icon.png`, `favicon.svg` | Platform icon, tab icon | hand-authored SVG / PNG | shipped |
| `sfx/cue-strike-*.opus`, `ball-click-*.opus`, `cushion-thump-*.opus`, `pocket-drop.opus`, `foul-buzz.opus`, `ui-click.opus`, `ui-confirm.opus`, `turn-chime.opus`, `hint-beep.opus`, `win-fanfare.opus`, `lose-fanfare.opus` (15) | Core impacts, UI, chimes, fanfares | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/rack-setup.opus`, `cue-place.opus`, `groups-set.opus`, `undo-rewind.opus`, `achievement-sparkle.opus`, `hall-ambience.opus` (6) | Game start, placement, groups, undo, achievement, ambience loop | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical manifest / loader+generator manifest / generator report | authored / tool output | shipped, in sync (21 entries each) |
| 3D models / character animation | None: the table, balls and cue are procedural three.js primitives and there is no humanoid | — | not required |

## 16. Known limitations

- English only (§10). No `knownissues.md` exists for this game.
- Themes list `unlockStars` but the Settings menu does not gate them; unlock values are informational.
- The 8-ball house AI never uses spin and plays no safeties beyond rolling into the nearest legal ball; at skill ≥ 0.8 it is accurate but tactically naive.
- Ball-in-hand after a foul allows placement anywhere on the table (no behind-the-head-string rule), including in 8-ball after the break.
- Physics is a 2D disc model: no jump, massé, throw or cloth nap; side spin acts only at cushion contact and follow/draw only at the first contact.
- Hotseat 8-ball shows "Turn: Player 1/2" but both players share the same hint, undo and score display; scoring is per table, not per player.
- `server.js` sessions are in-memory only and the client does not use them; a server restart forgets sessions.
- The Three.js renderer runs under software WebGL in the e2e (Low quality is selected there), so shadow/particle paths are exercised only on real GPUs.

## 17. Design intent not yet implemented

- Localization to en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT with a string table, `navigator.language` selection and a Settings override.
- Daily leaderboard and achievement submission through the StarHermit API, with the replay envelope attached to each ranked score.
- Theme unlocks by star count, surfaced in Settings.
- Hosted matches (invitations, reconnect) on top of the existing `server.js` session API.
- Per-player score in hotseat and a behind-the-head-string placement rule after a break foul.
