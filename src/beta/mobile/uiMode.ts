import { createContext, useContext } from "react";

/**
 * THE MOBILE-FIRST UI, ALONGSIDE THE CURRENT ONE (Max, 2026-11-10).
 *
 * A second interface for the live board, switched under More → Interface and
 * saved on this device. It is the same shell, the same routes and the same
 * screen components, so every feature the current UI has is here by
 * construction; what changes is the chrome (an app bar with an in-bar back
 * step, an icon tab bar) and the whole visual layer (`mobile.css`, every rule
 * scoped under `.v3.mf`).
 *
 * `classic` is the board as it ships and sets nothing: a reader who never
 * opens the picker sees no change and never downloads the second stylesheet.
 * Live board only — the redesign lab keeps its own look.
 */
export const UI_MODES = [
  { id: "classic", name: "Current", note: "The board as it ships" },
  { id: "mobile", name: "Mobile-first", note: "Trial: app bar, icon tabs, thumb-sized controls. Same screens, same data" },
] as const;

export type UiMode = typeof UI_MODES[number]["id"];

export const UI_KEY = "warboard.v3.ui";

const isUi = (v: unknown): v is UiMode => UI_MODES.some(m => m.id === v);

export function readUi(): UiMode {
  try {
    const v = window.localStorage.getItem(UI_KEY);
    return isUi(v) ? v : "classic";
  } catch { return "classic"; }
}

export function writeUi(m: UiMode) {
  try { window.localStorage.setItem(UI_KEY, m); } catch { /* private mode */ }
}

export const UiContext = createContext<{ ui: UiMode; setUi: (m: UiMode) => void } | null>(null);

/** null outside the live board — More draws the Interface band only when it has one */
export function useUi() { return useContext(UiContext); }

/** true while the mobile-first UI is the one on screen */
export function useMobileUi() { return useContext(UiContext)?.ui === "mobile"; }
