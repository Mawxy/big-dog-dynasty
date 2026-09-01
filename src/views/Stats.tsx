import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { meterWidth, fmt, fmtWar } from "../lib/stats";
import { latestSeasonOf, ownerOf, pInfo, seasonSeg } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { useSeasonData } from "../lib/useSeasonData";
import PlayerPanel from "../components/PlayerPanel";
import AllTimePanel from "../components/AllTimePanel";
import DataTable, { applySort, sortCol, useTableSort } from "../components/DataTable";
import { useMobile } from "../lib/useWidth";
import {
  BoardScope, blankRow, identityCols, mobileCols, TAIL_GRP, usePlayerFilters,
  type BoardCtx, type PlayerCol, type PlayerRow,
} from "../components/PlayerBoard";

/**
 * STATS — what every player actually did, one played season at a time.
 *
 * The year spine is the whole screen: a played season, or all-time. It carries
 * no value columns at all, which is the point of splitting it from Value —
 * a season's record and a player's current price are measured against
 * different things and were only ever sharing a table because they shared a
 * population.
 *
 * All-time is a scope on this spine rather than a screen of its own, but it is
 * a genuinely different column set: total points replace volatility (a career
 * σ across seasons of different lengths isn't a number anyone should read),
 * and the drawer shows the career ladder instead of one season's weeks.
 */
const seasonCols = (allTime: boolean): PlayerCol[] => [
  ...identityCols(),
  {
    id: "gp", label: "GP", grp: 1, w: 6, align: "n", edge: true,
    td: "fig quiet edge n", sort: r => r.gp, cell: r => r.gp,
  },
  ...(allTime ? [{
    id: "pts", label: "Pts", grp: 1, w: 8, align: "n", hm: true,
    td: "fig hm n", sort: (r: PlayerRow) => r.pts, cell: (r: PlayerRow) => fmt(r.pts, 1),
  } as PlayerCol] : []),
  {
    id: "ppg", label: "PPG", grp: 1, w: 7, align: "n", td: "fig strong n",
    sort: r => r.ppg, cell: r => fmt(r.ppg),
  },
  ...(allTime ? [] : [{
    id: "sdv", label: "Volatility", grp: 1, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: (r: PlayerRow) => r.sdv, cell: (r: PlayerRow) => fmt(r.sdv, 1),
  } as PlayerCol]),
  {
    id: "war", label: "WAR", grp: 2, w: 15, align: "n", edge: true, keyCol: true,
    td: "n edge", sort: r => r.war,
    cell: (r, x) => (
      <div className="meter-row">
        <div className="meter"><i style={{ width: meterWidth(Math.max(0, r.war), x.warMax) }} /></div>
        <span className="fig">{fmtWar(r.war)}</span>
      </div>
    ),
  },
  {
    id: "warG", label: "WAR/G", grp: 2, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: r => r.warG, cell: r => fmtWar(r.warG),
  },
];
const GROUPS = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Production", cls: "edge" },
  { id: 2, label: "Wins added", cls: "edge value" },
];

export default function Stats() {
  const { meta, players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const seg = useParams().season;

  const latest = latestSeasonOf(meta);
  /** newest first — the year a reader wants is almost always the last one played */
  const played = useMemo(
    () => meta.seasons.filter(s => s <= latest).slice().reverse(), [meta, latest]);

  /** a played season, or "ALL"; an unknown segment falls back to the latest */
  const scope = !seg ? latest
    : seg.toLowerCase() === "all" ? "ALL"
      : played.includes(seg) ? seg : latest;
  const allTime = scope === "ALL";

  const data = useSeasonData(scope);

  const { sortId, dir, onSort, reset: resetSort } = useTableSort("war");
  const [openPid, setOpenPid] = useState<string | null>(null);
  // the league's fantasy teams for this scope, for the bar's roster select —
  // same source the Roster column reads, so the options match the cells
  // (All-time mode's teams.json is current ownership, and so is its column)
  const fantasyTeams = useMemo(
    () => data ? [...new Set(data.teams.map(t => t.team))].sort((a, b) => a.localeCompare(b)) : undefined,
    [data]);
  const { bar, apply } = usePlayerFilters(() => setOpenPid(null), { teams: fantasyTeams });

  // a scope change resets to the resting order and closes the drawer
  useEffect(() => {
    resetSort();
    setOpenPid(null);
  }, [scope, resetSort]);

  // MOBILE.md M4 — pan the board, six-column budget. WAR leads (it is the
  // resting sort), then PPG and GP, then Roster; volatility and the per-game
  // rates are on the player page.
  const mobile = useMobile();
  const cols = useMemo(() => {
    const all = seasonCols(allTime);
    return mobile ? mobileCols(all, ["war", "ppg", "gp"]) : all;
  }, [allTime, mobile]);
  // banner order follows the mobile column order (Wins added before
  // Production), so the spans stay over their own columns
  const groups = mobile ? [GROUPS[0], GROUPS[2], GROUPS[1], TAIL_GRP] : GROUPS;

  // The expensive half — build every row for the season, floor the small
  // samples, sort the whole population and rank within position off that
  // order. Keyed on the DATA and the SORT only; the query filters the result
  // in the memo below rather than forcing this whole pass per keystroke.
  const { population, ctx } = useMemo(() => {
    const owners = data ? ownerOf(data.teams) : {};
    // Same guard honors.ts uses on this tuple: WAR is optional in the row type
    // and a row missing it arithmetics into NaN, which sorts unpredictably and
    // renders as "NaN" down the whole board. Drop the row, don't zero it — a
    // zero here would read as "returned nothing".
    let all: PlayerRow[] = (data?.summary ?? [])
      .filter(r => typeof r[6] === "number")
      .map(r => {
        const [id, p, gp, pts, ppg, , war, sdv] = r;
        return {
          // NFL club at the time (season scope) or last played (All-time),
          // not today's — see SeasonData.nflTeams. Current club is only the
          // fallback for data built before nfl_teams.json shipped.
          ...blankRow(id, pInfo(players, id)[0], p,
            data?.nflTeams?.[id] || pInfo(players, id)[2]),
          team: owners[id] || "—",
          gp, pts, ppg, sdv: sdv || 0, war, warG: gp ? war / gp : 0,
        };
      });
    // floor tiny samples out of the leaderboard: a two-game cameo at 22 PPG is
    // not a season, and it outranks everyone if left in
    const gpMax = all.reduce((m, r) => Math.max(m, r.gp), 0);
    const floor = Math.round(gpMax * 0.45);
    all = all.filter(r => r.gp >= floor);

    const ctx: BoardCtx = { warMax: Math.max(0.01, ...all.map(r => r.war)) };
    // sort the FULL population first, then assign position rank from that
    // order, then filter — so RB4 stays RB4 inside the RB-only view
    const sorted = applySort(all, sortCol(cols, sortId, "war"), dir);
    const counters: Record<string, number> = {};
    sorted.forEach(r => {
      counters[r.pos] = (counters[r.pos] ?? 0) + 1;
      r.posRank = counters[r.pos];
    });
    return { population: sorted, ctx };
  }, [data, players, sortId, dir, cols]);

  // …and the cheap half. `ctx.warMax` stays the FULL population's max, so the
  // meter keeps one scale across every filter — a position view is not its own
  // little league.
  const rows = useMemo(() => apply(population), [population, apply]);
  const count = rows.length;

  const yearChip = (label: string, to: string, on: boolean) => (
    <button key={to} type="button" className={`chip ${on ? "on" : ""}`}
      onClick={() => nav(lp(to))}>{label}</button>
  );

  /** genuinely nothing scored — NOT a fetch that failed, which arrives with the
   *  same empty summary and would otherwise print the same false claim */
  const empty = data != null && !data.error && data.summary.length === 0;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Players</span>
        <BoardScope on="stats" />
        <span className="screen-note">
          {allTime ? "All seasons" : "Regular season"} · <b>{count}</b> shown
        </span>
      </div>
      {/* the year spine: its own row, because it re-scopes the board rather
          than switching which board you are on. Chips-only, so on a phone it
          scrolls rather than wrapping (MOBILE.md M3). */}
      <div className="screen-head chiprow" style={{ paddingTop: 0 }}>
        {played.map(s => yearChip(s, `/stats/${seasonSeg(s)}`, scope === s))}
        {yearChip("All-time", "/stats/all", allTime)}
      </div>
      {bar}

      {/* every board on the site names itself in a band and says what its
          headline figure is measured against — this one had the screen title
          and nothing else */}
      <div className="band">
        <span className="band-label">
          {allTime ? "Career · every played season" : `Regular season · ${scope}`}
        </span>
        <span className="band-note">
          {allTime
            ? "Totals across every season played · career volatility is not a number anyone should read, so points take its column"
            : "WAR vs the best player left out of the league's 108 startable slots · sub-45% of the season's max games filtered out"}
        </span>
      </div>

      {!data ? <div className="empty">Loading…</div>
        /* a failed fetch, said as one: the same empty summary used to render as
           "no scored weeks yet", which claims something about the season that
           nothing here knows — same empty state, same Retry, as Standings */
        : data.error ? (
          <div className="empty">
            Couldn't load {allTime ? "the all-time board" : `${scope} player data`} —
            a dropped connection, not an empty season.{" "}
            <button className="retry" onClick={data.retry}>Retry</button>
          </div>
        ) : empty ? (
          <div className="empty">
            No scored weeks yet for {scope} — the preseason answer is a projection,
            and projections are on Value.
          </div>
        ) : (
          <DataTable cols={cols} groups={groups} rows={rows} ctx={ctx} rowKey={r => r.id}
            label={allTime ? "Career totals · every played season" : `Regular season ${scope}`}
            sortId={sortId} dir={dir} onSort={onSort} homeCol="rk" openKey={openPid}
            onRowClick={r => setOpenPid(openPid === r.id ? null : r.id)}
            renderDrawer={r => allTime
              ? (
                <div className="drawer">
                  <AllTimePanel pid={r.id} data={data} seasons={meta.seasons}
                    teams={data.teams} players={players} />
                </div>
              )
              : (
                <PlayerPanel pid={r.id} season={scope} teams={data.teams} players={players} />
              )} />
        )}

      <div className="tnote screen">
        WAR = wins over the best player left out of the league's 108 startable slots ·
        {allTime
          ? " points and games are career totals across every played season"
          : <> volatility is the weekly <span className="sigma">σ</span> of fantasy points,
            so lower is steadier</>} · open a row for the week-by-week strip. Players under
        45% of the season's max games are filtered out. What a player is worth today is on
        Value.
      </div>
    </>
  );
}
