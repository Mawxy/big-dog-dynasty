import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { EcrFile, Values } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useCvi, useDvi, useProjWar } from "../../lib/useIndices";
import { fmt, fmtWar, meterWidth, sgn } from "../../lib/stats";
import { POS_CHIPS, POS_COLOR, rosterSeasonOf } from "../../lib/league";
import { rankMap, useTeamValues } from "../model";
import { Band, IdCell, LensStrip, NUL, Ords, Spine, TapRow, useBetaPath } from "../ui";

/**
 * RANKINGS — who's best.
 *
 * "Rankings", not "Power": it pairs with standings, and the pair is the point.
 * Standings say who is winning; rankings say who is best. The band label says
 * "Valuation rankings" so nobody who taps here expecting a standings table has
 * to guess for more than a second (decision #8).
 *
 * TWO SCOPES, ONE GRAMMAR. Teams and Players are different populations
 * measured by overlapping lenses, and both render as a DIVERGENCE TABLE: the
 * active lens supplies the featured figure, and the other lenses ride the same
 * row as compact ordinals. The spread between them is the screen's story — an
 * aging contender is 2nd by CVI and 9th by DVI on one line, which no amount of
 * sorting one column at a time will show you.
 *
 * Meter rules hold: only WAR is metered, and only when WAR is the sort. DVI and
 * CVI are already normalised 0–100, so a bar restates the figure and implies
 * the two are commensurable.
 */

type TeamLens = "war" | "dvi" | "cvi" | "market";
type PlayerLens = "market" | "war" | "dvi" | "cvi" | "ecr";

/** `short` is the ordinal label on a row where this lens is NOT featured — it
 *  has to be legible at 11px in a column shared with two others, so "Market"
 *  becomes "MKT" rather than being truncated to a month name. */
const TEAM_LENSES: { id: TeamLens; label: string; short: string }[] = [
  { id: "war", label: "WAR", short: "WAR" }, { id: "dvi", label: "DVI", short: "DVI" },
  { id: "cvi", label: "CVI", short: "CVI" }, { id: "market", label: "Market", short: "MKT" },
];
const PLAYER_LENSES: { id: PlayerLens; label: string }[] = [
  { id: "market", label: "Market" }, { id: "war", label: "WAR" },
  { id: "dvi", label: "DVI" }, { id: "cvi", label: "CVI" }, { id: "ecr", label: "ECR" },
];

export default function Rankings() {
  const scope = useParams().scope === "players" ? "players" : "teams";
  const nav = useNavigate();
  const betaPath = useBetaPath();
  return (
    <>
      <div className="v3-head">
        <h1>Rankings</h1>
        <span className="sub">who's best, not who's winning</span>
      </div>
      <div className="v3-scope" role="group" aria-label="Scope">
        <button className={scope === "teams" ? "on" : ""}
          onClick={() => nav(betaPath("/rankings"))}>Teams</button>
        <button className={scope === "players" ? "on" : ""}
          onClick={() => nav(betaPath("/rankings/players"))}>Players</button>
      </div>
      {scope === "teams" ? <TeamScope /> : <PlayerScope />}
    </>
  );
}

/* ========================================================================
   TEAMS
   ======================================================================== */

function TeamScope() {
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const [lens, setLens] = useState<TeamLens>("dvi");
  const tvals = useTeamValues(rosterSeasonOf(league));

  const rows = useMemo(() => {
    if (!tvals) return null;
    const rk = {
      war: rankMap(tvals, t => t.war, t => t.rid),
      dvi: rankMap(tvals, t => t.dvi, t => t.rid),
      cvi: rankMap(tvals, t => t.cvi, t => t.rid),
      market: rankMap(tvals, t => t.market, t => t.rid),
    };
    // MOVEMENT, and only where it can be measured honestly. The market feed
    // publishes a 30-day raw delta per player, so a team's board position 30
    // days ago is recoverable; nothing on the site records what DVI, CVI or
    // projected WAR said a month back, so those lenses carry no arrow rather
    // than a fabricated one.
    const then = rankMap(tvals, t => t.market - t.market30, t => t.rid);
    return tvals
      .map(t => ({
        ...t,
        rank: rk[lens].get(t.rid)!,
        ranks: rk,
        move: lens === "market"
          ? (then.get(t.rid)! - rk.market.get(t.rid)!)
          : null,
      }))
      .sort((a, b) => a.rank - b.rank);
  }, [tvals, lens]);

  const featured = (r: NonNullable<typeof rows>[number]) => {
    if (lens === "war") return (
      <div className="meter-row">
        <div className="meter"><div className="track grow">
          <div className="fill" style={{ width: meterWidth(r.war, Math.max(...rows!.map(x => x.war))) }} />
        </div></div>
        <span className="fig">{fmtWar(r.war)}</span>
      </div>
    );
    if (lens === "market") return <span className="f hd">{Math.round(r.market).toLocaleString()}</span>;
    return <span className="f hd">{fmt(lens === "dvi" ? r.dvi : r.cvi, 0)}</span>;
  };

  return (
    <>
      <LensStrip options={TEAM_LENSES} value={lens} onChange={setLens} />
      <Band label="Valuation rankings · teams"
        note="Best legal lineup summed in each currency — market is the whole roster plus picks" />
      {!rows ? <div className="empty">Loading…</div> : (
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              <th className="n" style={{ width: lens === "war" ? "34%" : "22%" }}>
                {TEAM_LENSES.find(l => l.id === lens)!.label}
              </th>
              <th className="n" style={{ width: "26%" }}>Others</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)} className={i % 2 ? "zebra" : ""}>
                {/* No positional dimension on a franchise, so the spine takes
                    the inactive rule and the accent lands on the leaders'
                    ordinals only. */}
                <Spine rank={r.rank} top={r.rank <= 3} move={r.move} />
                <IdCell name={r.team} sub={r.manager} to={betaPath(`/team/${r.rid}`)} />
                <td className="n">{featured(r)}</td>
                <td className="n">
                  <Ords items={TEAM_LENSES.filter(l => l.id !== lens)
                    .map(l => ({ k: l.short, v: r.ranks[l.id].get(r.rid) ?? null }))} />
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}
      <div className="tnote screen">
        Each figure is that franchise's best legal lineup priced in one currency, so the four
        columns rank the same nine seats four ways. Where they disagree is the read: a team
        near the top by CVI and far down by DVI is winning now on assets that are draining.
        Market is the exception — it is the whole roster plus the picks it holds, because a
        price is what an asset would fetch and a bench player would fetch something. Arrows
        appear under Market only: it is the one lens whose value 30 days ago is recorded.
      </div>
    </>
  );
}

/* ========================================================================
   PLAYERS
   ======================================================================== */

interface PRow {
  pid: string; name: string; pos: string; nfl: string;
  market: number | null; d30: number | null;
  war: number | null; dvi: number | null; cvi: number | null; ecr: number | null;
  posRank: number;
  ranks: Record<"war" | "dvi" | "cvi", number | null>;
}

function PlayerScope() {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const [lens, setLens] = useState<PlayerLens>("market");
  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");

  const dvi = useDvi();
  const cvi = useCvi();
  const war = useProjWar();
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const ecrFile = useJson<EcrFile>("data/ecr.json", "globalDaily").data;

  const population = useMemo<PRow[] | null>(() => {
    if (!dvi || !cvi) return null;
    const slug = Object.keys(ecrFile?.formats ?? {})[0];
    const all: PRow[] = Object.entries(dvi.players).map(([pid, d]) => {
      const v = vals?.players?.[pid];
      return {
        pid, name: d.name, pos: d.pos, nfl: players[pid]?.[2] ?? "",
        market: v?.ktc ?? null, d30: v?.ktcT?.["30"] ?? null,
        war: war?.[pid] ?? null, dvi: d.dvi, cvi: cvi.players[pid]?.cvi ?? null,
        ecr: slug ? ecrFile?.players?.[pid]?.[slug]?.ecr ?? null : null,
        posRank: 0, ranks: { war: null, dvi: null, cvi: null },
      };
    });
    // the ordinals are ranks over the WHOLE population, computed once, so a
    // position filter cannot change what "DVI 14" on a row means
    const rk = {
      war: rankMap(all, r => r.war ?? -Infinity, r => r.pid),
      dvi: rankMap(all, r => r.dvi ?? -Infinity, r => r.pid),
      cvi: rankMap(all, r => r.cvi ?? -Infinity, r => r.pid),
    };
    all.forEach(r => {
      r.ranks = { war: rk.war.get(r.pid) ?? null, dvi: rk.dvi.get(r.pid) ?? null, cvi: rk.cvi.get(r.pid) ?? null };
    });
    return all;
  }, [dvi, cvi, war, vals, ecrFile, players]);

  const rows = useMemo(() => {
    if (!population) return null;
    // ECR is a RANK — 1 is best — so it is the one lens that sorts ascending.
    const key = (r: PRow) => r[lens];
    const asc = lens === "ecr";
    const sorted = population.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return asc ? x - y : y - x;
    });
    // position rank follows the ACTIVE sort, assigned before filtering, so RB4
    // is still RB4 inside the RB-only view
    const seen: Record<string, number> = {};
    sorted.forEach(r => { seen[r.pos] = (seen[r.pos] ?? 0) + 1; r.posRank = seen[r.pos]; });
    const needle = q.trim().toLowerCase();
    return sorted.filter(r =>
      (pos === "ALL" || r.pos === pos) &&
      (!needle || r.name.toLowerCase().includes(needle)));
  }, [population, lens, pos, q]);

  const warMax = useMemo(
    () => Math.max(0.01, ...(population ?? []).map(r => r.war ?? 0)), [population]);

  const featured = (r: PRow) => {
    if (lens === "war") return (
      <div className="meter-row">
        <div className="meter"><div className="track grow">
          <div className="fill" style={{ width: meterWidth(r.war ?? 0, warMax) }} />
        </div></div>
        <span className="fig">{r.war == null ? NUL : fmtWar(r.war)}</span>
      </div>
    );
    if (lens === "market") return (
      <>
        <span className="f hd">{r.market == null ? NUL : r.market.toLocaleString()}</span>
        {/* Δ30 is a RAW VALUE delta and appears under the Market lens only. A
            rank delta would be a statement about everyone else moving.

            Its sign takes `.f.pos` / `.f.neg`, the tokens the board already
            spends on a signed figure, rather than an inline colour. Legal here
            and nowhere near the ledger: a raw market delta is a direction of
            travel, not a verdict about a trade. */}
        {r.d30 != null && r.d30 !== 0 && (
          <div className="idc-s r">
            <span className={`f ${r.d30 > 0 ? "pos" : "neg"}`}>{sgn(r.d30, 0)}</span> 30d
          </div>
        )}
      </>
    );
    if (lens === "ecr") return <span className="f hd">{r.ecr == null ? NUL : r.ecr}</span>;
    const v = lens === "dvi" ? r.dvi : r.cvi;
    return <span className="f hd">{v == null ? NUL : fmt(v, 1)}</span>;
  };

  return (
    <>
      <LensStrip options={PLAYER_LENSES} value={lens} onChange={setLens} />
      <div className="v3-filters">
        {POS_CHIPS.map(p => (
          <button key={p} className={`chip${pos === p ? " on" : ""}`}
            onClick={() => setPos(p)}>{p}</button>
        ))}
        <input type="search" value={q} placeholder="Search players"
          onChange={e => setQ(e.target.value)} />
      </div>
      <Band label="Valuation rankings · players"
        note={`${rows?.length ?? 0} shown${lens === "ecr" ? " · ECR is a rank, 1 is best" : ""}`} />
      {!rows ? <div className="empty">Loading…</div> : (
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: lens === "war" ? "34%" : "24%" }}>
                {PLAYER_LENSES.find(l => l.id === lens)!.label}
              </th>
              <th className="n" style={{ width: "24%" }}>Others</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((r, i) => (
              <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)} className={i % 2 ? "zebra" : ""}>
                <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                <IdCell name={r.name}
                  sub={[r.nfl || null, `${r.pos}${r.posRank}`].filter(Boolean).join(" · ")}
                  to={betaPath(`/player/${r.pid}`)} />
                <td className="n">{featured(r)}</td>
                <td className="n">
                  {/* ECR is a lens without a permanent column: it prices a
                      different horizon (redraft), so carrying it as an ordinal
                      beside three dynasty measures would read as a fourth
                      opinion on the same question. */}
                  <Ords items={(["war", "dvi", "cvi"] as const)
                    .filter(k => k !== lens)
                    .map(k => ({ k: k.toUpperCase(), v: r.ranks[k] }))} />
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.length > 300 && (
        <div className="tnote screen">
          Showing the top 300 of {rows.length}. Narrow with the position chips or the search
          box — this is a phone, and a 900-row table is a scroll, not a ranking.
        </div>
      )}
      <div className="tnote screen">
        DVI prices the dynasty horizon and CVI the coming season, both 0–100 and both bare —
        already normalised, so a meter would restate them. Proj WAR is the model's three-year
        composite and is the only metered column, and only while it is the sort. Market is the
        KTC dynasty price; ECR is the FantasyPros redraft consensus, where 1 is best, so a
        rookie sits below his dynasty price by design. None of them are blended.
      </div>
    </>
  );
}

/* Both of this file's local primitives — the lens strip and the spine cell —
   now live in ui.tsx. The lens strip was promoted verbatim; the spine cell was
   already there and this was a second copy of it. Nothing shared remains
   below, which is the point: a control that two screens draw is a control, and
   a control one screen draws twice is a coincidence. */
