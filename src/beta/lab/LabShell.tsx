import { useLayoutEffect, useMemo, useState } from "react";
import BetaShell from "../BetaShell";
import { ThemeContext, applyTheme, readTheme, writeTheme, type ThemeId } from "./theme";
import "./c4.css";
// the per-screen layers, after the base so they can refine it
import "./c4-league.css";
import "./c4-team.css";
import "./c4-players.css";
import "./c4-trade.css";

/**
 * THE REDESIGN LAB — `/<league>/lab/...` (Max, 2026-11-04).
 *
 * The slot the classic board held. It mounts the live beta shell, every
 * screen and every route, under a trial look: today that is C4 "Tale of the
 * Tape" (the spec lives in PROJECT_NOTES). Content is identical by
 * construction — the same components render — so the only diff between
 * `/big-dog/league` and `/big-dog/lab/league` is the skin.
 *
 * Its own chunk, stylesheet included: a reader on the live board never pays
 * for the trial. Every rule in c4.css is scoped under `.v3.c4`, so the sheet
 * staying loaded after the reader leaves the lab changes nothing.
 *
 * The theme attribute is set here, before paint, and removed on the way out,
 * so the live board never renders in a theme it was not designed for.
 */
export default function LabShell() {
  const [theme, setThemeState] = useState<ThemeId>(readTheme);
  useLayoutEffect(() => {
    applyTheme(theme);
    return () => applyTheme(null);
  }, [theme]);
  const value = useMemo(() => ({
    theme,
    setTheme: (t: ThemeId) => { writeTheme(t); setThemeState(t); },
  }), [theme]);
  return (
    <ThemeContext.Provider value={value}>
      <BetaShell look="c4" />
    </ThemeContext.Provider>
  );
}
