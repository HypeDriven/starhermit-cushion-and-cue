// The browser build's DOM shell (index.html + css/style.css, built by
// js/ui.js) as starhermit:ui, built every frame: home (the key-art hero, the
// menu, the player name, account line, sign-in / invite and progress), the
// Journey, Learn, Practice and Challenges lists, the setup card, Settings
// (the game's own options: theme, left-handed layout, the first lesson
// again; everything else is the runtime's Options), Help, and the game
// screen — the top bar (objective, turn, score), the objective rail
// (objective, shots, the legal-target chips, simulated table time), the
// table between the rails (render.ts draws it there; the table area is a
// region taking the drag), the action rail (lesson banner, Pause / Hint /
// Undo / Skip replay, the power slider, the spin pad, the aim readout,
// Place here / Shoot), the pause and results cards and the toasts. The
// browser's media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: three columns), narrow (the action rail below the table,
// the objective rail a drawer), portrait phone (≤ 700 px: the table at most
// 58 % of the height above the thumb tray) and short landscape (≤ 500 px
// tall: the table beside a 220 px action column); left-handed mirrors the
// rails and the drawer. Symbols the system fonts may lack (★ ☆ 🔒 ✓ 🏆 ⏎)
// are drawn.
import { clipboard, frame, openMenu } from "starhermit:engine";
import { bindingLabel, bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { requestSignIn } from "starhermit:platform";
import * as audio from "./audio.ts";
import { Content, Progress, Rules, type State } from "./classic.ts";
import { T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  aim, app, doHint, doUndo, goBack, keepsArrows, lessonEvent, lessonText, mirrorText, nextStage, objectiveText,
  openDaily, openHelp, openLesson, openPlay, openPractice, openSettings, openSetup, pauseGame, pauseToSettings, pendingConfig,
  pendingMode, placePoint, quitToHome, replaying, restartGame, resultsHeadline, resumeGame, retryGame, sess, setPower, setSpin,
  showScreen, skipReplay, startGame, tablePointer, toggleDrawer, tryPlace, tryShoot, turnText, settings,
} from "./main.ts";
import { COLORS, COLORS_HC } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; wide: boolean; phone: boolean; shortLand: boolean; narrowMenu: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const shortLand = lw > lh && lh <= 500;
  return { lw, lh, sc, ox: sa.left, oy: sa.top, wide: lw >= 1024 && !shortLand, phone: lw <= 700 && lh >= lw, shortLand, narrowMenu: lw <= 700 };
}
const colors = (): typeof COLORS => (ui.preferences().highContrast ? COLORS_HC : COLORS);
const hexCss = (c: number): string => "#" + (c >>> 0).toString(16).padStart(6, "0");
const lastHeight = new Map<string, number>();
function textWidth(text: string, style: string | readonly string[], kind?: "button"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: typeof style === "string" ? style : [...style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls: string | readonly string[] = "body", id?: string): void {
  if (!text) return;
  const styles = typeof cls === "string" ? [cls] : [...cls];
  let u = ui.style(...styles);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: styles }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, width);
}
interface Btn { id: string; text: string; style?: string[]; disabled?: boolean; act: () => void; kbd?: string; silent?: boolean }
const PLAIN = ["btn"];
/** A button's width: a plain one as the button measures it; with a key badge, its face (label, 6 px, badge with its 5 px padding and border) inside the button's padding and border. */
function buttonWidth(b: Btn): number {
  const style = b.style ?? PLAIN;
  if (!b.kbd) return textWidth(b.text, style, "button") + 4;
  const pad = style.includes("btn-small") ? 10 : style.includes("btn-big") ? 26 : 18;
  return textWidth(b.text, faceStyle(style)) + 6 + textWidth(b.kbd, "kbd") + 12 + pad * 2 + 2 + 4;
}
/** The text classes of a button's face (its label beside a key badge, or a wrapped label). */
function faceStyle(style: readonly string[]): string[] {
  return [style.includes("btn-primary") ? "btn-label-primary" : "btn-label", ...(style.includes("btn-big") ? ["btn-label-big"] : style.includes("btn-small") ? ["btn-label-small"] : [])];
}
/** A button `width` wide (null: its text's); a label too long for it wraps inside; `kbd` adds a key badge. */
function button(b: Btn, width: number | null = null): boolean {
  const style = b.style ?? PLAIN;
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (b.kbd) {
    opts.content = () => {
      ui.row(`${b.id}-face`, () => {
        ui.style(...faceStyle(style)).label(b.text);
        ui.style("kbd").label(b.kbd!);
      }, { spacing: 6, align: "center" });
    };
  } else if (width != null && buttonWidth(b) > width) {
    const inner = width - 40;
    opts.content = () => { ui.style(...faceStyle(style), { text: { align: "center" } }).paragraph(b.text, inner); };
  }
  if (ui.style(...style, s).id(b.id).button(b.text, opts)) {
    if (!b.silent) audio.cue("uiClick");
    b.act();
    return true;
  }
  return false;
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b) > width ? width : null);
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, width });
}
const keyName = (action: string): string => bindingLabel(action) || "—";
function keysFor(action: string): string {
  return bindings(action).filter((b) => b.device === "keyboard").map((b) => b.label).join(" / ") || "—";
}
const padFor = (action: string): string => bindings(action).filter((b) => b.device === "gamepad").map((b) => b.label).join(" / ") || "—";

// ------------------------------------------------------------------ glyphs
function starPts(cx: number, cy: number, r: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}
type Glyph = "star" | "star-empty" | "lock" | "check" | "trophy";
function drawGlyph(kind: Glyph, cx: number, cy: number, s: number, color: string): void {
  const lw = Math.max(1.2, s * 0.16);
  if (kind === "star") draw.polygon(starPts(cx, cy, s), color);
  else if (kind === "star-empty") {
    const p = starPts(cx, cy, s);
    for (let i = 0; i < p.length; i++) { const a = p[i]!, b = p[(i + 1) % p.length]!; draw.line(a[0], a[1], b[0], b[1], color, Math.max(1, s * 0.12)); }
  } else if (kind === "lock") {
    draw.strokeArc(cx, cy - s * 0.2, s * 0.42, Math.PI, 2 * Math.PI, color, lw);
    draw.line(cx - s * 0.42, cy - s * 0.2, cx - s * 0.42, cy + s * 0.05, color, lw);
    draw.line(cx + s * 0.42, cy - s * 0.2, cx + s * 0.42, cy + s * 0.05, color, lw);
    draw.roundRect(cx - s * 0.65, cy, s * 1.3, s * 0.95, s * 0.15, color);
  } else if (kind === "check") {
    draw.line(cx - s * 0.6, cy, cx - s * 0.15, cy + s * 0.5, color, lw * 1.4);
    draw.line(cx - s * 0.15, cy + s * 0.5, cx + s * 0.65, cy - s * 0.5, color, lw * 1.4);
  } else {
    // a cup: bowl, handles, stem and base
    draw.polygon([[cx - s * 0.55, cy - s * 0.75], [cx + s * 0.55, cy - s * 0.75], [cx + s * 0.4, cy - s * 0.05], [cx, cy + s * 0.2], [cx - s * 0.4, cy - s * 0.05]], color);
    draw.strokeArc(cx - s * 0.55, cy - s * 0.45, s * 0.25, Math.PI * 0.5, Math.PI * 1.5, color, lw);
    draw.strokeArc(cx + s * 0.55, cy - s * 0.45, s * 0.25, -Math.PI * 0.5, Math.PI * 0.5, color, lw);
    draw.rect(cx - s * 0.08, cy + s * 0.15, s * 0.16, s * 0.4, color);
    draw.roundRect(cx - s * 0.4, cy + s * 0.5, s * 0.8, s * 0.25, s * 0.08, color);
  }
}
/** Glyphs in a row as one widget, `size` logical pixels each (`label` empty: decorative). */
function glyphs(label: string, kinds: Glyph[], size: number, color: string | ((g: Glyph) => string), gap = 3): void {
  if (!kinds.length) return;
  ui.widget(label, {
    role: label ? "image" : "none", size: { width: kinds.length * size + (kinds.length - 1) * gap, height: size },
    draw: (r) => {
      const k = r.height / size;
      kinds.forEach((g, i) => drawGlyph(g, r.x + (i * (size + gap) + size / 2) * k, r.y + r.height / 2, (size / 2) * k * 0.9, typeof color === "string" ? color : color(g)));
    },
  });
}
function starGlyphs(n: number): Glyph[] { return [0, 1, 2].map((i) => (i < n ? "star" : "star-empty")); }

// ------------------------------------------------------------------ the frame
function firstFocus(): string | null {
  if (app.overlay === "pause") return "btn-resume";
  if (app.overlay === "results") return "btn-retry";
  switch (app.screen) {
    case "home": return "btn-play";
    case "journey": return "journey-0";
    case "learn": return `lesson-${Content.LESSONS[0]!.id}`;
    case "practice": return `practice-${Content.PRACTICE[0]!.id}`;
    case "challenge": return `challenge-${Content.CHALLENGES[0]!.id}`;
    case "setup": return "setup-start";
    case "settings": return "set-theme";
    case "help": return "btn-help-back";
    case "game": return keepsArrows.table || null;
    default: return null;
  }
}

export function drawScreens(): void {
  const L = layoutNow();
  if (app.focusNext && frame().frame - app.openedFrame >= 2) {
    const first = firstFocus();
    if (first) ui.setFocus(first);
    app.focusNext = false;
  }
  if (app.screen === "game" && sess) gameScreen(L);
  else {
    render.setView(null, frame().width, frame().height);
    switch (app.screen) {
      case "home": homeScreen(L); break;
      case "journey": journeyScreen(L); break;
      case "learn": learnScreen(L); break;
      case "practice": practiceScreen(L); break;
      case "challenge": challengeScreen(L); break;
      case "setup": setupScreen(L); break;
      case "settings": settingsScreen(L); break;
      case "help": helpScreen(L); break;
      default: homeScreen(L); break;
    }
  }
  toasts(L);
}

// ------------------------------------------------------------------ pages
/** A screen: content up to 860 px wide on the page colour, scrolling when taller than the window;
 * `footer` (Back, Start) stays below the scrolling part. */
function page(key: string, L: Layout, body: (w: number) => void, footer?: (w: number) => void): void {
  const padX = L.narrowMenu ? 16 : 20;
  const w = Math.max(200, Math.min(860, L.lw - padX * 2));
  const padY = L.shortLand ? 12 : 24;
  const fH = footer ? (lastHeight.get(`${key}:f`) ?? 56) + 12 : 0;
  const room = Math.max(80, L.lh - padY * 2 - fH);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  ui.place(`scr-${key}`, { anchor: "top-start", x: 0, y: 0 }, () => {
    const inside = (ww: number): void => {
      const r = ui.column(`${key}-body`, () => body(ww), { width: ww, spacing: 12 });
      lastHeight.set(`${key}:b`, r.height / L.sc);
    };
    if (bh > room + 1) ui.scrollArea(`${key}-scroll`, { width: w + 16, height: room }, () => inside(w - 4), { padding: { start: 4, end: 12 } });
    else inside(w);
    if (footer) {
      const r = ui.column(`${key}-foot`, () => footer(w), { width: w, spacing: 8 });
      lastHeight.set(`${key}:f`, r.height / L.sc);
    }
  }, { style: "screen", width: L.lw, height: L.lh, align: "center", spacing: 12, padding: { top: padY, bottom: padY } });
}
function h2(text: string, id: string): void { ui.style("h2").id(id).heading(text); }
const backBtn = (key: string): ((w: number) => void) => () => { button({ id: `btn-${key}-back`, text: T("Back"), act: goBack }); };

// ------------------------------------------------------------------ home
function accountLine(): string {
  if (!platform.signedIn()) return T("Offline — progress is stored on this device.");
  const sync = platform.syncState();
  return `${T("Playing as {name}", { name: platform.displayName() || "…" })} · ${sync === "synced" ? T("progress synced") : sync === "saving" ? T("saving…") : T("cloud sync unavailable")}`;
}
let nameDraft: string | null = null;
function homeScreen(L: Layout): void {
  page("home", L, (w) => {
    const hc = ui.preferences().highContrast;
    const heroCls = [hc ? "home-hero-plain" : "home-hero", ...(L.narrowMenu ? ["home-hero-compact"] : [])];
    ui.column("home-hero", () => {
      ui.row("home-title", () => {
        ui.style("h1").heading("Cushion");
        ui.style("amp").label("&");
        ui.style("h1").label("Cue");
      }, { spacing: 12, align: "center" });
      para(T("An intimate cue hall. Aim, spin, and clear the table."), w - 60, "tagline", "tagline");
    }, { style: heroCls, width: w, height: L.narrowMenu ? 160 : L.shortLand || L.lh < 640 ? 150 : 220, justify: "end", spacing: 6 });
    const side = (sw: number): void => {
      if (platform.signedIn()) {
        para(`${T("Player name")}: ${platform.displayName() || "…"}`, sw, "body", "profile-line");
      } else {
        ui.row("profile-row", () => {
          ui.style("body").label(T("Player name"));
          if (nameDraft === null) nameDraft = settings.name;
          nameDraft = ui.style("field").textField("profile-name", nameDraft, { maxChars: 24, width: Math.min(220, sw - 120) });
          if (!ui.capturingKeys() && nameDraft !== settings.name) {
            const v = nameDraft.trim() || T("Guest");
            platform.setSetting("name", v);
            nameDraft = v;
          }
        }, { spacing: 10, align: "center" });
      }
      para(accountLine(), sw, "muted", "account-line");
      const acct: Btn[] = [];
      if (!platform.signedIn()) acct.push({ id: "btn-signin", text: T("Sign in with StarHermit"), style: ["btn", "btn-ghost"], act: () => { void requestSignIn().catch(() => undefined); } });
      const link = platform.inviteLink();
      if (link) {
        acct.push({
          id: "btn-invite", text: T("Invite a friend"), style: ["btn", "btn-ghost"],
          act: () => {
            try { clipboard.writeText(link); toastNow(() => T("Invite link copied to the clipboard.")); }
            catch { toastNow(() => T("Could not copy — invite link: {link}", { link })); }
          },
        });
      }
      if (acct.length) flow("platform-row", acct, sw);
      const s = Progress.summary(platform.save());
      para(T("Journey {done}/36 · {stars} stars · career pots {pots}", s), sw, "muted", "home-progress");
    };
    const menu = (mw: number): void => {
      ui.column("home-menu", () => {
        const items: Btn[] = [
          { id: "btn-play", text: T("Play"), style: ["btn", "btn-primary", "btn-big"], act: openPlay },
          { id: "btn-daily", text: T("Daily Challenge"), act: openDaily },
          { id: "btn-journey", text: T("Journey"), act: () => showScreen("journey") },
          { id: "btn-learn", text: T("Learn"), act: () => showScreen("learn") },
          { id: "btn-practice", text: T("Practice"), act: () => showScreen("practice") },
          { id: "btn-challenge", text: T("Challenges"), act: () => showScreen("challenge") },
          { id: "btn-settings", text: T("Settings"), style: ["btn", "btn-ghost"], act: openSettings },
          { id: "btn-help", text: T("Help"), style: ["btn", "btn-ghost"], act: openHelp },
        ];
        if (L.shortLand || L.lh < 640) {
          // short windows (phone landscape, small desktop windows): two across so the menu fits
          const cw = (mw - 8) / 2;
          items[0]!.style = ["btn", "btn-primary"];
          for (let i = 0; i < items.length; i += 2) ui.row(`home-menu-${i}`, () => { for (const b of items.slice(i, i + 2)) button(b, cw); }, { spacing: 8 });
        } else for (const b of items) button(b, mw);
      }, { spacing: 8, width: mw });
    };
    if (!L.narrowMenu) {
      const mw = Math.min(340, (w - 32) * 0.45);
      ui.row("home-cols", () => {
        menu(mw);
        ui.column("home-side", () => side(w - mw - 32), { spacing: 10, width: w - mw - 32 });
      }, { spacing: 32, align: "start", width: w });
    } else {
      menu(Math.min(340, w));
      side(w);
    }
  });
}

// ------------------------------------------------------------------ lists
/** A list card: the name (bold), a second line, and stars / a lock / a check at the end. */
function cardButton(id: string, label: string, name: string, sub: string, mark: Glyph[] | null, w: number, disabled: boolean, act: () => void): void {
  const c = colors();
  const markW = mark ? mark.length * 14 + (mark.length - 1) * 3 : 0;
  const subW = Math.min(textWidth(sub, "card-sub") + 2, w * 0.45);
  const nameW = Math.max(60, w - 30 - subW - markW - 24);
  const clicked = ui.style("card-btn", { width: w }).id(id).button(label, {
    disabled,
    content: () => {
      ui.row(`${id}-face`, () => {
        para(name, nameW, "card-name");
        ui.spacer();
        if (sub) para(sub, subW, "card-sub");
        if (mark) glyphs("", mark, 14, (g) => (g === "lock" || g === "star-empty" ? c.dim : c.accent));
      }, { spacing: 12, align: "center", width: w - 30 });
    },
  });
  if (clicked) { audio.cue("uiClick"); act(); }
}
function journeyScreen(L: Layout): void {
  const save = platform.save();
  page("journey", L, (w) => {
    h2(T("Journey"), "journey-title");
    para(T("Thirty-six stages. Earn stars to unlock the next table."), w, "muted", "journey-blurb");
    ui.column("journey-list", () => {
      Content.JOURNEY.forEach((j, i) => {
        const stars = save.journeyStars[j.id] ?? 0;
        const unlocked = Progress.journeyUnlocked(save, i);
        const name = `${i + 1}. ${T(j.name)}`;
        const sub = (j.ruleset === "eightball" ? T("8-ball match") : T("{balls} balls · {shots} shots", { balls: j.ballNumbers!.length, shots: j.shotLimit! })) + (j.mastery ? " · " + T("Mastery") : "");
        const label = `${name}, ${unlocked ? T("{n} of 3 stars", { n: stars }) : T("Locked")}`;
        cardButton(`journey-${i}`, label, name, sub, unlocked ? starGlyphs(stars) : ["lock"], w, !unlocked, () => openSetup(j, { kind: "journey" }));
      });
    }, { spacing: 8, width: w });
  }, backBtn("journey"));
}
function learnScreen(L: Layout): void {
  const save = platform.save();
  page("learn", L, (w) => {
    h2(T("Learn"), "learn-title");
    para(T("Six short lessons. Each asks you to perform the rule yourself."), w, "muted", "learn-blurb");
    ui.column("lesson-list", () => {
      for (const l of Content.LESSONS) {
        const done = !!save.lessonsDone[l.id];
        cardButton(`lesson-${l.id}`, T(l.title) + (done ? `, ${T("Completed")}` : ""), T(l.title), T("{n} steps", { n: l.steps.length }), done ? ["check"] : null, w, false, () => openLesson(l));
      }
    }, { spacing: 8, width: w });
  }, backBtn("learn"));
}
function practiceScreen(L: Layout): void {
  page("practice", L, (w) => {
    h2(T("Practice"), "practice-title");
    para(T("Unranked. Undo and hints are on; nothing here affects your rating."), w, "muted", "practice-blurb");
    ui.column("practice-list", () => {
      for (const p of Content.PRACTICE) {
        const sub = p.ruleset === "eightball" ? T("8-ball") : T("{balls} balls · {shots} shots", { balls: p.nBalls!, shots: p.shotLimit! });
        cardButton(`practice-${p.id}`, T(p.name), T(p.name), sub, null, w, false, () => openPractice(p.id));
      }
    }, { spacing: 8, width: w });
  }, backBtn("practice"));
}
function challengeScreen(L: Layout): void {
  const save = platform.save();
  page("challenge", L, (w) => {
    h2(T("Challenges"), "challenge-title");
    para(T("Fixed seeds, constrained goals. No undo on the clock."), w, "muted", "challenge-blurb");
    ui.column("challenge-list", () => {
      for (const c of Content.CHALLENGES) {
        const stars = save.journeyStars["ch:" + c.id] ?? 0;
        cardButton(`challenge-${c.id}`, `${T(c.name)}, ${T("{n} of 3 stars", { n: stars })}`, T(c.name), T(c.blurb ?? ""), starGlyphs(stars), w, false, () => openSetup(c, { kind: "challenge" }));
      }
    }, { spacing: 8, width: w });
  }, backBtn("challenge"));
}

// ------------------------------------------------------------------ setup
function setupScreen(L: Layout): void {
  const cfg = pendingConfig;
  if (!cfg) { showScreen("home"); return; }
  page("setup", L, (w) => {
    h2(cfg.date ? T("Daily — {date}", { date: cfg.date }) : cfg.name ? T(cfg.name) : T("Set up"), "setup-title");
    const rules = cfg.ruleset === "eightball"
      ? T("8-ball: pot your group, then the 8. Fouls give ball in hand.")
      : cfg.shotLimit
        ? T(cfg.blackLast ? "Clearance: pot every ball (black last) within {n} shots." : "Clearance: pot every ball within {n} shots.", { n: cfg.shotLimit })
        : T(cfg.blackLast ? "Clearance: pot every ball (black last)." : "Clearance: pot every ball.");
    const duration = cfg.ruleset === "eightball" ? T("5–10 minutes") : (cfg.shotLimit || 8) <= 6 ? T("1–2 minutes") : T("2–4 minutes");
    const ai = cfg.players?.find((p) => p.ai);
    const players = cfg.ruleset === "eightball" ? (ai ? T("You vs {name}", { name: T(ai.name) }) : T("2 players (hotseat)")) : T("Solo");
    const mech = { undo: true, hint: true, ...(cfg.mechanics ?? {}) };
    const facts: [string, string][] = [
      [T("Rules"), rules], [T("Expected duration"), duration], [T("Players"), players],
      [T("Ranked"), cfg.kind === "daily" ? T("Yes (daily ranking)") : T("No")],
      [T("Assists"), (mech.hint ? T("Hints") : T("No hints")) + " · " + (mech.undo && cfg.kind !== "daily" ? T("Undo") : T("No undo"))],
    ];
    const fw = Math.min(480, w);
    const dtW = L.narrowMenu ? 110 : 140;
    ui.column("setup-facts", () => {
      facts.forEach(([dt, dd], i) => {
        ui.row(`fact-${i}`, () => {
          ui.column(`fact-${i}-dt`, () => para(dt, dtW, "setup-dt"), { width: dtW });
          ui.column(`fact-${i}-dd`, () => para(dd, fw - dtW - 40, "setup-dd", `setup-dd-${i}`), { width: fw - dtW - 40 });
        }, { style: "setup-fact", width: fw, spacing: 12, align: "start" });
      });
    }, { spacing: 8, width: fw });
    const intro = cfg.intro ? T(cfg.intro) : cfg.blurb ? T(cfg.blurb) : "";
    if (intro) para(intro, Math.min(w, 640), "setup-intro", "setup-intro");
  }, (w) => {
    flow("setup-actions", [
      { id: "setup-start", text: T("Start"), style: ["btn", "btn-primary"], act: () => startGame(cfg, pendingMode) },
      { id: "btn-setup-back", text: T("Back"), act: goBack },
    ], w);
  });
}

// ------------------------------------------------------------------ settings
function settingsScreen(L: Layout): void {
  page("settings", L, (w) => {
    h2(T("Settings"), "settings-title");
    const fw = L.narrowMenu ? w : Math.min(w, 520);
    ui.column("set-display", () => {
      ui.style("legend").label(T("Display"));
      ui.row("set-theme-row", () => {
        ui.style("body").label(T("Theme"));
        ui.spacer();
        const idx = Math.max(0, Content.THEMES.findIndex((t) => t.id === settings.theme));
        const next = ui.style({ width: Math.min(240, fw * 0.6) }).id("set-theme").select(T("Theme"), idx, Content.THEMES.map((t) => T(t.name)));
        if (next !== idx) { platform.setSetting("theme", Content.THEMES[next]!.id); render.setTheme(Content.themeById(settings.theme)); }
      }, { width: fw - 30, align: "center", spacing: 10 });
      const lh = ui.id("set-lefthand").checkbox(T("Left-handed controls"), settings.leftHanded);
      if (lh !== settings.leftHanded) { audio.cue("uiClick"); platform.setSetting("leftHanded", lh); }
    }, { style: "fieldset", width: fw, spacing: 10 });
    ui.column("set-learning", () => {
      ui.style("legend").label(T("Learning"));
      button({ id: "set-tutorial", text: T("Replay first lesson"), act: () => openLesson(Content.LESSONS[0]!) });
    }, { style: "fieldset", width: fw, spacing: 10 });
    // Volumes, mute, graphics, language, key bindings, text size, contrast and reduced motion are the runtime's Options.
    para(T("Sound, graphics, language, controls, text size, high contrast and reduced motion are in the StarHermit Options."), fw, "muted", "options-note");
    button({ id: "btn-options", text: T("Open Options"), act: () => openMenu() });
  }, backBtn("settings"));
}

// ------------------------------------------------------------------ help
function helpScreen(L: Layout): void {
  page("help", L, (w) => {
    h2(T("How to play"), "help-title");
    const cards: [string, string[]][] = [
      [T("Controls"), [
        `${keysFor("aim_left")} / ${keysFor("aim_right")} ${T("fine aim (hold Shift for finer)")}`,
        `${keysFor("power_up")} / ${keysFor("power_down")} ${T("power")}`,
        `${keysFor("shoot")} ${T("shoot (or place, when ball in hand)")}`,
        `${keyName("hint")} ${T("hint")} · ${keyName("undo")} ${T("undo")} · ${keyName("pause")}/${keyName("back")} ${T("pause")} · ${keyName("skip")} ${T("Skip replay")}`,
        T("Drag on the table to aim; tap a free spot to place the cue ball."),
        `Tab ${T("reaches every control.")}`,
        T("Gamepad: {aim} aim and power, {shoot} shoot or place, {hint} hint, {undo} undo, {skip} skip replay, {pause} pause.", {
          aim: ["aim_left", "aim_right", "power_up", "power_down"].map((a) => padFor(a).split(" / ")[0]).join("/"), shoot: padFor("shoot"), hint: padFor("hint"), undo: padFor("undo"), skip: padFor("skip"), pause: padFor("pause"),
        }),
      ]],
      [T("Clearance"), [T("Pot every ball before your shots run out. Where the black is marked \"last\", potting it early loses the round.")]],
      [T("8-ball"), [T("The table is open until someone pots legally — that group (solids or stripes) becomes theirs. Clear your group, then the 8. Potting the 8 early, or scratching on the 8, loses.")]],
      [T("Fouls"), [T("Cue ball potted (scratch)"), T("No ball contacted"), T("Wrong ball hit first"), T("No cushion after contact"), T("A foul costs 75 points and gives ball in hand.")]],
      [T("Spin"), [T("Follow (top spin) pushes the cue ball on after contact; draw pulls it back. Side spin kicks it sideways off cushions.")]],
      [T("Scoring"), [T("+100 per pot, +500 win bonus, +50 per unused shot, −75 per foul. Three stars at par or better, two within two shots of par.")]],
    ];
    const cols = Math.max(1, Math.floor((w + 12) / (240 + 12)));
    const cw = (w - 12 * (cols - 1)) / cols;
    for (let i = 0; i < cards.length; i += cols) {
      ui.row(`help-row-${i}`, () => {
        for (let k = i; k < Math.min(cards.length, i + cols); k++) {
          const [title, lines] = cards[k]!;
          ui.column(`help-card-${k}`, () => {
            ui.style("h3").label(title);
            const bullets = lines.length > 1 && k !== 4;
            lines.forEach((ln, j) => {
              if (bullets && !(k === 3 && j === lines.length - 1)) para(`• ${ln}`, cw - 30, "body", `help-${k}-${j}`);
              else para(ln, cw - 30, "body", `help-${k}-${j}`);
            });
          }, { style: "help-card", width: cw, spacing: 6 });
        }
      }, { spacing: 12, align: "start" });
    }
  }, (w) => { void w; button({ id: "btn-help-back", text: T("Back"), act: goBack }); });
}

// ------------------------------------------------------------------ toasts
export function toastNow(text: () => string): void { app.toasts.push({ text, until: frame().time + 3.2 }); }
/** Bottom-centre toasts, drawn over everything and taking no pointer (the browser build's pointer-events: none). */
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const c = colors();
  const texts = app.toasts.map((t) => t.text());
  const sc = L.sc, size = 15.2 * sc * ui.preferences().textScale;
  const maxW = Math.min(L.lw - 24, 640) * sc;
  ui.place("toasts", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.widget("", {
      role: "none", size: { width: 0, height: 0 },
      draw: () => {
        const f = frame();
        let y = f.height - f.safeArea.bottom - 20 * sc;
        for (let i = texts.length - 1; i >= 0; i--) {
          const t = texts[i]!;
          const m = draw.measureText(t, { size, maxWidth: maxW - 36 * sc });
          const w = Math.min(maxW, m.width + 36 * sc), h = m.height + 20 * sc;
          const x = (f.width - w) / 2;
          y -= h;
          draw.roundRect(x, y, w, h, 8 * sc, c.panel2);
          draw.strokeRoundRect(x, y, w, h, 8 * sc, c.accent, Math.max(1, sc));
          draw.text(t, x + 18 * sc, y + 10 * sc, { size, color: c.ink, maxWidth: maxW - 36 * sc });
          y -= 6 * sc;
        }
      },
    });
  }, { width: 0, height: 0 });
}

// ------------------------------------------------------------------ the game screen
interface Rect { x: number; y: number; w: number; h: number }
function gameScreen(L: Layout): void {
  const s = sess!;
  const state = s.getState();
  const c = colors();
  const left = settings.leftHanded;
  const drawerMode = !L.wide;
  // ---- geometry (logical px from the safe area's top-left)
  const pad = 10;
  const topH = lastHeight.get("topbar") ?? (L.shortLand ? 40 : 48);
  const areaY = topH, areaH = L.lh - topH;
  let table: Rect, leftRail: Rect | null = null, right: Rect;
  const trayH = lastHeight.get("tray") ?? 200;
  if (L.wide) {
    const lw0 = 230, rw = 280;
    const tx = pad + (left ? rw : lw0) + pad;
    table = { x: tx, y: areaY + pad, w: L.lw - 2 * pad - lw0 - rw - 2 * pad, h: areaH - 2 * pad };
    leftRail = { x: left ? L.lw - pad - lw0 : pad, y: areaY + pad, w: lw0, h: areaH - 2 * pad };
    right = { x: left ? pad : L.lw - pad - rw, y: areaY + pad, w: rw, h: areaH - 2 * pad };
  } else if (L.shortLand || L.lw > L.lh * 1.15) {
    // short landscape (and other landscape windows under 1024 px): the table beside the action column
    const rw = L.shortLand ? 220 : 280;
    table = { x: left ? pad + rw + pad : pad, y: areaY + pad, w: L.lw - 3 * pad - rw, h: areaH - 2 * pad };
    right = { x: left ? pad : L.lw - pad - rw, y: areaY + pad, w: rw, h: areaH - 2 * pad };
  } else if (L.phone) {
    const tw = L.lw - 2 * pad;
    const th = Math.max(80, Math.min(tw * 5 / 8, L.lh * 0.58, areaH - trayH - 3 * pad));
    table = { x: pad, y: areaY + pad, w: tw, h: th };
    right = { x: pad, y: table.y + th + pad, w: tw, h: L.lh - (table.y + th + pad) - pad };
  } else {
    const tw = L.lw - 2 * pad;
    const th = Math.max(80, areaH - trayH - 3 * pad);
    table = { x: pad, y: areaY + pad, w: tw, h: th };
    right = { x: pad, y: table.y + th + pad, w: tw, h: L.lh - (table.y + th + pad) - pad };
  }
  // the 3D table in its rectangle (window pixels); the page colour around it
  const f = frame();
  const tw = { x: L.ox + table.x * L.sc, y: L.oy + table.y * L.sc, w: table.w * L.sc, h: table.h * L.sc };
  ui.place("game-bg", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.widget("", {
      role: "none", size: { width: 0, height: 0 },
      draw: () => {
        const W = f.width, H = f.height;
        draw.rect(0, 0, W, tw.y, c.bg); draw.rect(0, tw.y + tw.h, W, H - tw.y - tw.h, c.bg);
        draw.rect(0, tw.y, tw.x, tw.h, c.bg); draw.rect(tw.x + tw.w, tw.y, W - tw.x - tw.w, tw.h, c.bg);
      },
    });
  }, { width: 0, height: 0 });
  render.setView(tw, f.width, f.height);

  // ---- the table region: the drag aims / places; arrows stay with the game
  const tableLabel = T("Pool table. Use arrow keys to aim, plus and minus for power, Enter to shoot.");
  keepsArrows.table = tableLabel;
  ui.place("table-host", { anchor: "top-start", x: table.x, y: table.y }, () => {
    const res = ui.widget(tableLabel, { role: "region", size: { width: table.w, height: table.h }, arrows: true, description: mirrorText() });
    const p = res.pointer;
    if (p) tablePointer(res.x + p.x, res.y + p.y, (p.buttons & 1) !== 0, p.inside);
  });

  // ---- top bar
  const topR = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column("topbar-in", () => {
      const obj = objectiveText(state);
      const turn = turnText(state);
      const score = `${T("Score {n}", { n: state.score.total })} · ${state.ruleset === "clearance" ? T("Shots left {n}", { n: state.shotsLeft }) : T("Shots {n}", { n: state.shotCount })}`;
      const railBtn = (): void => { if (drawerMode) button({ id: "btn-rail", text: T("Objective"), style: ["btn", "btn-small"], act: () => toggleDrawer() }); };
      if (L.phone) {
        ui.row("top-1", () => { railBtn(); ui.spacer(); para(obj, L.lw - 140, "hud-objective", "hud-objective"); }, { width: L.lw - 24, align: "center", spacing: 10 });
        ui.row("top-2", () => { ui.style("hud-player").id("hud-player").label(turn); ui.spacer(); ui.style("hud-score").id("hud-score").label(score); }, { width: L.lw - 24, align: "center", spacing: 10 });
      } else {
        ui.row("top-1", () => {
          railBtn();
          para(obj, Math.max(120, (L.lw - 24) * 0.42), "hud-objective", "hud-objective");
          ui.spacer();
          ui.style("hud-player").id("hud-player").label(turn);
          ui.spacer();
          ui.style("hud-score").id("hud-score").label(score);
        }, { width: L.lw - 24, align: "center", spacing: 18 });
      }
    }, { style: "game-topbar", width: L.lw, spacing: 6, padding: { top: L.shortLand ? 4 : 8, bottom: L.shortLand ? 4 : 8, start: 12, end: 12 } });
  });
  lastHeight.set("topbar", topR.height / L.sc);

  // ---- rails
  if (leftRail) {
    const lr = leftRail;
    ui.place("rail-left", { anchor: "top-start", x: lr.x, y: lr.y }, () => objectiveRail(state, lr.w - 24, false), { style: "rail", width: lr.w, height: lr.h, spacing: 8 });
  }
  actionRail(L, state, right);

  // ---- the objective drawer (narrow and short layouts)
  if (drawerMode && app.drawer && !app.overlay) {
    const dw = Math.min(300, L.lw * 0.85);
    ui.place("rail-drawer", { anchor: left ? "top-end" : "top-start", x: 0, y: 0 }, () => {
      ui.scrollArea("drawer-scroll", { width: dw - 24, height: L.lh - 24 }, () => objectiveRail(state, dw - 40, true));
    }, { style: "drawer", width: dw, height: L.lh });
  }

  // ---- overlays
  if (app.overlay === "pause") pauseCard(L);
  else if (app.overlay === "results") resultsCard(L);
}

function objectiveRail(state: State, w: number, drawer: boolean): void {
  if (drawer) button({ id: "btn-rail-close", text: T("Close"), style: ["btn", "btn-small"], act: () => toggleDrawer(false) });
  ui.style("rail-heading").label(T("Objective").toUpperCase());
  para(objectiveText(state), w, "body", "rail-objective-text");
  para(state.ruleset === "clearance"
    ? T("Shots left: {left} · Taken: {taken}", { left: state.shotsLeft, taken: state.shotCount })
    : T("Turn {n} · Shots: {shots}", { n: state.turn + 1, shots: state.shotCount }), w, "body", "rail-shots");
  ui.style("rail-heading").label(T("Legal targets").toUpperCase());
  targetChips(state, w);
  para(T("Table time: {n}s (simulated)", { n: Math.round(state.tick / 240) }), w, "muted", "rail-timer");
}
/** The legal-target chips: every object ball as a numbered disc in its colour; a gold ring on legal targets, struck through once potted. */
function targetChips(state: State, w: number): void {
  const targets = Rules.legalTargets(state);
  const hc = ui.preferences().highContrast;
  const balls = state.balls.filter((b) => b.n !== 0);
  const size = 34, gap = 6;
  const per = Math.max(1, Math.floor((w + gap) / (size + gap)));
  const rows = Math.ceil(balls.length / per);
  const label = balls.map((b) => T(b.potted ? "Ball {n}, potted" : targets.includes(b.n) ? "Ball {n}, legal target" : "Ball {n}, not a legal target", { n: b.n })).join(". ");
  ui.widget(label, {
    role: "image", size: { width: w, height: rows * size + (rows - 1) * gap },
    draw: (r) => {
      const k = r.height / (rows * size + (rows - 1) * gap);
      balls.forEach((b, i) => {
        const cx = r.x + ((i % per) * (size + gap) + size / 2) * k, cy = r.y + (Math.floor(i / per) * (size + gap) + size / 2) * k;
        const rad = (size / 2) * k;
        const info = Content.BALLS[b.n]!;
        const fill = hexCss(hc ? info.colorHC : info.color);
        const alpha = b.potted ? 0.3 : 1;
        draw.circle(cx, cy, rad, withAlpha(fill, alpha));
        if (!b.potted && targets.includes(b.n)) draw.strokeCircle(cx, cy, rad - k, "#ffd970", 2 * k);
        const ink = b.n === 8 ? "#f0e8d8" : "#14100c";
        const ts = 13.6 * k;
        draw.text(String(b.n), cx, cy - ts * 0.62, { size: ts, weight: "700", color: withAlpha(ink, alpha), align: "center" });
        if (b.potted) draw.line(cx - rad * 0.5, cy, cx + rad * 0.5, cy, withAlpha(ink, alpha), Math.max(1, k * 1.5));
      });
    },
  });
}
function withAlpha(hex: string, a: number): string {
  if (a >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function spinText(): string {
  const { spinTop: t, spinSide: sd } = aim;
  if (t === 0 && sd === 0) return T("No spin");
  return [t ? (t > 0 ? T("follow {n}", { n: t }) : T("draw {n}", { n: -t })) : "", sd ? (sd > 0 ? T("right {n}", { n: sd }) : T("left {n}", { n: -sd })) : ""].filter(Boolean).join(", ");
}
let spinDrag = false;
let spinWasDown = false;
function spinPad(size: number, locked: boolean): void {
  const c = colors();
  const label = T("Spin");
  keepsArrows.spin = label;
  const res = ui.widget(label, {
    role: "region", size: { width: size, height: size }, arrows: true, description: spinText(), disabled: locked,
    draw: (r, st) => {
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2, rad = r.width / 2;
      draw.circle(cx, cy, rad, st.highContrast ? "#ffffff" : "#443a2c");
      draw.circle(cx, cy, rad - 2 * st.scale, "#d8d0be");
      draw.circle(cx, cy, (rad - 2 * st.scale) * 0.58 / 0.6, "#f6f1e6");
      const mx = cx + (aim.spinSide / 100) * rad, my = cy - (aim.spinTop / 100) * rad;
      draw.circle(mx, my, 9 * st.scale, "#ffffff");
      draw.circle(mx, my, 7 * st.scale, c.danger);
      if (locked) draw.circle(cx, cy, rad, "rgba(20,16,12,0.45)");
    },
  });
  if (locked) { spinDrag = false; return; }
  const p = res.pointer;
  const down = !!p && (p.buttons & 1) !== 0;
  if (p && down && (spinDrag || (p.inside && !spinWasDown))) {
    spinDrag = true;
    const nx = Math.max(-1, Math.min(1, (p.x / res.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, (p.y / res.height) * 2 - 1));
    if (nx * nx + ny * ny <= 1) setSpin(-ny * 100, nx * 100);
  } else if (!down) spinDrag = false;
  spinWasDown = down;
  for (const k of res.keys ?? []) {
    if (k === "ArrowLeft" || k === "DpadLeft") setSpin(aim.spinTop, aim.spinSide - 10);
    else if (k === "ArrowRight" || k === "DpadRight") setSpin(aim.spinTop, aim.spinSide + 10);
    else if (k === "ArrowUp" || k === "DpadUp") setSpin(aim.spinTop + 10, aim.spinSide);
    else if (k === "ArrowDown" || k === "DpadDown") setSpin(aim.spinTop - 10, aim.spinSide);
    else if (k === "Digit0" || k === "Numpad0" || k === "Home") setSpin(0, 0);
  }
}

function actionRail(L: Layout, state: State, r: Rect): void {
  const s = sess!;
  const locked = replaying();
  const myTurn = !s.isAITurn() && !state.terminal && s.getPhase() === "active" && !locked;
  const inHand = state.ballInHand && !state.terminal;
  const column = L.wide || L.shortLand || L.lw > L.lh * 1.15;
  const w = r.w - 24;
  const hudBtns: Btn[] = [
    { id: "btn-pause", text: T("Pause"), style: ["btn", "btn-small"], act: () => pauseGame() },
    { id: "btn-hint", text: T("Hint"), style: ["btn", "btn-small"], kbd: keyName("hint"), disabled: locked || !myTurn || !state.mechanics.hint, act: () => { doHint(); ui.setFocus(keepsArrows.table); } },
    { id: "btn-undo", text: T("Undo"), style: ["btn", "btn-small"], kbd: keyName("undo"), disabled: locked || !s.canUndo(), act: () => { doUndo(); ui.setFocus(keepsArrows.table); } },
  ];
  if (locked) hudBtns.push({ id: "btn-skip", text: T("Skip replay"), style: ["btn", "btn-small"], act: () => { skipReplay(); ui.setFocus(keepsArrows.table); } });
  const powerBlock = (bw: number): void => {
    ui.column("power-block", () => {
      ui.style("control-label").label(T("Power"));
      const label = T("Power");
      keepsArrows.power = label;
      const v = ui.style({ width: bw }).id("power-slider").slider(label, aim.power, { min: 0, max: 1000, step: 10, width: bw });
      if (!locked && v !== aim.power) setPower(v);
      ui.style("muted").id("power-value").label(`${Math.round(aim.power / 10)}%`);
    }, { spacing: 4, width: bw });
  };
  const padSize = column ? (L.shortLand ? 96 : 120) : 96;
  const spinBlock = (bw: number): void => {
    ui.column("spin-block", () => {
      ui.style("control-label").label(T("Spin"));
      spinPad(padSize, locked);
      para(spinText(), bw, "muted", "spin-value");
    }, { spacing: 4, width: bw });
  };
  const shootRow = (bw: number): void => {
    if (inHand && placePoint) button({ id: "btn-place", text: T("Place here"), style: ["btn", "btn-primary"], disabled: locked, act: () => { tryPlace(); ui.setFocus(keepsArrows.table); } }, bw);
    if (!inHand) button({ id: "btn-shoot", text: T("Shoot"), style: ["btn", "btn-primary", "btn-big"], kbd: keyName("shoot"), disabled: !myTurn, act: () => { tryShoot(); ui.setFocus(keepsArrows.table); }, silent: true }, bw);
  };
  const readout = T("Aim: {aim} rad · Power {power}%", { aim: (aim.milli / 1000).toFixed(2), power: Math.round(aim.power / 10) });
  const body = (): void => {
    if (lessonEvent && s.getLesson()) para(lessonText(), w - 26, "body", "lesson-banner-text");
  };
  const content = (): void => {
    if (lessonEvent && s.getLesson()) ui.column("lesson-banner", body, { style: "lesson-banner", width: w });
    flow("hud-row", hudBtns, w);
    if (column) {
      powerBlock(w);
      spinBlock(w);
      para(readout, w, "muted", "aim-readout");
    } else {
      const half = (w - 16) / 2;
      ui.row("controls-row", () => { powerBlock(half); spinBlock(half); }, { spacing: 16, align: "start", width: w });
      para(readout, w, "muted", "aim-readout");
    }
  };
  if (column) {
    // the Place / Shoot button pinned to the rail's bottom; the rest scrolls on short windows
    const fH = (lastHeight.get("rail-foot") ?? 60) + 10;
    const room = Math.max(60, r.h - 24 - fH);
    const bh = lastHeight.get("rail-body") ?? 0;
    ui.place("rail-right", { anchor: "top-start", x: r.x, y: r.y }, () => {
      const inner = (ww: number): void => {
        const rr = ui.column("rail-body", () => content(), { width: ww, spacing: 10 });
        lastHeight.set("rail-body", rr.height / L.sc);
      };
      if (bh > room + 1) ui.scrollArea("rail-scroll", { width: w + 8, height: room }, () => inner(w - 8));
      else { inner(w); ui.spacer(); }
      const fr = ui.column("rail-foot", () => shootRow(w), { width: w, spacing: 8 });
      lastHeight.set("rail-foot", fr.height / L.sc);
    }, { style: "rail", width: r.w, height: r.h, spacing: 10 });
  } else {
    // below the table: the tray (on a portrait phone it fills the rest of the screen, Shoot at the bottom under the thumb)
    ui.place("rail-right", { anchor: "top-start", x: r.x, y: r.y }, () => {
      const cr = ui.column("tray-body", () => content(), { width: w, spacing: 10 });
      if (L.phone) ui.spacer();
      const fr = ui.column("tray-foot", () => shootRow(w), { width: w, spacing: 8 });
      lastHeight.set("tray", (cr.height + fr.height) / L.sc + 24 + 10);
    }, { style: "rail", width: r.w, spacing: 10, ...(L.phone ? { height: Math.max(r.h, (lastHeight.get("tray") ?? 0)) } : {}) });
  }
}

// ------------------------------------------------------------------ overlays
/** A card on the dim (a modal dialog: input reaches nothing behind it): a body taller than the room scrolls while the footer stays below. */
function overlayCard(key: string, L: Layout, body: (w: number) => void, footer: (w: number) => void, art?: (w: number) => void): void {
  const width = Math.max(220, Math.min(480, L.lw - 32));
  const padX = L.narrowMenu || L.shortLand ? 16 : 24;
  const inner = width - padX * 2;
  const room = Math.min(L.lh * 0.9, L.lh - 32) - padX * 2;
  const fH = (lastHeight.get(`${key}:f`) ?? 56) + 8;
  const aH = art ? (lastHeight.get(`${key}:a`) ?? 0) + 8 : 0;
  const bodyMax = Math.max(60, room - fH - aH);
  const bh = lastHeight.get(`${key}:b`) ?? 0;
  ui.style("overlay-card").dialog(key, "", true, () => {
    ui.column(`${key}-card`, () => {
      const inside = (w: number): void => {
        const r = ui.column(`${key}-body`, () => body(w), { width: w, spacing: 8 });
        lastHeight.set(`${key}:b`, r.height / L.sc);
      };
      const scroll = (): void => {
        if (art) { const r = ui.column(`${key}-art`, () => art(inner), { width: inner }); lastHeight.set(`${key}:a`, r.height / L.sc); }
        if (bh > bodyMax + 1) ui.scrollArea(`${key}-scroll`, { width: inner, height: bodyMax }, () => inside(inner - 12));
        else inside(inner);
      };
      scroll();
      const r = ui.column(`${key}-foot`, () => footer(inner), { width: inner, spacing: 8 });
      lastHeight.set(`${key}:f`, r.height / L.sc);
    }, { width: inner, spacing: 8 });
  });
}
function pauseCard(L: Layout): void {
  overlayCard("pause", L, () => { h2(T("Paused"), "pause-title"); }, (w) => {
    ui.column("pause-actions", () => {
      button({ id: "btn-resume", text: T("Resume"), style: ["btn", "btn-primary"], act: resumeGame }, w);
      button({ id: "btn-pause-restart", text: T("Restart"), act: restartGame }, w);
      button({ id: "btn-pause-settings", text: T("Settings"), act: pauseToSettings }, w);
      button({ id: "btn-pause-quit", text: T("Leave game"), style: ["btn", "btn-ghost"], act: quitToHome }, w);
    }, { spacing: 8, width: w });
  });
}
function resultsCard(L: Layout): void {
  const R = app.results;
  if (!R) return;
  const { r, newAch } = R;
  const c = colors();
  const showArt = r.youWon && L.lh >= 560;
  overlayCard("results", L, (w) => {
    h2(resultsHeadline(r), "res-headline");
    glyphs(T("{n} of 3 stars", { n: r.stars }), starGlyphs(r.stars), 26, (g) => (g === "star" ? c.accent : c.dim), 6);
    const rows: [string, number][] = [[T("Pots"), r.score.pots], [T("Win bonus"), r.score.winBonus], [T("Shot bonus"), r.score.shotBonus], [T("Foul penalty"), r.score.foulPenalty]];
    ui.column("res-breakdown", () => {
      for (const [label, val] of rows) {
        ui.row(`bd-${label}`, () => {
          ui.style("breakdown-dt").label(label);
          ui.spacer();
          ui.style("breakdown-dd").label((val >= 0 ? "+" : "") + val);
        }, { style: "breakdown-row", width: w, align: "center" });
      }
      ui.row("bd-total", () => {
        ui.style("total-row").label(T("Total"));
        ui.spacer();
        ui.style("total-row").id("res-total").label(String(r.score.total));
      }, { width: w, align: "center", padding: { top: 4 } });
    }, { spacing: 4, width: w });
    para(T("{shots} shots · {pots} pots · {fouls} fouls · {secs}s simulated", { shots: r.shots, pots: r.pots, fouls: r.fouls, secs: Math.round(r.elapsedTicks / 240) }), w, "muted", "res-detail");
    for (const key of newAch) {
      const a = Content.ACHIEVEMENTS.find((x) => x.key === key);
      ui.row(`ach-${key}`, () => {
        glyphs("", ["trophy"], 16, c.accent);
        para(T("Achievement: {name}", { name: a ? T(a.name) : key }), w - 24, "achievement");
      }, { spacing: 6, align: "center" });
    }
    const lb = app.lb;
    if (lb) {
      para(lb === "posting" ? T("Posting score to the leaderboard…") : !lb.posted ? T("Score not posted to the leaderboard.")
        : lb.rank ? T("Leaderboard rank: #{rank}", { rank: lb.rank }) : T("Score posted to the leaderboard."), w, "muted", "res-leaderboard");
    }
  }, (w) => {
    const list: Btn[] = [{ id: "btn-retry", text: T("Retry"), act: retryGame }];
    const jIdx = Content.JOURNEY.findIndex((j) => j.id === r.cfgId);
    if (R.next && Progress.journeyUnlocked(platform.save(), jIdx + 1)) list.push({ id: "btn-next", text: T("Next"), style: ["btn", "btn-primary"], act: nextStage });
    list.push({ id: "btn-results-home", text: T("Home"), style: ["btn", "btn-ghost"], act: quitToHome });
    flow("res-actions", list, w);
  }, showArt ? (w) => {
    // the win banner, cover-fitted (the panel colour if the image is missing)
    ui.widget("", {
      role: "none", size: { width: w, height: Math.round((w * 7) / 16) },
      draw: (rr, st) => draw.box(rr.x, rr.y, rr.width, rr.height, { background: [{ image: "assets/results-clear.webp", size: "cover" }, c.panel2], radius: 10 * st.scale }),
    });
  } : undefined);
}
