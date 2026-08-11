import { useMemo, type ReactNode } from "react";
import type { CviFile, CviRow, DviFile, DviRow, Team } from "../lib/types";
import { useJson } from "../lib/useJson";
import { ownerOf, rosterSeasonOf, POS_COLOR } from "../lib/league";
import { useLeague } from "../lib/context";
import { PlayerLink } from "./PlayerLink";
import PosBadge from "./PosBadge";
import { usePlayerFilters } from "./PlayerBoard";
import DataTable, { type Col, type Grp } from "./DataTable";

/**
 * A 0–100 index leaderboard: rank, player, position, roster, one figure.
 *
 * DVI and CVI render the same board with a different file and field — they
 * were two byte-identical views before this. `pick` names the value field in
 * the file's player records ("dvi" in dvi.json, "cvi" in cvi.json).
 *
 * Structurally this is the Players hub's board with one measure instead of
 * six: same screen header, same filter bar, same identity columns, same rank
 * spine. It used to hang its position chips off the right edge of the title
 * row and drop the alignment classes, so the two index pages were the only
 * leaderboards on the site that didn't read like the rest of them.
 */
/** The index this row carries — the file names it, so the row is narrowed by
 *  which key it has rather than by the `pick` prop it was fetched with. */
const valueOf = (r: DviRow | CviRow) => ("dvi" in r ? r.dvi : r.cvi) ?? 0;

/** what the shared filter bar needs, plus what this board draws */
interface IdxRow {
  pid: string; nm: string; pos: string; posRank: number; value: number;
}

/** The roster column's data is per-render, not per-row: `owners` is built from
 *  teams.json and lands after the index file, and the population memo is keyed
 *  on the FILE alone so a name search never re-sorts ~800 rows. So the owners
 *  map travels as DataTable's context rather than being folded into the row. */
interface IdxCtx { owners: Record<string, string> }

/**
 * Rank, player, position, roster, one figure — the same identity block every
 * board on the site opens with, so the two index pages read like the rest of
 * them. Declared once, at module scope: DataTable memoizes a row on the
 * identity of the column array, and a registry rebuilt per render would defeat
 * it on a board that runs to 780 rows.
 */
const COLS: Col<IdxRow, IdxCtx>[] = [
  {
    /* 7%, not 5%: this board runs to 780 scored players, so the rank reaches
       three digits — and at 5% of a phone-width table that is a ~30px column
       holding a ~43px figure, drawn over the name */
    id: "rk", label: "Rk", grp: 0, w: 7, align: "c", td: "spine-cell",
    cell: (r, _x, i) => <>
      <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }} />
      <span className="rank">{i + 1}</span>
    </>,
  },
  {
    id: "nm", label: "Player", grp: 0, w: 0, align: "t", td: "t name",
    cell: r => <PlayerLink pid={r.pid} name={r.nm} />,
  },
  {
    id: "pos", label: "Pos", grp: 0, w: 8, align: "c", td: "c",
    cell: r => (
      <PosBadge pos={r.pos} size="wide" rank={r.posRank}
        color={POS_COLOR[r.pos] || "var(--rule-2)"} />
    ),
  },
  {
    id: "team", label: "Roster", grp: 0, w: 22, align: "t", hm: true, td: "t sub hm",
    cell: (r, x) => x.owners[r.pid] || "—",
  },
  {
    /* a bare figure, no meter: the index is a clamped 0–100 score, and a bar
       would restate the number (SKILL §3) */
    id: "idx", label: "Index", grp: 1, w: 28, align: "n", keyCol: true, td: "n",
    cell: r => <span className="head-fig md">{r.value.toFixed(1)}</span>,
  },
];

/**
 * No column declares a `sort` accessor, so no header is a control and the board
 * keeps the file's own order — which is what the rank spine and the file's own
 * `pos_rank` on the badge both describe. Re-sorting by name would leave the
 * badge claiming a rank the table is no longer in (SKILL §3). DataTable still
 * takes the three sort props, so they are handed in inert.
 */
const NO_SORT = () => {};

export default function IndexBoard({ file, pick, title, note, footnote }: {
  file: string; pick: "dvi" | "cvi"; title: string;
  /** the band's methodology line — what this index is measured against */
  note: string;
  footnote: ReactNode;
}) {
  const { league } = useLeague();
  const { bar, apply } = usePlayerFilters<IdxRow>();

  // DVI and CVI are the same component on two routes: useJson clears the old
  // file's data the moment `file` changes, so a switch between them can never
  // print one index's numbers under the other's title, however the two fetches
  // happen to race.
  const idx = useJson<DviFile | CviFile>(file, "leagueDaily");
  const data = idx.data;
  const err = idx.error;
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const owners = useMemo(() => (teams ? ownerOf(teams) : {}), [teams]);

  /** Sorted on the full population — keyed on the FILE only, so typing a name
   *  doesn't rebuild and re-sort ~800 rows per keystroke. */
  const population = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.players)
      .map(([pid, r]): IdxRow => ({
        pid, nm: r.name, pos: r.pos, posRank: r.pos_rank, value: valueOf(r),
      }))
      .sort((a, b) => b.value - a.value);
  }, [data]);

  /** …then filtered, so a position view keeps the ranks the whole board gave
   *  it (`posRank` comes from the file and is never recomputed here). */
  const rows = useMemo(() => apply(population), [population, apply]);
  const ctx = useMemo<IdxCtx>(() => ({ owners }), [owners]);

  const label = pick.toUpperCase();
  /* the band above the table names the index; the group banner names it again
     over the one column that carries it, and takes the accent because that is
     the screen's headline figure. No `edge`: the index column has never had a
     divider on its left and adding one would be a new rule on the board. */
  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label, cls: "value" },
  ];
  if (err) return <div className="empty">No {label} data yet.</div>;
  if (!data) return <div className="empty">Loading {label}…</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{title}</span>
        <span className="screen-note">
          Generated {data.generated} · <b>{rows.length}</b> shown
        </span>
      </div>
      {bar}

      <div className="band">
        <span className="band-label">{label} · every scored player</span>
        <span className="band-note">{note}</span>
      </div>

      {/* the band above says what this is, but a band is a sibling of the
          table, not part of it — a reader landing on the table hears only
          "table" without the label DataTable puts on it. This board PANS on a
          phone rather than becoming records: it is the Players leaderboard's
          own family, and the pinned identity block is what keeps a figure
          attached to its player while it scrolls (MOBILE.md). */}
      <DataTable cols={COLS} groups={groups} rows={rows} ctx={ctx}
        label={`${label} · every scored player`}
        rowKey={r => r.pid} sortId="" dir={-1} onSort={NO_SORT} />

      <div className="tnote screen">{footnote}</div>
    </>
  );
}
