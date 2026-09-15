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

/** the season value that means "every season at once" — only screens that
 *  opt into `all` mode (below) ever see it. In that mode `season` may also be
 *  a comma-joined SET of season ids ("2024,2025"): a filter, not a tense. */
export const ALL_SEASONS = "all";

/** the season set a scope selection names, for all-mode screens: empty means
 *  every season */
export const seasonSet = (season: string): Set<string> =>
  new Set(season === ALL_SEASONS ? [] : season.split(",").filter(Boolean));

/** Seasons the picker offers, newest first. `note` is the settled season's
 *  one-line identity — champion and record — so the picker is a history table,
 *  not a bare list of years. */
export interface ScopeSeason { id: string; note?: string }

/**
 * Read and write the scope from the URL. `seasons` is the list of PLAYED
 * seasons (newest first); a history link naming a season this league never
 * played clamps to the newest one rather than rendering an empty year.
 */
export function useScope(seasons: string[], opts?: {
  /** ALL-HISTORY MODE (Max, 2026-09-02): History means every season at once,
   *  and a single season is a FILTER the screen applies on top, not the tense.
   *  The default season is then "all", and "all" is a legal URL value. */
  all?: boolean;
  /** ALL-TIME AS A CHOICE: "all" is a legal season beside the played ones —
   *  the picker offers it as a row — but the default History is still the
   *  newest season. League uses this for its all-time table. */
  allowAll?: boolean;
}): [ScopeSel, (s: ScopeSel) => void] {
  const loc = useLocation();
  const nav = useNavigate();
  const all = !!opts?.all, allowAll = !!opts?.allowAll;
  const sel = useMemo<ScopeSel>(() => {
    const q = new URLSearchParams(loc.search);
    if (q.get("scope") !== "history" || seasons.length === 0) return { scope: "current" };
    const want = q.get("season");
    if (all) {
      // a set of known seasons, in the list's own order; nothing known = all
      const picked = seasons.filter(id => seasonSet(want ?? "").has(id));
      return { scope: "history", season: picked.length ? picked.join(",") : ALL_SEASONS };
    }
    if (allowAll && want === ALL_SEASONS) return { scope: "history", season: ALL_SEASONS };
    const season = want && seasons.includes(want) ? want : seasons[0];
    return { scope: "history", season };
  }, [loc.search, seasons, all, allowAll]);
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
 * The segmented control itself. `currentLabel` is "Current" on most screens;
 * Trade's left segment reads "Build" — a trade being assembled is not a
 * current state — and Players' reads "Value", because on that board the left
 * segment is a KIND OF FIGURE (a price) rather than a tense. Tapping History
 * with one played season selects it directly; with more than one it opens the
 * picker sheet, and tapping the History segment while already in history
 * reopens the picker. `pickOnReturn` moves that first sheet to the second tap.
 */
export default function ScopeControl({
  value, onChange, seasons, currentLabel = "Current", historyLabel = "History",
  all, allTime, pickOnReturn,
}: {
  value: ScopeSel;
  onChange: (s: ScopeSel) => void;
  seasons: ScopeSeason[];
  currentLabel?: string;
  /** the RIGHT segment's resting label — what the tense is called before a
   *  season is picked. "History" everywhere it means the past as a whole;
   *  Players reads "Stats", because on that board the segment is not a period
   *  but a KIND OF FIGURE — production rather than price — and All-time is one
   *  of the things it can be scoped to rather than the thing it means. */
  historyLabel?: string;
  /** all-history mode: History is one tap to every season, no picker here —
   *  the screen filters by season itself. Pair with `useScope(…, { all })`. */
  all?: boolean;
  /** an "All-time" row at the top of the picker, selecting ALL_SEASONS. Pair
   *  with `useScope(…, { allowAll })`. */
  allTime?: boolean;
  /** THE FIRST TAP IS A SEASON, NOT A SHEET (Max, 2026-09-15). Where the right
   *  segment names a kind of figure rather than a period, tapping it should
   *  show that figure: the newest season in `seasons` is selected outright and
   *  the picker becomes the question a reader asks SECOND, on a tap that lands
   *  with the board already switched behind it. Off by default — on the
   *  screens whose right segment really does mean "the past", the sheet is the
   *  whole point of the tap. */
  pickOnReturn?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const onHistory = value.scope === "history";
  /** does the NEXT tap on the right segment open the sheet, or pick a season
   *  outright? One season is never worth a sheet; `pickOnReturn` spends the
   *  arrival tap on the season and the one after it on the sheet. */
  const sheetNext = seasons.length > 1 && (!pickOnReturn || onHistory);
  if (seasons.length === 0) return null;
  return (
    <>
      <div className="v3-scopectl" role="group" aria-label="Scope">
        <button className={onHistory ? "" : "on"}
          onClick={() => onChange({ scope: "current" })}>{currentLabel}</button>
        {all ? (
          <button className={onHistory ? "on" : ""}
            onClick={() => onChange({ scope: "history", season: ALL_SEASONS })}>{historyLabel}</button>
        ) : (
          <button className={onHistory ? "on" : ""}
            aria-haspopup={sheetNext ? "dialog" : undefined}
            onClick={() => {
              if (sheetNext) setPicking(true);
              else onChange({ scope: "history", season: seasons[0].id });
            }}>
            {onHistory ? (value.season === ALL_SEASONS ? "All-time" : value.season) : historyLabel}
            {/* the caret promises a sheet, so it appears only on the tap that
                opens one */}
            {sheetNext && <span className="caret">▾</span>}
          </button>
        )}
      </div>
      {picking && !all && (
        <Sheet label="Pick a season" title="Seasons" onClose={() => setPicking(false)}>
          {allTime && (
            <SheetRow on={onHistory && value.season === ALL_SEASONS}
              mark={onHistory && value.season === ALL_SEASONS ? "Here" : undefined}
              name="All-time" meta={`${seasons.length} seasons`}
              onClick={() => { setPicking(false); onChange({ scope: "history", season: ALL_SEASONS }); }} />
          )}
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
