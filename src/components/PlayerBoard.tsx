import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Col, Grp } from "./DataTable";
import { POS_CHIPS, POS_COLOR } from "../lib/league";
import { useLeaguePath } from "../lib/context";
import { PlayerLink } from "./PlayerLink";

/**
 * Shared parts of the two player leaderboards.
 *
 * Value and Stats are separate screens because they answer different
 * questions — what a player is worth now, and what he did in a given year —
 * but they draw the same population and must stay recognisable across a tab
 * switch. So the identity block, the row shape and the filter bar live here
 * and are imported by both. Only the numeric columns differ, which is the
 * whole reason the pages are split.
 *
 * One Row type carries both sides' fields. Two row types would mean two
 * DataTable instantiations and two Col registries, and the identity columns —
 * the thing that must be literally identical — would have to be duplicated
 * across them.
 */
export interface PlayerRow {
  id: string; nm: string; pos: string; nfl: string; team: string;
  /** rank within position for the ACTIVE sort — assigned after sorting */
  posRank: number;
  /* value board */
  dvi: number | null; cvi: number | null; war1: number | null;
  /** the analog model's year-1 median — experimental, shown beside war1 so the
   *  two can be compared rather than swapped between */
  warK: number | null;
  ktc: number | null; fc: number | null; ecr: number | null;
  /* stats board */
  gp: number; pts: number; ppg: number; sdv: number; war: number; warG: number;
}

export interface BoardCtx { warMax: number }

export type PlayerCol = Col<PlayerRow, BoardCtx>;

export const nul = <span className="fig quiet">—</span>;
/** indices are bare figures, never metered — clamped 0–100 scores */
export const idxCell = (v: number | null) =>
  v == null ? nul : <span className="head-fig md">{v.toFixed(1)}</span>;
export const srcCell = (v: number | null, text: string) =>
  v == null ? nul : <span className="head-fig src">{text}</span>;

/** a blank row, so a source that knows only some fields can still create one */
export const blankRow = (id: string, nm: string, pos: string, nfl: string): PlayerRow => ({
  id, nm, pos, nfl, team: "—", posRank: 0,
  dvi: null, cvi: null, war1: null, warK: null, ktc: null, fc: null, ecr: null,
  gp: 0, pts: 0, ppg: 0, sdv: 0, war: 0, warG: 0,
});

/**
 * The identity block. `nfl` is optional because the Value board spends its
 * column budget on six numeric measures and would otherwise run to eleven
 * columns, one over the cap — and on a value board the affiliation that
 * matters is the fantasy roster, not the NFL club. Every other screen keeps
 * it.
 */
export function identityCols(opts: { nfl?: boolean } = {}): PlayerCol[] {
  const { nfl = true } = opts;
  return [
    {
      id: "rk", label: "Rk", grp: 0, w: 4, align: "c", td: "spine-cell",
      cell: (r, _x, i) => <>
        <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }} />
        <span className="rank">{i + 1}</span>
      </>,
    },
    {
      id: "nm", label: "Player", grp: 0, w: 0, align: "t", td: "t name", asc: true,
      sort: r => r.nm, cell: r => <PlayerLink pid={r.id} name={r.nm} />,
    },
    {
      id: "pos", label: "Pos", grp: 0, w: 6, align: "c", td: "c",
      cell: r => <span className={`pos ${r.pos}`}>{r.pos}{r.posRank || ""}</span>,
    },
    ...(nfl ? [{
      id: "nfl", label: "NFL", grp: 0, w: 6, align: "c", hm: true, td: "sub hm c",
      sort: (r: PlayerRow) => r.nfl, cell: (r: PlayerRow) => r.nfl || "—",
    } as PlayerCol] : []),
    {
      // in the phone budget (MOBILE.md M4): the roster is the affiliation a
      // reader scans for, so it survives the pan — reordered after the
      // figures by each board's mobile subset
      id: "team", label: "Roster", grp: 0, w: 14, align: "t", td: "t sub",
      sort: r => r.team, cell: r => r.team,
    },
  ];
}

/**
 * The phone column budget (MOBILE.md M4): Rk, Player, Pos, the board's three
 * lens figures, then Roster. Ten columns at 390px is a 900px pan and the
 * reader gives up — six is the budget, and the figures come before the roster
 * so the pan reaches them sooner. Everything dropped here is on the player
 * page; that is what the page is for.
 *
 * Roster moves BEHIND the figure groups, so it gets a trailing banner group of
 * its own — without it the group spans would land over the wrong columns.
 */
export const TAIL_GRP: Grp = { id: 9, label: "", cls: "edge" };

/** a column with its group-divider edge forced on or off, td classes included */
function edged(c: PlayerCol, on: boolean): PlayerCol {
  if (!!c.edge === on) return c;
  const td = c.td.split(" ").filter(t => t && t !== "edge");
  if (on) td.push("edge");
  return { ...c, edge: on, td: td.join(" ") };
}

export function mobileCols(cols: PlayerCol[], figIds: string[]): PlayerCol[] {
  const by = new Map(cols.map(c => [c.id, c]));
  const team = by.get("team");
  return [
    ...["rk", "nm", "pos"].map(id => by.get(id)),
    // the first figure starts its group, so it carries the divider
    ...figIds.map((id, j) => by.get(id) && edged(by.get(id)!, j === 0)),
    team && { ...edged(team, true), grp: TAIL_GRP.id },
  ].filter((c): c is PlayerCol => !!c);
}

/**
 * The Players tab's own scope switch: which of the two boards you are on.
 *
 * It sits in the title row, above the year spine, because it is a different
 * axis — Value has no year and Stats has nothing but. Folding both into one
 * chip row is what the old lens control did, and it made "2024" and "Market"
 * look like alternatives of the same kind.
 */
export function BoardScope({ on }: { on: "value" | "stats" }) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const chip = (label: string, to: string, sel: boolean) => (
    <button type="button" className={`chip ${sel ? "on" : ""}`}
      onClick={() => nav(lp(to))}>{label}</button>
  );
  return <>
    {chip("Value", "/value", on === "value")}
    {chip("Stats", "/stats", on === "stats")}
  </>;
}

/**
 * Position chips and the name search, as one filter state every player board
 * uses. Returned as state plus an element so the caller owns placement — Value
 * and Stats put their own scope chips in the row above it.
 *
 * Generic over the row so the two index leaderboards (DVI, CVI) get literally
 * this bar rather than a second, chips-only one of their own: filtering is the
 * same affordance wherever a list of players is, and it only ever reads `pos`
 * and `nm`.
 */
export function usePlayerFilters<T extends { pos: string; nm: string } = PlayerRow>(
  onChange?: () => void,
) {
  const [pos, setPos] = useState("ALL");
  /**
   * The query the FILTER reads — one beat behind the box, deliberately, and
   * owned here rather than in the box.
   *
   * The board's row memo lists `apply` as a dep, so every keystroke re-filtered
   * the population AND re-rendered every row on screen: ~390 rows of ten cells,
   * six times in the second it takes to type a surname. `SearchBox` keeps the
   * letters to itself so the board is not re-rendered mid-word at all, and
   * hands the query up once the typing settles.
   */
  const [qd, setQd] = useState("");

  const bar = (
    <div className="screen-head" style={{ paddingTop: 0 }}>
      {POS_CHIPS.map(p => (
        <button key={p} className={`chip ${pos === p ? "on" : ""}`}
          onClick={() => { setPos(p); onChange?.(); }}>{p === "ALL" ? "All" : p}</button>
      ))}
      {/* setQd is a setState function, so its identity is stable and the
          debounce timer below is never restarted by a parent re-render */}
      <SearchBox onQuery={setQd} />
    </div>
  );

  /** Applied AFTER sorting and position-ranking, so RB4 stays RB4 in an RB-only
   *  view. Memoized on pos/qd because both boards list it as a dep of the memo
   *  that filters the population — a fresh identity every render would re-run
   *  that pass on every keystroke anywhere on the page. */
  const apply = useCallback((rows: T[]) => {
    let rs = rows;
    if (pos !== "ALL") rs = rs.filter(r => r.pos === pos);
    if (qd) rs = rs.filter(r => r.nm.toLowerCase().includes(qd.toLowerCase()));
    return rs;
  }, [pos, qd]);

  return { bar, apply };
}

/**
 * The name box. Owns the letters; publishes the query 150ms after the last
 * one. The input stays controlled and instant — it is this component that
 * re-renders per keystroke, and it is one input, not a leaderboard.
 */
function SearchBox({ onQuery }: { onQuery: (q: string) => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => onQuery(q), 150);
    return () => clearTimeout(t);
  }, [q, onQuery]);
  return (
    <input type="search" placeholder="Search player…" value={q}
      onChange={e => setQ(e.target.value)} />
  );
}
