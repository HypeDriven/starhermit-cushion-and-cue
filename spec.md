# Cushion & Cue — Game Design Document (running spec)

This document describes Cushion & Cue as it ships today, a StarHermit engine script game: present tense, every statement true of the code in this folder unless it sits in the closing "Design intent not yet implemented" list. A change to observable behaviour updates this document in the same commit.

## 1. Overview

**Pitch.** An intimate late-night cue hall: drag to aim, dial power and spin, and clear a scattered table inside a shot limit — or beat the house at 8-ball — on a deterministic physics table that replays identically from its seed.

| | |
|---|---|
| Genre | Turn-based precision sport (pool / cue sports) |
| Players | Solo clearance; 8-ball vs deterministic house AI or two-player hotseat on one device |
| Session length | 1–4 minutes per clearance table, 5–10 minutes per 8-ball match |
| Platforms | A StarHermit engine script game (engine 1.23.0, host API 1.21, `engine.minor=18`): played natively by the StarHermit client and in browsers by the engine's web runtime (desktop and mobile, portrait and landscape); keyboard, gamepad, mouse, touch |
| Rendering | `starhermit:scene` (three-like): the top-down cue-hall scene in the table's rectangle; menus, HUD and controls are `starhermit:ui` (immediate mode, styled from `assets/ui-style.json`) |
| Backend | `score-script.js` is the StarHermit platform script (leaderboard posting only); `server.js` is a local dev server; the game is fully playable offline |

**File map**

| Path | Role |
|---|---|
| `starhermit.txt` | Manifest: `launch=index.html`, `engine.api=1`, `engine.entry=native/main.ts`, `engine.version=1.23.0`, `engine.minor=18`, `engine.capabilities=platform,storage,clipboard`, the actions with keys and gamepad controls, name/description/owner/`server=score-script.js`/cover |
| `native/main.ts` | Entry module: screen router, session events, results with progression and achievements, aim / power / spin / place input, fixed-step replay and timers, lifecycle |
| `native/screens.ts` | Every screen, the game HUD, rails, table region, spin pad, pause and results cards, toasts (`starhermit:ui`); layouts by window size |
| `native/render.ts` | The cue hall on `starhermit:scene`: table, balls, cue, guide, ghosts, sparks, motes, room; camera view offset into the table rectangle; picking |
| `native/quality.ts` | The old graphics presets and budgets keyed by the runtime's quality tier and level |
| `native/platform.ts` | Save (engine save, conflict merge, the browser build's cloud save migrated), game options and legacy settings, player, invite link, platform clock, score posting |
| `native/audio.ts` | The authored clips on the runtime's buses, seeded variant choice, the room-tone loop |
| `native/style.ts`, `native/i18n.ts`, `native/classic.ts` | UI styles and high-contrast tokens; the interface language; the classic scripts loaded with `loadClassic` and their types |
| `js/rng.js` | `CCRNG`: mulberry32 PRNG, FNV-1a string hash, four derived streams (rules, decor, AV, AI) |
| `js/rules.js` | `CCRules`: pure deterministic rules + physics engine, legality, fouls, scoring, AI shot solver, hints |
| `js/content.js` | `CCContent`: ball colours, five themes, 36 journey stages, 5 challenges, 6 lessons, 7 practice presets, daily generator, 6 achievements |
| `js/session.js` | `CCSession`: phase model (preparing → active ↔ paused → resolving → results), AI pacing on injectable timers, undo stack, lesson tracking, stars, replay envelope, save merge |
| `js/progress.js` | `CCProgress`: the checksummed save document, merge, recording a finished game, unlocks, the old settings' mapping |
| `js/i18n.js`, `js/locales/*.js` | `CQCI18n`: `T(US-English text, vars)` and the per-language dictionaries |
| `assets/ui-style.json` | `starhermit css` output of `tools/ui-style.css` (the old `css/style.css`, class-based) |
| `assets/key-art.webp`, `assets/results-clear.webp`, `assets/cloth.webp` | Home key art, win banner, felt weave texture (see §8, §15) |
| `sfx/*.opus`, `sfx/manifest.txt`, `sfx/manifest.json` | 21 authored clips; canonical manifest; loader manifest (read at start) |
| `index.html`, `starhermit-files.json` | The engine's web loader and file index written by `npm run package` (never edited by hand) |
| `cover.jpg`, `coverart.png`, `icon.png` | Store cover, cover art (1200×675), 256 px icon |
| `tests/run-tests.js`, `tests/solver.js`, `tests/progress.test.mjs`, `tests/i18n.test.mjs`, `tests/native.mjs`, `tests/native/*.play` | Rules/content/session tests, offline content solver, save model, localization coverage, engine checks and play scripts |
| `tools/plan.mjs`, `tools/gen-plays.mjs`, `tools/browser-play.mjs`, `tools/package-web.mjs`, `tools/css.mjs`, `tools/validate.js` | Play-script planner and generator, GPU-Chrome play of the web package, packaging, CSS conversion, content validator (dev only) |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished table's total and posts it to the `high-score` board |
| `server.js` | Zero-dependency local static host + REST session API running `rules.js` (dev only, left out of the package) |
| `LICENSE.md` | PolyForm Noncommercial 1.0.0 |

## 2. Vision and design pillars

1. **The table is the truth.** Every shot resolves synchronously in `rules.js` before a single frame is drawn; the replay is cosmetic and "Skip replay" always lands on the exact authoritative end state. Rules in: fixed-step physics, quantized inputs, seeded scatter, replay hashes. Rules out: any animation-driven or wall-clock-dependent outcome, camera tricks that change picking.
2. **Aim like a player, not a spreadsheet.** The primary interaction is dragging on the cloth from the cue ball; the guide line, ghost ball and pocket glow show where the cue ball goes, not where the object ball ends up. Rules in: one drag to aim, one slider for power, one pad for spin, a hint that only sets the aim. Rules out: trajectory prediction of object balls, auto-aim, precision numeric entry as the main path.
3. **One rule at a time.** Learn lessons, journey intros and the black-last flag each add exactly one idea; mastery stages recombine what has been taught before anything new appears. Rules in: lessons that require the player to perform the rule, journey intros only on stages that introduce something. Rules out: tooltips that solve the shot, stages that mix a new rule with a new opponent.
4. **Quiet hall, honest feedback.** Amber-on-walnut palette, no music bed, a low room tone, and short material transients tied to physics events; fouls buzz, wins get four rising notes. Rules in: every input has an audible and visible acknowledgement, all cues also appear as text (toasts, announcements). Rules out: spectacle that hides state — particles and shake are tiered, disabled under reduced motion, and never gate readability.
5. **Fair by construction.** Daily tables come from a hash of the date, practice from a fresh seed, journey/challenges from fixed seeds; the house AI draws its imprecision from a seed-and-shot-count stream, so a replayed session is identical. Rules in: inspectable seeds, no hidden boosts, undo disabled only where the mode is ranked. Rules out: rubber-banding, adaptive difficulty, anything purchasable.

## 3. Player experience

**Target player.** Someone who enjoys pool's feel but has minutes, not hours: short deterministic tables with a par, a clear next stage, and a house opponent that gets better only when they say so.

**First 60 seconds** (a fresh save, `main.ts openPlay` → `openSetup` → `startGame`):
1. Home shows the key-art hero and a dominant **Play** button. Play opens the setup card for journey stage 1, *First Stroke* (3 balls, 5 shots, solo, "No" ranked, hints + undo on) with its intro line: "Pot every ball before you run out of shots. Aim with a drag, set power, and strike."
2. Start lays out the table (rack clatter), the HUD reads "Pot the remaining 3 balls." and it is announced. Legal targets carry a ground ring; the aim guide is already visible at angle 0.
3. The player drags on the cloth (or presses ←/→, or the D-pad), sees the guide swing, presses Shoot/Enter/A. The replay plays with strike, click, cushion and pocket sounds; a Skip replay button (K, right shoulder) appears during it.
4. Any foul toasts "Foul: …" (announced assertively) and, if it granted ball in hand, the Shoot button gives way to a "Place here" flow with a ghost ball.
5. Clearing the table opens the results card once the last replay has played: headline, stars, breakdown, win banner, and **Next** to stage 2. Learn (six lessons that each demand the rule be performed) and Help (six cards, including the controls map) are one tap from home for anyone who wants instruction first.

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
- AI pacing: the session waits 750 ms before each house placement or shot through its `timers` option; the engine client counts them in fixed steps (45 steps at 60 a second), so a session — the house's turns included — replays identically.

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

Actions (`starhermit.txt`; players rebind keys and pads in the runtime's Options › Controls; action names are lower-case, so bindings saved for the browser build's camelCase names are not carried over):

| Action | Keys | Gamepad | Touch / pointer | Feedback |
|---|---|---|---|---|
| `aim_left` / `aim_right` | ←/→ = 8 mrad, with Shift 1 mrad; held keys repeat after 0.4 s, 30 a second (fixed steps) | D-pad / left stick left, right | Drag on the table from anywhere: the aim points from the cue ball to the pointer | Guide line, ghost ring at the first ball hit, cue stick, pocket glow when the guide ends near a pocket, "Aim: x.xx rad · Power n%" readout, tick on release |
| `power_up` / `power_down` | ↑/↓, +/−, Num +/− = 2.5 % (repeat as above) | D-pad / left stick up, down | Power slider 0–100 % (44 px tall) | Percentage label, readout |
| Spin | the spin pad: when focused ←→↑↓ = 10, 0/Home = reset | (pad focus by Tab / D-pad navigation) | Spin pad press or drag | Marker moves, "follow 30, left 20" text and the pad's description |
| `shoot` | Enter, Space (when no button has focus) | A (South) | Shoot button (full width on narrow layouts) | Click, cue strike, replay, controls disabled, Skip replay appears |
| Place (ball in hand) | Tap/click a free spot then "Place here", or `shoot`; `hint` proposes a spot | A places, Y proposes | Same | Ghost cue ball, "Place here", place sound, "Cue ball placed." |
| `hint` | H | Y (North) | Hint button | Bell ping, aim guide moves, toast |
| `undo` | U | X (West) | Undo button | Rewind swish, toast "Shot undone." |
| `skip` | K | Right shoulder | Skip replay button | The replay lands on the exact final state |
| `pause` / `back` | P, Esc; Esc/P resume; Esc closes the objective drawer; Esc on any other screen goes back | Start / B (East) | Pause button | Card with Resume focused |
| Objective drawer | — | — | Objective button (narrow layouts), Close | The rail slides over the screen's side |

Input locking (`main.ts canAct`, `session.js command`): while a shot replays, Shoot/Hint/Undo/Place, the power slider and the spin pad are disabled and shot keys toast "Not legal: shot still resolving"; on the AI's turn the session rejects commands with `not-your-turn`; while paused with `paused`. Each player command carries an action id (`shot-n`, `place-n`) so a repeated commit is rejected as `duplicate-action`. `shoot` yields to a focused button (its own Enter/Space/A activates it), and aim and power keys yield to a focused power slider or spin pad (they keep their arrows); otherwise an aim key moves focus back to the table. The table is a UI region (`ui.widget` role `region`, arrows kept) that takes the drag and the keys and carries the table summary as its description. Hiding the window pauses an active game (`onSuspend`).

## 7. Screens and UI flow

`home → {journey | learn | practice | challenge} → setup → game ⇄ pause card → results card → (setup of next stage | game restart | home)`; `settings` and `help` are reachable from home and (settings) from pause, returning to the screen they came from (`returnScreen`; back in a paused game the pause card shows again). A new screen or card focuses its first control two frames after it opens (Play, the first list card, Start, the theme select, Back, Resume, Retry); the game screen focuses the table.

- **Home:** the key-art hero with the title and tagline, the menu (Play primary), and beside it (wider than 700 px) or below it the player name, the account line, Sign in / Invite a friend and the progress line. Windows under 640 px tall (and phone landscape) show the menu two buttons across and a shorter hero so it fits without scrolling.
- **Lists, setup, settings, help:** content up to 860 px wide on the page colour; content taller than the window scrolls while the footer (Back; Start + Back on setup) stays below it.
- **Game, wide (≥ 1024 px):** top bar (objective, turn, score) over three columns: objective rail 230 px (objective, shots, legal-target chips, simulated table time) · table · action rail 280 px (lesson banner, Pause/Hint/Undo/Skip, power, spin pad, aim readout, Place/Shoot pinned to its bottom; the rest scrolls on short windows).
- **Landscape under 1024 px** (and phone landscape, height ≤ 500 px): the table beside a 280 px (phone landscape 220 px) action column; the objective rail is a drawer (Objective button in the top bar, Close inside).
- **Portrait under 1024 px:** the action rail wraps below the table (buttons, then power and spin side by side, the readout, Shoot full width). On a portrait phone (≤ 700 px) the table keeps an 8:5 aspect and at most 58 % of the height and the tray fills the rest, Shoot at the bottom under the thumb. The top bar wraps to two lines.
- **Left-handed** (Settings) mirrors the rails and the drawer side.
- **Toasts** sit bottom-centre (up to 640 px, wrapped), drawn over everything without taking the pointer, 3.2 s each, at most four.
- **Cards:** pause and results are modal dialogs (nothing behind takes input) up to 480 px wide and 90 % of the height; a taller body scrolls while the buttons stay below it. The results card's win banner shows on a win when the window is at least 560 px tall; its buttons are Retry, Next (the next journey stage, once unlocked) and Home.
- The large-screen zoom of the browser build (`ui-scale.js`) is the runtime's interface size now; safe areas come from the runtime (`frame().safeArea`).
- Must never be cut off: the whole table including all six pockets (the camera pulls back until the cushion corners project inside ±0.94 of the table rectangle, `fitCamera`), the Shoot/Place button, the top-bar objective, the results card.

## 8. Art direction

**Hero.** The table: the only saturated surface in a dark walnut room, lit by one warm key light. UI chrome is matte and recedes.

**Palette** (`tools/ui-style.css`, the old `css/style.css`): background `#14100c`, panels `#1f1a14` / `#2a231b`, ink `#f0e8d8`, dim ink `#b7ab94`, accent (brass) `#e8c46a` with accent ink `#241a08`, danger `#d4634e`, focus ring `#ffd970`, borders `#3a3125`/`#443a2c`. High contrast swaps to `#000000`/`#101010`/`#1a1a1a`, ink `#ffffff`, accent `#ffd700`, focus white. Guide/selection lines are `#fff2b0`. Themes (`content.js THEMES`) recolour cloth/cushion/wood/walls/floor/fog: Tournament Green cloth `#1e6a44` wood `#6e4526`, Midnight Blue `#274b7a`, Oxblood Lounge `#7a2e2e`, Slate Club `#4c5a5e`, Ivory Hall `#8a7f68`. Ball colours: 1/9 `#e8b93c`, 2/10 `#2e5fb8`, 3/11 `#d43b2e`, 4/12 `#6a3d9a`, 5/13 `#e07b28`, 6/14 `#2e7d46`, 7/15 `#8a3b2a`, 8 `#1c1c20`, cue `#f4efe4`.

**Shape language.** Rounded 10–14 px panels, circular target chips and spin pad, a single straight guide line; the 3D room is boxes and cylinders with seeded framed panels on the walls — restrained, never decorative enough to compete with the balls.

**Typography.** The runtime's `system-ui` faces, 16 px base (the runtime's text size and interface size scale it), upper-case rail headings, key badges on Hint, Undo and Shoot showing the player's binding. Symbols the system fonts may lack (★ ☆, the lock, ✓, the trophy) are drawn as glyphs.

**Motion.** Trace playback at 60 Hz sampled frames, one a fixed step; pooled spark bursts on pockets; the camera shake exists for "big" bursts (none are raised today). Reduced motion (the runtime's option) stops sparks, dust motes, the target-ring pulse and shake; Particles Off (Low) drops sparks and motes. Under reduced motion the replay still plays because it conveys the rules outcome. During a replay the aim guide and cue stick are hidden.

**Graphics.** The table scene uses ACES filmic tone mapping, a hemisphere fill, a warm key light whose shadow box is fitted to the table, and on Detailed a soft spot pool over the table so the room falls into shade (three.js's light intensities ÷ π, the engine's units). Image-based lighting (`PMREMGenerator.fromScene(new RoomEnvironment(renderer))`) gives the balls, lacquered rails and diamond sights reflections, with the browser build's per-material `envMapIntensity`. Balls wear an equirectangular skin with the number disc facing up; 9–15 are white with a coloured stripe band; Detailed balls are clear-coated `MeshPhysicalMaterial` on High/Ultra with a soft contact shadow. Detailed also adds procedural wood grain with clear-coat on the rails, mother-of-pearl diamond sights (one instanced draw), leather pocket lips, a plank floor and a theme-coloured rug, and a turned cue (ebony butt, brass joint, maple shaft, ferrule, blue tip). Post effects are the renderer's: `renderer.ao` (GTAO settings of the old pass), `renderer.bloom` (threshold 0.92, so only glints bloom), `renderer.grade` (the old S-curve, +10 % saturation, warm highlights / cool shadows, 0.3 vignette) and `renderer.antialias`. Dust motes drift over the rails (never over the cloth) and legal-target rings breathe. Overlays (aim line, ghost ring, target rings, pocket glow) are not tone-mapped. The menus are UI, so graphics affect only the table.

**Graphics levels** (`native/quality.ts`). The runtime's Options › Graphics own Auto and the level choice, render scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit and readout, and the shadow-map size and MSAA samples per level; the game reads `frame().quality` (the tier) and `frame().levelIndex` and rebuilds the room, table and balls when they change. The browser build's per-category overrides, render-scale slider and GPU summary are not offered. Physics and rules are identical on every level.

| Tier | Shadows | AO | Bloom / grade | AA | Reflections, detail | Particles | Materials | Ball segments / skin | Merged table | Sparks / motes (× up to 4 by level) |
|---|---|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | off | off, plain | off | Lambert | 16 / 256 | yes | 16 / 12 |
| Balanced | 1024² | off | on | FXAA | on, detailed | low | Standard | 24 / 512 | yes | 24 / 20 |
| High | 2048² | on | on | SMAA | on, detailed | high | Physical | 40 / 512 | no | 48 / 48 |
| Ultra | 4096² | high | on | MSAA | on, detailed | high | Physical | 56 / 1024 | no | 64 / 72 |

Within a tier, sparks and motes grow ×1.64 per level above the tier's first (molecular, terrestrial, galactic), at most four times the tier's budget. Felt sheen (three.js `sheen`) has no counterpart on the engine and is left out.

**Visual assets the design calls for** (all shipped, §15): key art behind the home title (`assets/key-art.webp`, a style background with panel-colour fallback; plain panel in high contrast); a felt weave on the cloth tinted by the theme (`assets/cloth.webp`, mirrored-repeat 8×4, flat colour while loading or on failure); a win banner on the results card (`assets/results-clear.webp`, drawn cover-fitted with a panel-colour fallback; win only); cover art (`coverart.png`) derived from the key art.

## 9. Audio direction

**Mix.** No music bed. The runtime's Options › Audio own the volumes (master, music, effects, interface), the mute and the voice limit; the browser build's four gain buses fold into them: its authored clips all played through its effects bus (0.8), so they play on `effects` at 0.8, the UI clicks on `interface`, and the hall room tone (`hall-ambience.opus`, looped from start-up, stopped while the window is hidden) at the old ambience level 0.5 × 0.7 on `effects`. Clips load one at a time once the mixer runs (natively at once, in a browser after the first press) from `sfx/manifest.json`; each event may list several variants and the seeded AV stream (reseeded with the game seed) picks one, so a replayed session sounds the same. The browser build's WebAudio synthesis fallback (played while a clip loaded) is not ported: a clip not loaded yet is silent.

**SFX event table** (source of `sfx/manifest.txt`)

| Event id | File(s) | Sound | Usage |
|---|---|---|---|
| `strike` | cue-strike-soft, cue-strike-hard | Leather tip on phenolic ball, soft tap / sharp crack | Start of every shot replay |
| `ballClick` | ball-click-soft/-medium/-hard | Two resin balls colliding | Physics `hit` events during playback |
| `cushion` | cushion-thump-soft/-hard | Ball into rubber cushion, padded thud | Physics `cushion` events |
| `pocketDrop` | pocket-drop | Hollow knock then rattle into the pocket | Physics `pocket` events, with the spark burst at that pocket |
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
| `ambience` | hall-ambience | Late-night pool hall room tone (10 s loop) | Looped from start-up (once the mixer runs), stopped while hidden |

Every audible cue has a text twin: fouls, hints, undo and group assignment toast; results, pauses and turn changes are announced (`ui.announce`).

## 10. Localization

Nine locales ship: **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**, for every player-facing string — home, lists, setup, settings, help cards, HUD and objective rail, spin/aim readouts, toasts and announcements, results, the table summary, stage/challenge/lesson/practice/achievement/theme names and texts, player names (You, House, Champion), and the StarHermit strings. "Cushion & Cue" stays untranslated; key and gamepad names are the runtime's binding labels.

- **Strings.** Code calls `T('US-English text', { vars })` (`native/i18n.ts` over `js/i18n.js`, global `CQCI18n`); `js/locales/*.js` map that text per language (en-GB lists only its spellings; es-ES and fr-CA only their differences from es-419 and fr-FR). Content tables keep English source text and are translated at display time.
- **Resolution.** The interface language is the runtime's (`preferences().language`: the player's choice in Options › Language, else the account's preferred language or the device's), mapped to the nearest shipped locale (`pickLocale`: en-GB, es-ES, fr-CA by region). The game's own Language selector (`sh-language.js`) and its `ui.language` setting are gone (the old account key is removed on migration).
- **Live switching.** Screens are built every frame, so a language change shows at once everywhere, an open results card and toasts included; the table, a running replay and the session are untouched.
- **Expansion.** Labels too long for their width wrap (paragraphs); button rows wrap.

## 11. Accessibility

- **Keyboard and gamepad:** every screen is reachable by Tab/arrows/D-pad and Enter/Space/A (the runtime's UI focus); on the game screen the table region keeps the arrows for aim and power, Enter shoots or places, H/U/K/P shortcuts, Esc back/close/pause; the spin pad takes arrows and 0/Home while focused. Cards are modal dialogs with Resume/Retry focused on open.
- **Screen readers:** widgets are the runtime's accessibility nodes; announcements go through `ui.announce` (polite: game start, shots, placements, hints, lesson steps, resume, toasts; assertive: fouls, invalid actions, results). The table region's description is the old `#sr-table` summary: objective, turn, score, ball-in-hand, every ball's coarse zone (top/middle/bottom × left/center/right) and legal targets.
- **Contrast and colour:** ink `#f0e8d8` on `#14100c` (≈ 14:1); accent buttons use dark ink; under the runtime's high contrast the style tokens swap to black panels, white ink and a `#ffd700` accent, the balls use their high-contrast colours and the key art gives way to a plain panel. Ball identity is always the printed number plus the target-chip list.
- **Reduced motion, text size, interface size:** the runtime's options (reduced motion stops sparks, motes, ring breathing and shake; text and interface size scale the UI).
- **Targets:** 44 px minimum on buttons, sliders and the name field; the spin pad is 96–120 px.
- **Left-handed** layout (Settings) and "Replay first lesson" are the game's own options.

## 12. StarHermit integration

| Feature | Status |
|---|---|
| Packaging | A script game: `starhermit.txt` (see §1) with one `control.<action>=<Codes> \| <Label>` line per action (`aim_left`, `aim_right`, `power_up`, `power_down`, `shoot`, `hint`, `undo`, `skip`, `pause`, `back`), `engine.gamepad.*` controls and `engine.group.*` headings; `npm run package` (`starhermit package --web .`) writes the loader `index.html` and `starhermit-files.json`; `.starhermitignore` leaves out `tests/`, `tools/`, `server.js`, `spec.md`, `coverart.png` |
| Saves | The progression document (`js/progress.js`, versioned and FNV-checksummed; a corrupt one resets) is the engine save (`starhermit:storage saves`, schema 1): on the device and, signed in, the account's cloud slot. A conflict (another device saved) merges both (`Progress.merge`: better stars per stage and challenge, every lesson / achievement / daily, the larger career pot count, the later last game); an account save that replaced the device's is merged in. The browser build's cloud save (the JS SDK's zipped `save.json` in `game:<slug>`, the same document) shows as foreign: it is merged with the device's progress and replaced once (`saves.save(…, { replaceForeign: true })`). Guests' old browser `localStorage` progress cannot migrate |
| Game options | Theme, left-handed and the offline player name are `starhermit:storage settings` (`game.<key>`, synced with the account). The browser build's per-player account settings (`theme`, `quality`, `gfx`, `gfxV`, `highContrast`, `reducedMotion`, `largerText`, `leftHanded`, `audio`, `name`, `ui.language`) are read once signed in: theme and left-handed carry over unless set since, then all are removed |
| Identity | Signed in: the account's display name replaces the editable name field and the home line reads "Playing as <name> · progress synced / saving… / cloud sync unavailable"; offline: "Offline — progress is stored on this device." and the local name. Signing out toasts that progress stays on the device |
| Sign-in, invite | Offline the home screen offers "Sign in with StarHermit" (`requestSignIn`); signed in, "Invite a friend" copies the invite link (`clipboard`, prefetched) with a toast (the link itself if copying fails) |
| Platform time | The daily's date is the UTC date by `serverNow()` once the platform's clock answered, else the device's |
| Leaderboard | Signed in: every finished table outside Learn and hotseat (Play, Journey, Daily, solo and AI Practice, Challenges) posts its total through `score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': total } }`, as the JS SDK's `submitScores` did; integer, −10,000–10,000) and the results card shows "Leaderboard rank: #N" (or posted / not posted). Offline posts nothing and shows no line |
| Options | The runtime's Options replace `game-options.js`, `ui-scale.js`, `sh-language.js` and the Graphics panel: sound volumes / mute / voice limit, graphics level and frame rate, language, control rebinding, text size, interface size, high contrast, reduced motion; Settings links to them ("Open Options"). Bug and crash reports are the runtime's |
| Achievements | Six stable lowercase keys unlocked idempotently in the save; the game's server reports no platform achievements |
| Sessions, matchmaking, chat, voice, realtime, replays | Not used: solo/hotseat game. Replay envelopes are built locally (`session.getReplay()`) but not transmitted |

## 13. Technical architecture

- **Module contract.** `rng` → `rules` → `content` → `session` → `progress` (and `locales` → `i18n`) are UMD scripts shared unchanged by Node (tests, `server.js`) and the engine (`loadClassic` in `native/classic.ts`); the engine client never touches rules state except through `session.command/undo/hint` and reads snapshots and traces for drawing.
- **Determinism and replay.** Fixed step, integer inputs, quantized outputs (`q6`/`q9`), stable collision order, no `Date.now()` in rules; the session records `{schemaVersion 1, contentVersion, seed, initialHash, commands, stateHashes, terminal{reason, winner, finalHash}}` and `tests/run-tests.js` proves identical hash chains for the same seed and commands. On the engine the runtime's fixed steps (60 a second, `setFixedRate(60)`) drive everything time-based: a shot's replay advances one 60 Hz trace frame a step and fires its physics events on the step their tick is reached; the house's 750 ms pacing and the achievement chime are step timers; held aim and power keys repeat on steps. The play scripts, planned in Node by the same rules (`tools/plan.mjs`), therefore replay exactly.
- **Phase model** (`session.js`): `preparing → active ↔ paused → resolving → results`; a trace that finishes while paused is settled on resume exactly once; pausing clears AI timers. The session emits `results` when the last shot is taken and again when its replay settles; the client records the game once (the browser build recorded it twice, counting career pots double) and opens the results card when the replay has played.
- **Rendering.** `native/render.ts` builds the scene once and rebuilds the room, table and balls on a level, theme or contrast change; the camera's view offset (`setViewOffset(rectW, rectH, -x, -y, W, H)`) puts the table's image in its rectangle; picking casts `pointerToNdc` through the camera onto the cloth plane; `renderer.camera` is null outside the game so the menus draw no 3D.
- **Budgets.** One draw call per ball plus ring/shadow, one instanced draw for sparks and sights, one shadow map. Physics: ≤ 2400 ticks × 16 balls per shot, solved synchronously when the shot is taken.

## 14. Testing and acceptance criteria

`npm test` runs:
- `tests/run-tests.js` (2 867 assertions): RNG determinism and stream independence; `createGame` for every layout; every `INVALID` reason reachable; the four fouls; clearance endings and score components; 8-ball group assignment, turn passing, 8-early/8-scratch/clean-8/resign; serialize round-trip and version rejection; replay hash chains; AI shots legal and NaN-free over 30 seeds; every journey stage, challenge and lesson legal and solvable inside its shot limit by `tests/solver.js`; daily determinism and ranked no-undo; achievement keys; session phases, double-commit rejection, undo, lesson progression, replay envelope, pause-during-resolve settling once.
- `tests/progress.test.mjs`: the save seals, round-trips and refuses tampering, garbage and other versions; the browser build's cloud `save.json` parses and merges; recording keeps the best stars and unlocks lessons, dailies and achievements once; unlocks, the Play stage and the home summary; which modes post to the leaderboard; the old account settings' mapping; the session's AI pacing on injected timers.
- `tests/i18n.test.mjs`: every `T`/`N` key in `native/*.ts` and every content display field exists in all nine locales with the same placeholders, and no locale carries stale keys.
- `tests/native.mjs`: the web index is up to date, `tsc` (TypeScript 5.9, no `skipLibCheck`), `starhermit check .` with zero warnings, and every `tests/native/*.play` as a guest `--render-check` run driving the real UI: `screens.play` (the name typed, Journey with stage 2 locked, Learn, Practice setup, Challenges, Help, Settings with the theme and left-handed changed, the Daily started, Hint, Shoot, Skip replay, the objective drawer, Pause → Settings → Back → Restart, Escape, Leave game), `journey-stage.play` (stages 1 and 2 cleared through Play and Next, the totals and First Clear on the results card, the home progress line), `learn-lessons.play` (all six lessons to "Lesson complete!", spin set on the spin pad), `house-final.play` (the 8-ball challenge against the champion to its result). The generated scripts come from `npm run plays`.

`npm run test:browser` (`tools/browser-play.mjs`) serves the packaged folder on loopback and plays it in Chrome on the machine's GPU (`~/games/tools/gpu-chrome.mjs`) at 1366×768, 390×844 (touch, DPR 2) and 844×390: start, Journey / Help / Settings on the phone, a table started by keys, a hinted shot by keys on the desktop, a drag aim and the Shoot and Pause buttons tapped on the phones; it fails on console errors or warnings or the runtime's error screen. `node ~/games/tools/engine-web-smoke.mjs .` checks the start at desktop and phone.

QA bar as checkable statements: the first stage's setup intro and the HUD objective tell a new player what to do; Learn lessons require each rule to be performed; every feature (all six modes, hotseat, settings, drawer, pause, undo, hint, place) is reachable by visible controls; no console errors or warnings in the browser runs; nothing is clipped at 1366×768, 960×540, 390×844 portrait or 844×390 landscape; all cues have text equivalents.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/key-art.webp` (1280×720, 37 KB) | Home hero backdrop; base of the cover | FLUX.2 klein, seed 7201, 1536×864, 28 steps | wired (`.home-hero` style background) |
| `assets/results-clear.webp` (1024×448, 13 KB) | Win banner on the results card | FLUX.2 klein, seed 7202, 28 steps | wired (results card banner) |
| `assets/cloth.webp` (512×512, 84 KB) | Felt weave tinted by theme cloth colour | FLUX.2 klein, seed 7203, levels-normalised to light grey | wired (`native/render.ts` cloth material map) |
| `coverart.png` (1200×675, 389 KB) | Store cover: key art + title/tagline (ffmpeg drawtext, DejaVu) | derived from key-art seed 7201 | replaced in this pass (previous file was a generic template) |
| `icon.png` | Platform icon | hand-authored PNG | shipped |
| `sfx/cue-strike-*.opus`, `ball-click-*.opus`, `cushion-thump-*.opus`, `pocket-drop.opus`, `foul-buzz.opus`, `ui-click.opus`, `ui-confirm.opus`, `turn-chime.opus`, `hint-beep.opus`, `win-fanfare.opus`, `lose-fanfare.opus` (15) | Core impacts, UI, chimes, fanfares | MOSS-SoundEffect v2.0, 100 steps | shipped |
| `sfx/rack-setup.opus`, `cue-place.opus`, `groups-set.opus`, `undo-rewind.opus`, `achievement-sparkle.opus`, `hall-ambience.opus` (6) | Game start, placement, groups, undo, achievement, ambience loop | MOSS-SoundEffect v2.0, 100 steps | generated in this pass, wired |
| `sfx/manifest.txt` / `manifest.json` / `manifest.md` | Canonical manifest / loader+generator manifest / generator report | authored / tool output | shipped, in sync (21 entries each) |
| 3D models / character animation | None: the table, balls and cue are procedural scene primitives and there is no humanoid | — | not required |

## 16. Known limitations

- No `knownissues.md` exists for this game.
- Themes list `unlockStars` but the Settings menu does not gate them; unlock values are informational. Content themes on stages and dailies are not applied (the table uses the Settings theme), as in the browser build.
- The 8-ball house AI never uses spin and plays no safeties beyond rolling into the nearest legal ball; at skill ≥ 0.8 it is accurate but tactically naive.
- Ball-in-hand after a foul allows placement anywhere on the table (no behind-the-head-string rule), including in 8-ball after the break.
- Physics is a 2D disc model: no jump, massé, throw or cloth nap; side spin acts only at cushion contact and follow/draw only at the first contact.
- Hotseat 8-ball shows "Turn: Player 1/2" but both players share the same hint, undo and score display; scoring is per table, not per player (an 8-ball loss still shows the table's pots and win bonus).
- During a replay the HUD already shows the shot's outcome (score, shots, ball in hand), as the browser build did.
- `server.js` sessions are in-memory only and the client does not use them.
- Bindings players saved for the browser build's camelCase action names do not carry over (actions are lower-case now); guests' browser-only progress cannot migrate.
- Felt sheen and the browser build's per-category graphics overrides are not available on the engine (see §8).

## 17. Design intent not yet implemented

- A per-day daily leaderboard and achievement submission through the StarHermit API, with the replay envelope attached to each ranked score.
- Theme unlocks by star count, surfaced in Settings.
- Hosted matches (invitations, reconnect) on top of the existing `server.js` session API.
- Per-player score in hotseat and a behind-the-head-string placement rule after a break foul.

## Directional consistency

Positive table Y is toward the top of the screen. Left turns aim counter-clockwise, Right clockwise; Up/Down raise/lower shot power. Pointer aiming and placement cast the pointer onto the cloth through the same camera.
