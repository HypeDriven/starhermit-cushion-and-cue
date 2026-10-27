// The look of the menus and HUD: the browser build's style sheet, rewritten
// class-based in tools/ui-style.css and converted once with `starhermit css`
// into assets/ui-style.json (`npm run css`), registered at start with the
// theme the runtime's own widgets (checkboxes, selects, sliders, text
// fields, scroll bars) fall back to. The browser build's body.high-contrast
// palette is a token set here, applied while the runtime's high-contrast
// option is on.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
const HIGH_CONTRAST: Tokens = {
  bg: "#000000", panel: "#101010", "panel-2": "#1a1a1a", ink: "#ffffff", "ink-dim": "#e8e8e8", accent: "#ffd700", focus: "#ffffff",
};
export const COLORS = { bg: "#14100c", panel: "#1f1a14", panel2: "#2a231b", ink: "#f0e8d8", dim: "#b7ab94", accent: "#e8c46a", accentInk: "#241a08", danger: "#d4634e", focus: "#ffd970", border: "#443a2c" };
export const COLORS_HC = { bg: "#000000", panel: "#101010", panel2: "#1a1a1a", ink: "#ffffff", dim: "#e8e8e8", accent: "#ffd700", accentInk: "#241a08", danger: "#ff6b5a", focus: "#ffffff", border: "#ffffff" };

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 14, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: COLORS.ink, muted: COLORS.dim, panel: COLORS.panel, control: COLORS.panel2, hovered: "#352c20",
    pressed: "#3d3224", field: COLORS.panel, accent: COLORS.accent, focus: COLORS.focus, outline: COLORS.border,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 44,
      parts: { box: { background: "$panel-2", border: { width: 1, color: "#443a2c" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "$panel-2", border: { width: 1, color: "#443a2c" }, radius: 6, minHeight: 40 },
    slider: { minHeight: 44, parts: { track: { background: "#3a3125", radius: 3 }, fill: { background: "$accent", radius: 3 }, thumb: { background: "$accent", radius: 10 } } },
    textField: { text: { color: "$ink" }, background: "$panel", border: { width: 1, color: "#443a2c" }, radius: 8, minHeight: 44 },
    scrollArea: { parts: { bar: { background: "#443a2c", radius: 4 } } },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
