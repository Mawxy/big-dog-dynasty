import { createContext, useContext } from "react";

/**
 * THE LAB'S FOUR THEMES (C4 spec §2, 2026-11-04).
 *
 * `original` is today's palette exactly — `:root` already holds it, so it has
 * no token block. The other three are `:root[data-theme="…"]` blocks in
 * `src/style.css`. The attribute is set ONLY while the lab is mounted (and by
 * the boot script in index.html when the address is a lab address), so the
 * live board never wears a theme it was not designed for.
 *
 * `deep` is each theme's `--deep`, repeated here because the boot script and
 * `<meta name="theme-color">` both need it before any stylesheet has applied.
 * `swatch` is the picker's strip — `--deep`, `--bg`, `--acc`, `--war` — and has
 * to be literal for the same reason: a row shows a theme that is not applied.
 * Keep the two in step with style.css and index.html.
 */
export const THEMES = [
  { id: "original", name: "Original", note: "Gold on carbon — today's look", deep: "#05070a",
    swatch: ["#05070a", "#0c0f13", "#f5c518", "#f5c518"] },
  { id: "newsprint", name: "Newsprint", note: "Cream newsprint, black bars, cobalt accent", deep: "#161616",
    swatch: ["#161616", "#efe9dd", "#2445d6", "#b8860b"] },
  { id: "ringside", name: "Ringside blue", note: "Electric blue on navy-black", deep: "#04070f",
    swatch: ["#04070f", "#0a0f1c", "#3aa0ff", "#f5c518"] },
  { id: "vintage", name: "Vintage", note: "Cream poster, navy bars, red accent", deep: "#1c2a44",
    swatch: ["#1c2a44", "#f3ead7", "#c2102d", "#b8860b"] },
] as const;

export type ThemeId = typeof THEMES[number]["id"];

export const THEME_KEY = "warboard.v3.theme";
/** the live board's theme-color, restored when the lab unmounts */
export const LIVE_THEME_COLOR = "#0c0f13";

const isTheme = (v: unknown): v is ThemeId => THEMES.some(t => t.id === v);

export function readTheme(): ThemeId {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : "original";
  } catch { return "original"; }
}

export function writeTheme(t: ThemeId) {
  try { window.localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
}

/** set the document's theme attribute and the browser chrome colour */
export function applyTheme(t: ThemeId | null) {
  const root = document.documentElement;
  if (t) root.dataset.theme = t; else delete root.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", t ? THEMES.find(x => x.id === t)!.deep : LIVE_THEME_COLOR);
}

export const ThemeContext = createContext<{ theme: ThemeId; setTheme: (t: ThemeId) => void } | null>(null);

/** null outside the lab — More only draws the Appearance band when it has one */
export function useTheme() { return useContext(ThemeContext); }
