import { createContext, useContext } from "react";

/**
 * THE BOARD'S INTERFACE (Max, 2026-11-11).
 *
 * The mobile-first UI is the board: an app bar with an in-bar back step, an
 * icon tab bar, and the whole visual layer in `mobile.css` (every rule scoped
 * under `.v3.mf`). It began on 2026-11-10 as a trial beside the previous UI
 * and became the default the next day.
 *
 * The previous UI stays selectable under More → Interface for now, saved on
 * this device. Both are the same shell, the same routes and the same screen
 * components, so each carries every feature by construction. A device with no
 * saved choice gets `mobile`; a saved choice is honored.
 */
export const UI_MODES = [
  { id: "mobile", name: "Mobile-first", note: "The standard board: app bar, icon tabs, thumb-sized controls" },
  { id: "classic", name: "Previous", note: "The older look, kept for now. Same screens, same data" },
] as const;

export type UiMode = typeof UI_MODES[number]["id"];

export const UI_KEY = "warboard.v3.ui";

const isUi = (v: unknown): v is UiMode => UI_MODES.some(m => m.id === v);

export function readUi(): UiMode {
  try {
    const v = window.localStorage.getItem(UI_KEY);
    return isUi(v) ? v : "mobile";
  } catch { return "mobile"; }
}

export function writeUi(m: UiMode) {
  try { window.localStorage.setItem(UI_KEY, m); } catch { /* private mode */ }
}

export const UiContext = createContext<{ ui: UiMode; setUi: (m: UiMode) => void } | null>(null);

/** null outside the shell — More draws the Interface band only when it has one */
export function useUi() { return useContext(UiContext); }
