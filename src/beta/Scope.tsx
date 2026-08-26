import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Sheet, SheetRow } from "./ui";
import "./scope.css";

/**
 * The one tense control — Current / History — shared by every screen that has
 * a past. Two segments, fixed forever: adding a season never adds a segment,
 * because the History segment's label BECOMES the selected season and a picker
 * sheet does the choosing. That is what keeps the control the same width in
 * year four and year forty.
 *
 * Scope lives in the URL (`?scope=history&season=2025`) so a link is shareable
 * and back works. Current is the absence of the params — a link to the site as
 * it ships carries no setting that only means "unchanged".
 */

export type ScopeSel = { scope: "current" } | { scope: "history"; season: string };

/** Seasons the picker offers, newest first. `note` is the settled season's
 *  one-line identity — champion and record — so the picker is a history table,
 *  not a bare list of years. */
export interface ScopeSeason { id: string; note?: string }

/**
 * Read and write the scope from the URL. `seasons` is the list of PLAYED
 * seasons (newest first); a history link naming a season this league never
 * played clamps to the newest one rather than rendering an empty year.
 */
export function useScope(seasons: string[]): [ScopeSel, (s: ScopeSel) => void] {
  const loc = useLocation();
  const nav = useNavigate();
  const sel = useMemo<ScopeSel>(() => {
    const q = new URLSearchParams(loc.search);
    if (q.get("scope") !== "history" || seasons.length === 0) return { scope: "current" };
    const want = q.get("season");
    const season = want && seasons.includes(want) ? want : seasons[0];
    return { scope: "history", season };
  }, [loc.search, seasons]);
  const set = useCallback((s: ScopeSel) => {
    const q = new URLSearchParams(loc.search);
    if (s.scope === "current") { q.delete("scope"); q.delete("season"); }
    else { q.set("scope", "history"); q.set("season", s.season); }
    const qs = q.toString();
    // push, not replace — the tense change is a place the reader can back out of
    nav({ pathname: loc.pathname, search: qs ? `?${qs}` : "" });
  }, [loc.pathname, loc.search, nav]);
  return [sel, set];
}

/**
 * The segmented control itself. `currentLabel` is "Current" everywhere except
 * Trade, whose left segment reads "Build" — a trade being assembled is not a
 * current state. Tapping History with one played season selects it directly;
 * with more than one it opens the picker sheet, and tapping the History
 * segment while already in history reopens the picker.
 */
export default function ScopeControl({ value, onChange, seasons, currentLabel = "Current" }: {
  value: ScopeSel;
  onChange: (s: ScopeSel) => void;
  seasons: ScopeSeason[];
  currentLabel?: string;
}) {
  const [picking, setPicking] = useState(false);
  const onHistory = value.scope === "history";
  if (seasons.length === 0) return null;
  return (
    <>
      <div className="v3-scopectl" role="group" aria-label="Scope">
        <button className={onHistory ? "" : "on"}
          onClick={() => onChange({ scope: "current" })}>{currentLabel}</button>
        <button className={onHistory ? "on" : ""}
          aria-haspopup={seasons.length > 1 ? "dialog" : undefined}
          onClick={() => {
            if (seasons.length === 1) onChange({ scope: "history", season: seasons[0].id });
            else setPicking(true);
          }}>
          {onHistory ? value.season : "History"}
          {seasons.length > 1 && <span className="caret">▾</span>}
        </button>
      </div>
      {picking && (
        <Sheet label="Pick a season" title="Seasons" onClose={() => setPicking(false)}>
          {seasons.map(s => {
            const on = onHistory && value.season === s.id;
            return (
              <SheetRow key={s.id} on={on} mark={on ? "Here" : undefined}
                name={s.id} meta={s.note}
                onClick={() => { setPicking(false); onChange({ scope: "history", season: s.id }); }} />
            );
          })}
        </Sheet>
      )}
    </>
  );
}
