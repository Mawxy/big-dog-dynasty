import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Team, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useCviQuery, useDviQuery, useProjWar1 } from "../../lib/useIndices";
import { ktcOf } from "../../lib/values";
import {
  lineupOf, optimalLineup, pInfo, POS_CHIPS, rosterSeasonOf,
} from "../../lib/league";
import { useMobile } from "../../lib/useWidth";
import {
  Band, DataError, fmtWar, IdCell, LensStrip, NUL, Spine, sortBy, TapRow, Th,
  useBetaPath, useSort,
} from "../ui";
import "./players.css";
import "./teams.css";

/**
 * TEAMS — the Players board, one row per franchise.
 *
 * Deliberately the SAME OBJECT as screens/Players, not a franchise page with a
 * table on it: same five currencies, same sortable headers, same phone sort
 * strip, same row drawer, same type ramp. That is why this file imports
 * `players.css` rather than restating it — a second stylesheet describing the
 * same board is how the two would drift into looking like two kinds of thing.
 * `teams.css` holds only what this screen has and that one does not, which is
 * the second chip group.
 *
 * WHAT A ROW IS. A franchise's figures are SUMS over a slice of its roster —
 * not averages. An average would say "how good is the typical player here",
 * which is a question about a roster's shape; this board answers "how much is
 * on this roster", and depth is part of that answer. It is also the only
 * reading under which KTC on this screen matches KTC on the Team screen.
 *
 * ONE STARTERS SET, PRICED FIVE WAYS. The optimal lineup is currency-specific —
 * the best DVI lineup and the best projected-WAR lineup are not the same nine
 * players — so if each column chose its own the row would be summing five
 * different sets of people under one label, and "Starters" would mean something
 * different in every column. The set is chosen ONCE, by projected WAR, which is
 * the rule the League screen's power rankings already state, and the other four
 * currencies are summed over that same set.
 *
 * NO ECR COLUMN, unlike Players. ECR is a rank, and ranks do not add: the sum
 * of twelve consensus ranks is not a franchise's consensus rank, it is a number
 * that rewards holding nobody. The other five are quantities and do.
 *
 * NO PICKS. Every figure here comes from a player's row in an index or a market
 * file, and a pick has neither a DVI nor a CVI (More's glossary: "a pick has a
 * price and a WAR stream, never an index of its own"). Three columns of five
 * could count picks and two could not, so none do, and the note says so. The
 * League screen's Market column is the figure that includes them.
 */

/* ========================================================================
   COLUMNS
   ======================================================================== */

type Key = "dvi" | "cvi" | "war" | "ktc" | "fc";

interface Col {
  id: Key;
  label: string;
  /** the label on the sort strip and the micro line, where "FantasyCalc" has
   *  no room to be itself */
  short?: string;
  /** percentage width, declared on the header cell — never pixels, which break
   *  under viewport squish, and never a <colgroup>, which the runtime strips */
  width: string;
  /** first column of a group: takes the group divider */
  edge?: boolean;
}

/* The same left-to-right reading as the Players board: our own model first,
   then what the dynasty market pays. Where they disagree is the point, so they
   are never blended and never totalled together. */
const COLS: Col[] = [
  { id: "dvi", label: "DVI", width: "11%", edge: true },
  { id: "cvi", label: "CVI", width: "11%" },
  { id: "war", label: "Proj WAR", short: "WAR", width: "15%" },
  { id: "ktc", label: "KTC", width: "12%", edge: true },
  { id: "fc", label: "FantasyCalc", short: "FC", width: "13%" },
];
const GRPS = [
  { label: "Our model", span: 3 },
  { label: "Dynasty market", span: 2 },
];

/** four is the ceiling at 390px — see players.css. FantasyCalc stays on the
 *  desktop header and in the drawer, where there is room to sort by it. */
const STRIP: Key[] = ["dvi", "cvi", "war", "ktc"];

/**
 * A TEAM TOTAL IS AN INTEGER in every currency but WAR.
 *
 * The per-player board carries DVI and CVI to one decimal because the figure
 * is 0–100 and the tenth separates two players. Summed over nine starters the
 * figure is in the hundreds and the tenth is noise a mono column pays width
 * for — the Team screen already rounds it ("523 index pts, starters"), and the
 * two screens have to agree or the same roster reads as two numbers.
 */
const FMT: Record<Key, (v: number) => string> = {
  dvi: v => Math.round(v).toLocaleString(),
  cvi: v => Math.round(v).toLocaleString(),
  war: fmtWar,
  ktc: v => Math.round(v).toLocaleString(),
  fc: v => Math.round(v).toLocaleString(),
};

/** what a figure is measured in, under the drawer's cells */
const UNIT: Record<Key, string> = {
  dvi: "index pts", cvi: "index pts", war: "wins, year 1",
  ktc: "market pts", fc: "market pts",
};

const figOf = (id: Key, v: number | null): ReactNode => v == null ? NUL : FMT[id](v);

/* ---- the roster slice ---------------------------------------------------- */

type Slice = "all" | "start" | "bench";

const SLICES: { id: Slice; label: string }[] = [
  { id: "all", label: "Roster" },
  { id: "start", label: "Starters" },
  { id: "bench", label: "Bench" },
];

const SLICE_NOTE: Record<Slice, string> = {
  all: "Every rostered player, taxi and IR included — draft picks are not priced here",
  start: "The best legal lineup by projected WAR, not the lineup as set",
  bench: "Everyone the best legal lineup leaves out, taxi and IR included",
};

/* ========================================================================
   ROWS
   ======================================================================== */

/** one player, priced in all five currencies at once */
interface Asset {
  pid: string;
  name: string;
  pos: string;
  /** projected year-1 WAR, and the ONLY currency the lineup optimiser reads */
  war: number;
  f: Record<Key, number | null>;
}

interface Row {
  rid: number;
  team: string;
  manager: string;
  /** how many players the current slice holds — the sample behind every figure
   *  on the row, and the reason a Bench row is not comparable to a Starters one */
  n: number;
  f: Record<Key, number | null>;
  /** the slice's totals split by position, for the drawer. Always all four,
   *  regardless of the position chip — the chip isolates one, this states the
   *  shape the chip is picking from. */
  byPos: Record<string, number | null>;
  /** the largest single holding in the sorted currency */
  top: { name: string; v: number } | null;
}

const ZERO = (): Record<Key, number | null> =>
  ({ dvi: null, cvi: null, war: null, ktc: null, fc: null });

/** Sum a currency over a set of assets. A player the source never priced is
 *  ABSENT, not zero — and a set in which nobody was priced returns null, so an
 *  unpriced bench reads as the em dash rather than as a bench worth nothing. */
function total(assets: Asset[], k: Key): number | null {
  let sum = 0, seen = 0;
  for (const a of assets) {
    const v = a.f[k];
    if (v == null) continue;
    sum += v; seen++;
  }
  return seen ? sum : null;
}

/* ========================================================================
   THE SCREEN
   ======================================================================== */

export default function Teams() {
  const { meta, players, league } = useLeague();
  const betaPath = useBetaPath();
  const rosterSeason = rosterSeasonOf(league);

  const [slice, setSlice] = useState<Slice>("start");
  const [pos, setPos] = useState("ALL");
  const [open, setOpen] = useState<number | null>(null);

  /* 900px, not style.css's 640px: the beta shell's own desktop breakpoint is
     where the nav bar becomes a rail and the tables gain their padding. */
  const mobile = useMobile("(max-width: 899px)");
  const s = useSort<Key>("dvi");

  const dviQ = useDviQuery();
  const cviQ = useCviQuery();
  // YEAR-1 projected WAR, the same figure the Players board's Proj WAR column
  // carries and the same one the League screen's power rankings sum.
  const projWar = useProjWar1();
  const valsQ = useJson<Values>("data/values.json", "globalDaily");
  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);

  /* ---- every roster, priced ---------------------------------------------- */

  /** THE SLICE IS COMPUTED ONCE PER ROSTER, not per render of a row: the
   *  optimiser runs over the whole roster and the two slices fall out of the
   *  one starters set, so Starters and Bench are provably complementary. */
  const priced = useMemo(() => {
    const dvi = dviQ.data, cvi = cviQ.data, teams = teamsQ.data;
    if (!dvi || !cvi || !teams || !projWar) return null;
    const lineup = lineupOf(meta);
    return teams.map(t => {
      const assets: Asset[] = t.players.map(pid => {
        const d = dvi.players[pid];
        const v = valsQ.data?.players?.[pid];
        return {
          pid,
          name: pInfo(players, pid)[0],
          // the INDEX's position where it has one: it is the position the
          // figure was computed for, so a pool built from it cannot seat a
          // player in a slot his price was never measured in
          pos: d?.pos ?? players[pid]?.[1] ?? "?",
          war: projWar[pid] ?? 0,
          f: {
            dvi: d?.dvi ?? null,
            cvi: cvi.players[pid]?.cvi ?? null,
            war: projWar[pid] ?? null,
            // through ktcOf, never row.ktc: KTC publishes four ladders and this
            // league sits on one of them (meta.tep). Reading the base column
            // prices a TE-premium league's tight ends in the wrong market.
            ktc: ktcOf(v, meta.tep),
            fc: v?.fc ?? null,
          },
        };
      });
      const { starters } = optimalLineup(
        assets.map(a => ({ id: a.pid, pos: a.pos, war: a.war })), lineup);
      return {
        rid: t.roster_id, team: t.team, manager: t.manager,
        all: assets,
        start: assets.filter(a => starters.has(a.pid)),
        bench: assets.filter(a => !starters.has(a.pid)),
      };
    });
  }, [dviQ.data, cviQ.data, teamsQ.data, valsQ.data, projWar, players, meta]);

  const rows = useMemo<Row[] | null>(() => {
    if (!priced) return null;
    return priced.map(p => {
      const inSlice = p[slice];
      const kept = pos === "ALL" ? inSlice : inSlice.filter(a => a.pos === pos);
      const f = ZERO();
      for (const k of Object.keys(f) as Key[]) f[k] = total(kept, k);
      const byPos: Record<string, number | null> = {};
      for (const q of ["QB", "RB", "WR", "TE"])
        byPos[q] = total(inSlice.filter(a => a.pos === q), s.sort);
      let top: Row["top"] = null;
      for (const a of kept) {
        const v = a.f[s.sort];
        if (v != null && (top == null || v > top.v)) top = { name: a.name, v };
      }
      return {
        rid: p.rid, team: p.team, manager: p.manager,
        n: kept.length, f, byPos, top,
      };
    });
  }, [priced, slice, pos, s.sort]);

  const ordered = useMemo(
    () => rows ? sortBy(rows, r => r.f[s.sort], s.dir) : null,
    [rows, s.sort, s.dir]);

  // Changing the slice restates every figure on the board, so an open drawer
  // would be answering the previous question. Sorting and the position chips
  // deliberately do NOT close it: those re-order and narrow the same twelve
  // rows, and the drawer re-reads the sorted currency as it goes.
  useEffect(() => { setOpen(null); }, [slice]);

  /* ---- the phone row's demoted keys ------------------------------------- */

  const micro = useMemo(
    () => STRIP.filter(k => k !== s.sort).slice(0, 3), [s.sort]);

  const queries = [dviQ, cviQ, valsQ, teamsQ];
  const ready = ordered != null && !queries.some(x => x.loading);
  /* A FAILED FETCH IS NOT A SLOW ONE. Stated as "everything settled and there
     is still no board" rather than as "something errored": useDviQuery reports
     the missing index_models.json that sent it to the dvi.json fallback, and
     that fallback usually lands. */
  const failed = ordered == null
    && !queries.some(x => x.loading) && queries.some(x => x.error);

  const colOf = (id: Key) => COLS.find(c => c.id === id)!;
  /* Two identity columns plus the figure columns on desktop; spine, identity
     and the one figure cell on a phone. The drawer spans whatever that is. */
  const span = mobile ? 3 : 2 + COLS.length;

  return (
    <>
      <div className="v3-head">
        <h1>Teams</h1>
        <span className="sub">
          what the twelve rosters are worth
          {pos === "ALL" ? "" : ` · ${pos} only`}
        </span>
      </div>

      {/* TWO CHIP GROUPS, ONE ROW, and neither of them is gold. Both FILTER —
          they change which players a row is built from, not how the rows are
          ordered — so they take the `--sel` fill the beta shell already uses
          for "this subset is selected", and the accent stays on the sort. That
          is the same call players.css makes about its position chips, which is
          why this screen reuses that override rather than writing a second. */}
      <div className="v3-filters plx-filters tmx-filters">
        {SLICES.map(x => (
          <button key={x.id} type="button" className={`chip${slice === x.id ? " on" : ""}`}
            onClick={() => setSlice(x.id)}>{x.label}</button>
        ))}
        <span className="tmx-sep" aria-hidden="true" />
        {POS_CHIPS.map(p => (
          <button key={p} type="button" className={`chip${pos === p ? " on" : ""}`}
            onClick={() => setPos(p)}>{p}</button>
        ))}
      </div>

      {mobile && (
        <div className="plx-sort">
          <span className="k">Sort</span>
          {/* A key picker, not a toggle: a mis-tap on the segment that is
              already lit silently reversing the whole board is not a control
              anyone can read. Re-tapping the lit segment is a no-op. */}
          <LensStrip label="Sort" value={s.sort}
            onChange={k => { if (k !== s.sort) s.onSort(k); }}
            options={STRIP.map(k => {
              const c = colOf(k);
              return { id: k, label: c.short ?? c.label };
            })} />
        </div>
      )}

      <Band label={`${SLICES.find(x => x.id === slice)!.label} · ${rosterSeason}`}
        note={SLICE_NOTE[slice]} />

      {failed ? <DataError what="The board didn't load" />
        : !ready || !ordered ? <div className="empty">Loading…</div> : (
        <table className="v3tbl plx-tbl plx-cur">
          {!mobile && (
            <thead>
              <tr className="plx-grp">
                <th className="sp" />
                <th className="t" />
                {GRPS.map(g => (
                  <th key={g.label} className="plx-edge" colSpan={g.span}>{g.label}</th>
                ))}
              </tr>
              <tr className="plx-cols">
                <th className="c sp">#</th>
                <th className="t">Franchise</th>
                {COLS.map(c => (
                  <Th key={c.id} id={c.id} label={c.label} align="n" width={c.width}
                    sort={s.sort} onSort={s.onSort} />
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {ordered.map((r, i) => (
              /* KEYED BY RID, and the drawer keyed with it. Sorting reorders
                 these nodes in place rather than remounting the list, which is
                 what keeps the reader's scroll position where they left it. */
              <Fragment key={r.rid}>
                <TapRow className={`${i % 2 ? "zebra" : ""}${open === r.rid ? " plx-on" : ""}`}
                  onTap={() => setOpen(open === r.rid ? null : r.rid)}>
                  {/* No accent on the leader's ordinal. "Top by whatever you
                      last sorted by" is not a threshold, and this screen spends
                      its accent on the sort. No position colour either — a
                      franchise has no position. */}
                  <Spine rank={i + 1} />
                  {/* THE NAME IS THE LINK, THE ROW IS THE DRAWER — the Players
                      board's split. The name goes straight to the team page;
                      anywhere else on the row opens the drawer in place. */}
                  <IdCell name={r.team} to={betaPath(`/team/${r.rid}`)}
                    sub={`${r.manager} · ${r.n} player${r.n === 1 ? "" : "s"}`} />
                  {mobile ? (
                    <td className="n plx-lead">
                      <span className="f hd">{figOf(s.sort, r.f[s.sort])}</span>
                      {micro.length > 0 && (
                        <div className="plx-micro">
                          {micro.map(k => (
                            <span key={k} className="o">
                              {(colOf(k).short ?? colOf(k).label).toUpperCase()}
                              <b>{figOf(k, r.f[k])}</b>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  ) : COLS.map(c => (
                    <td key={c.id} className={`n${c.edge ? " plx-edge" : ""}`}>
                      <span className={`f${c.id === s.sort ? " hd" : ""}`}>
                        {figOf(c.id, r.f[c.id])}
                      </span>
                    </td>
                  ))}
                </TapRow>
                {open === r.rid && (
                  <tr className="plx-drawrow">
                    <td colSpan={span}>
                      <Drawer r={r} k={s.sort} slice={slice}
                        to={betaPath(`/team/${r.rid}`)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      <div className="tnote screen">
        Every figure is a SUM over the slice above — depth counts, so a Roster figure and
        a Starters figure are different questions and not two readings of one. The starters
        set is chosen once, by projected WAR, and then priced in all five currencies: the
        best DVI lineup and the best projected-WAR lineup are not the same nine players, and
        a row whose columns each picked their own would be summing five different sets under
        one label. DVI and CVI are index points, not value, and the two markets are in their
        own currencies — none of the five are blended. Draft picks are not counted anywhere
        on this board: a pick has a price and a WAR stream but no index of its own, so three
        columns could carry it and two could not. What each player is worth on his own is
        under Players.
      </div>
    </>
  );
}

/* ========================================================================
   THE DRAWER

   Below the row, inside the table flow, with the accent top rule — never a
   modal and never appended after the table, which on a phone would open the
   detail eleven rows below the row that was tapped.

   Six cells, the same grid the Players drawers use, and every one of them is
   in the SORTED currency: the row above states one number per currency, so the
   question a drawer answers is "where does that number come from", not "what
   are the other four".
   ======================================================================== */

function Fig({ k, v, sub, word }: {
  k: string; v: ReactNode; sub?: ReactNode;
  /** a name — a word in a figure slot, not a numeral */
  word?: boolean;
}) {
  return (
    <div>
      <div className="k">{k}</div>
      <div className={word ? "v w" : "v"}>{v}</div>
      {sub != null && <div className="s">{sub}</div>}
    </div>
  );
}

function Drawer({ r, k, slice, to }: {
  r: Row; k: Key; slice: Slice; to: string;
}) {
  const nav = useNavigate();
  const label = COLS.find(c => c.id === k)!.label;
  const sliceLabel = SLICES.find(x => x.id === slice)!.label.toLowerCase();
  return (
    <div className="plx-draw">
      <div className="hd">
        <span className="nm">{r.team}</span>
        <span className="mt">{r.manager} · {label} by position</span>
      </div>
      <div className="plx-figs">
        {["QB", "RB", "WR", "TE"].map(q => (
          <Fig key={q} k={q} v={r.byPos[q] == null ? NUL : FMT[k](r.byPos[q]!)}
            sub={r.byPos[q] == null ? "nobody priced" : UNIT[k]} />
        ))}
        {/* THE SLICE'S SIZE, because every figure above it is a sum and a sum
            without its sample is not comparable across rows. */}
        <Fig k="Players" v={r.n} sub={`in the ${sliceLabel}`} />
        {/* The largest single holding, which is what a sum hides: two rosters
            can total the same and one of them is one player. */}
        <Fig k="Biggest" v={r.top?.name ?? NUL} word
          sub={r.top ? `${FMT[k](r.top.v)} ${UNIT[k]}` : "nobody priced"} />
      </div>
      <div className="plx-note">
        The four position totals cover the whole {sliceLabel}, not the position chip's
        selection — the chip isolates one of these, and the split is what it is picking
        from. Every cell is in {label}; change the sort to re-read the drawer in another
        currency.
      </div>
      <a className="plx-go" href={`#${to}`}
        onClick={e => {
          e.stopPropagation();
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault(); nav(to);
        }}>Team page</a>
    </div>
  );
}
