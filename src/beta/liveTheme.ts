import { createContext, useContext } from "react";

/**
 * THE LIVE BOARD'S THEMES (Max, 2026-11-04).
 *
 * Opt-in palettes for the board as it ships, picked under More → Appearance.
 * `original` is today's board exactly: it sets NO attribute, so `:root` in
 * style.css is what renders and a reader who never opens the picker sees no
 * change at all. The others are `:root[data-theme="live-…"]` blocks in
 * style.css — they re-point the existing tokens and add none.
 *
 * `bg` is each theme's `--bg`, repeated because the boot script in index.html
 * and `<meta name="theme-color">` need it before any stylesheet applies.
 * `swatch` is the picker's strip — `--deep`, `--bg`, `--acc`, `--good` — and is
 * literal because a row shows a theme that is not applied. Keep both in step
 * with style.css and index.html.
 */
export const LIVE_THEMES = [
  { id: "original", name: "Original", note: "Gold on carbon — the board as it ships", dark: true,
    bg: "#0c0f13", swatch: ["#05070a", "#0c0f13", "#f5c518", "#2bd07a"] },
  { id: "live-midnight", name: "Midnight", note: "Sky blue on deep navy", dark: true,
    bg: "#09111e", swatch: ["#040912", "#09111e", "#5cb8ff", "#43d783"] },
  { id: "live-ember", name: "Ember", note: "Signal orange on warm charcoal", dark: true,
    bg: "#0e0b09", swatch: ["#070504", "#0e0b09", "#ff8c42", "#4fd08a"] },
  { id: "live-royal", name: "Royal", note: "Lavender on midnight indigo", dark: true,
    bg: "#0c0b21", swatch: ["#06051a", "#0c0b21", "#b69bff", "#4fd08a"] },
  { id: "live-pressbox", name: "Press box", note: "Old gold on warm paper — the house look, lights up", dark: false,
    bg: "#f7f5f0", swatch: ["#ebe7dd", "#f7f5f0", "#7d5a00", "#15693f"] },
  { id: "live-chalk", name: "Chalk", note: "Cobalt on cool white", dark: false,
    bg: "#f5f7fa", swatch: ["#e6eaf0", "#f5f7fa", "#1f4fd1", "#0f6b42"] },
  { id: "live-clay", name: "Clay", note: "Terracotta on sand", dark: false,
    bg: "#f8f1e8", swatch: ["#eee2d5", "#f8f1e8", "#9f3f0b", "#1a6640"] },
] as const;

export type LiveThemeId = typeof LIVE_THEMES[number]["id"];

export const LIVE_THEME_KEY = "warboard.v3.livetheme";

const isLiveTheme = (v: unknown): v is LiveThemeId => LIVE_THEMES.some(t => t.id === v);

export function readLiveTheme(): LiveThemeId {
  try {
    const v = window.localStorage.getItem(LIVE_THEME_KEY);
    return isLiveTheme(v) ? v : "original";
  } catch { return "original"; }
}

export function writeLiveTheme(t: LiveThemeId) {
  try { window.localStorage.setItem(LIVE_THEME_KEY, t); } catch { /* private mode */ }
}

/** set the document's theme attribute and the browser chrome colour; `null`
 *  (unmount) and `original` both leave the board on plain `:root` */
export function applyLiveTheme(t: LiveThemeId | null) {
  const root = document.documentElement;
  if (t && t !== "original") root.dataset.theme = t; else delete root.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", LIVE_THEMES.find(x => x.id === (t ?? "original"))!.bg);
}

export const LiveThemeContext = createContext<
  { theme: LiveThemeId; setTheme: (t: LiveThemeId) => void } | null
>(null);

/** null outside the live board — More draws the live picker only when it has one */
export function useLiveTheme() { return useContext(LiveThemeContext); }
