import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Drafts, Franchises, Trade, TradesPayload } from "../lib/types";
import { jl } from "../lib/data";
import { fmt } from "../lib/stats";
import { pInfo, POS_COLOR } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { buildHistory, pickLabel, type HistRow } from "../lib/draftHistory";
import DraftBoardGrid from "../components/DraftBoardGrid";
import { PlayerLink } from "../components/PlayerLink";
import DataTable, { applySort, sortCol, type Col, type Grp } from "../components/DataTable";

const sgn = (v: number, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);
const nul = <span className="fig quiet">—</span>;

/** summary.json rows are [pid, pos, gp, pts, ppg, waa, war, ...] */
type SummaryRow = [string, string, number, number, number, number, number, ...unknown[]];

interface YearCtx { years: string[] }

/**
 * One draft as its own page: the board, WAR by year for every pick, the
 * trades that moved this draft's picks, and best/worst value. Reached from
 * the Draft tab's History boards.
 */
export default function DraftDetail() {
  const season = useParams().season ?? "";
  const { meta, players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [warBy, setWarBy] = useState<Record<string, Record<string, number>> | null>(null);
  const [err, setErr] = useState(false);
  const [sortId, setSortId] = useState("pick");
  const [dir, setDir] = useState(1);
  // every section collapses; the board is the page's face, so it starts open
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({ board: true });

  const latest = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1];
  /** seasons this class has actually played (drafted season .. latest) */
  const played = useMemo(
    () => meta.seasons.filter(s => s >= season && s <= latest),
    [meta, season, latest]);

  useEffect(() => {
    jl<Drafts>("drafts.json").then(setDrafts).catch(() => setErr(true));
    jl<Franchises>("franchises.json").then(setFr).catch(() => setFr({}));
    jl<TradesPayload>("trades.json")
      .then(p => setTrades(Array.isArray(p) ? p : p.trades))
      .catch(() => setTrades([]));
  }, []);
  useEffect(() => {
    let live = true;
    Promise.all(played.map(y =>
      jl<SummaryRow[]>(`${y}/summary.json`)
        .then(rows => [y, rows] as const)
        .catch(() => [y, [] as SummaryRow[]] as const),
    )).then(all => {
      if (!live) return;
      const by: Record<string, Record<string, number>> = {};
      for (const [y, rows] of all)
        for (const r of rows) (by[String(r[0])] ??= {})[y] = r[6];
      setWarBy(by);
    });
    return () => { live = false; };
  }, [played]);

  const history = useMemo(
    () => (drafts ? buildHistory(drafts, fr) : null), [drafts, fr]);
  const rows = history?.rowsBy[season];
  const rookie = history?.kindOf[season] === "rookie";

  /** trades whose assets include a pick from THIS draft */
  const pickTrades = useMemo(() => {
    if (!trades) return [];
    const mine = (t: Trade) => t.sides.some(s =>
      s.got.some(a => a.kind === "pick" && a.label.startsWith(`${season} `)));
    return trades.filter(t => t.sides.length >= 2 && mine(t))
      .slice().sort((a, b) => a.ts - b.ts);
  }, [trades, season]);

  /** best/worst value. Rookie drafts score vs the slot's Bridge A expectation;
   *  the startup has no expectation, so it scores vs the round's own median
   *  career WAR — self-contained and honest about what "value" means there. */
  const value = useMemo(() => {
    if (!rows) return null;
    if (rookie) {
      const graded = rows.filter(r => r.years > 0 && r.diff != null)
        .slice().sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));
      return graded.length
        ? { mode: "exp" as const, best: graded.slice(0, 8), worst: graded.slice(-8).reverse() }
        : null;
    }
    const byRound = new Map<number, number[]>();
    for (const r of rows) (byRound.get(r.round) ?? byRound.set(r.round, []).get(r.round)!).push(r.war);
    const med = new Map<number, number>();
    for (const [rd, ws] of byRound) {
      const v = ws.slice().sort((a, b) => a - b), n = v.length;
      med.set(rd, n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2);
    }
    const scored = rows.map(r => ({ ...r, expected: med.get(r.round) ?? 0, diff: r.war - (med.get(r.round) ?? 0) }))
      .sort((a, b) => b.diff - a.diff);
    return { mode: "med" as const, best: scored.slice(0, 8), worst: scored.slice(-8).reverse() };
  }, [rows, rookie]);

  const ink = (v: number | null) => v == null ? "var(--dim3)"
    : v > 0.02 ? "var(--good)" : v < -0.02 ? "var(--bad)" : "var(--dim)";

  const cols = useMemo<Col<HistRow, YearCtx>[]>(() => [
    {
      id: "pick", label: "Pick", grp: 0, w: 6, align: "c", td: "spine-cell", asc: true,
      sort: r => r.pickNo,
      cell: r => <>
        <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }} />
        <span className="rank">{pickLabel(r)}</span>
      </>,
    },
    {
      id: "player", label: "Player", grp: 0, w: 0, align: "t", td: "t name", asc: true,
      sort: r => r.name, cell: r => <PlayerLink pid={r.pid} name={r.name} />,
    },
    {
      id: "pos", label: "Pos", grp: 0, w: 5, align: "c", td: "c",
      cell: r => <span className={`pos ${r.pos}`}>{r.pos}</span>,
    },
    {
      id: "by", label: "Drafted by", grp: 0, w: 16, align: "t", hm: true, td: "t sub hm",
      sort: r => r.drafter,
      cell: r => <>{r.drafter}{r.via && <span className="name-note">via {r.via}</span>}</>,
    },
    ...played.map((y, i): Col<HistRow, YearCtx> => ({
      id: `y${y}`, label: y, grp: 1, w: 8, align: "n", edge: i === 0,
      td: i === 0 ? "fig edge n" : "fig n",
      sort: r => warBy?.[r.pid]?.[y],
      cell: r => {
        const v = warBy?.[r.pid]?.[y];
        return v == null ? nul : <span style={{ color: ink(v) }}>{sgn(v)}</span>;
      },
    })),
    {
      id: "tot", label: "Total", grp: 1, w: 9, align: "n", keyCol: true, td: "n",
      sort: r => r.years > 0 ? r.war : null,
      cell: r => r.years > 0 || played.length
        ? <span className="fig" style={{ color: ink(r.war) }}>{sgn(r.war)}</span> : nul,
    },
  ], [played, warBy]);

  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: "WAR by season", cls: "edge" },
  ];
  const sorted = useMemo(
    () => rows ? applySort(rows, sortCol(cols, sortId, "pick"), dir) : [],
    [rows, cols, sortId, dir]);
  const onSort = (c: Col<HistRow, YearCtx>) => {
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  if (err) return <div className="empty">No draft data yet.</div>;
  if (!history) return <div className="empty">Loading draft…</div>;
  if (!rows) return <div className="empty">No {season} draft on record.</div>;

  /** a collapsible section band, same control as the History tab's boards */
  const secBand = (id: string, label: string, note: string) => (
    <button type="button" className="band dband" aria-expanded={!!openSec[id]}
      style={{ marginTop: 22 }}
      onClick={() => setOpenSec(s => ({ ...s, [id]: !s[id] }))}>
      <span className="band-label">
        <span className="caret" style={{ color: openSec[id] ? "var(--acc)" : "var(--dim)" }}>
          {openSec[id] ? "▾" : "▸"}
        </span>
        {label}
      </span>
      <span className="band-note">{note}</span>
    </button>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{season} {rookie ? "rookie draft" : "startup draft"}</span>
        <button type="button" className="chip" onClick={() => nav(lp("/draft/history"))}>
          ‹ All drafts
        </button>
        <span className="screen-note">
          <b>{rows.length}</b> picks · {pickTrades.length} trades moved its picks
        </span>
      </div>

      {/* (a) the board */}
      {secBand("board", "Draft board", `${rows.length} picks`)}
      {openSec.board && <DraftBoardGrid rows={rows} />}

      {/* (b) WAR by year, pick by pick */}
      {secBand("returns", "Returns by pick",
        played.length ? "each season's WAR vs replacement, wherever he played"
          : "no seasons played yet")}
      {openSec.returns && (played.length ? (
        <DataTable cols={cols} groups={groups} rows={sorted} ctx={{ years: played }}
          rowKey={r => `${r.slot}|${r.pid}`} sortId={sortId} dir={dir}
          onSort={onSort} homeCol="pick" />
      ) : (
        <div className="empty">This class hasn't played a season yet — returns arrive once it has.</div>
      ))}

      {/* (c) trades that moved this draft's picks */}
      {secBand("trades", "Trades in its picks",
        `${pickTrades.length} trades included a ${season} pick`)}
      {openSec.trades && (pickTrades.length ? (
        <div className="ledger">
          {pickTrades.map(t => (
            <div key={t.ts} className="trade">
              <div className="trade-head">
                <span className="trade-wk">{t.season} · WEEK {t.week}</span>
              </div>
              <div className="trade-sides">
                {t.sides.map((side, i) => (
                  <div key={i} className="trade-side">
                    <div className="hd">
                      <div>
                        <div className="k">Received</div>
                        <div className="team">{side.team}</div>
                      </div>
                    </div>
                    {side.got.map((a, k) => {
                      const isPick = a.kind !== "player";
                      const ours = isPick && a.label.startsWith(`${season} `);
                      const pos = !isPick && a.pid ? pInfo(players, a.pid)[1] : "PICK";
                      return (
                        <div key={k} className="trade-asset">
                          <span className={`pos sm ${isPick ? "PICK" : pos}`}>{isPick ? "PK" : pos}</span>
                          <span className={`nm ${isPick && !ours ? "pick" : ""}`}
                            style={ours ? { color: "var(--txt)" } : undefined}>{a.label}</span>
                          {/* both baskets in the same neutral ink — see Ledger */}
                          <span className="war" style={{ color: isPick ? "var(--dim3)" : "var(--txt2)" }}>
                            {isPick ? "—" : fmt(a.war, 3)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">No recorded trades moved this draft's picks.</div>
      ))}

      {/* (d) best / worst value */}
      {secBand("value", "Best & worst value",
        value ? (value.mode === "exp" ? "vs the slot's expectation" : "vs the round's median WAR")
          : "arrives once the class has played")}
      {openSec.value && !value && (
        <div className="empty">No graded seasons yet — value tables arrive once the class has played.</div>
      )}
      {openSec.value && value && (
        <div className="pick-tables" style={{ marginTop: 22 }}>
          {([["Best value", "best", value.best], ["Worst value", "worst", value.worst]] as const).map(([title, cls, list]) => (
            <div key={cls}>
              <div className={`pick-title ${cls}`}>{title}</div>
              <table>
                <thead><tr>
                  <th className="t" style={{ width: "12%" }}>Pick</th>
                  <th className="t" style={{ width: "40%" }}>Player</th>
                  <th className="n" style={{ width: "16%" }}>{value.mode === "exp" ? "Exp" : "Rd med"}</th>
                  <th className="n" style={{ width: "14%" }}>WAR</th>
                  <th className="n key" style={{ width: "18%" }}>{value.mode === "exp" ? "Vs exp" : "Vs med"}</th>
                </tr></thead>
                <tbody>
                  {list.map(r => (
                    <tr key={`${r.slot}|${r.pid}`}>
                      <td className="t" style={{ font: "600 15px/1 var(--cond)", color: "var(--txt2)" }}>{pickLabel(r)}</td>
                      <td className="who">
                        <div className="line">
                          <span className="pos mini" style={{ background: POS_COLOR[r.pos] || "var(--rule)" }}>{r.pos}</span>
                          <span className="nm">{r.name}</span>
                        </div>
                        <div className="by">{r.drafter}</div>
                      </td>
                      <td className="n sub">{r.expected == null ? "—" : sgn(r.expected)}</td>
                      <td className="n raw">{sgn(r.war)}</td>
                      <td className="n vs" style={{ color: ink(r.diff ?? 0) }}>{sgn(r.diff ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {/* prose belongs in .tnote; .footnote is the one-line all-caps form */}
      <div className="tnote screen">
        The board reads left to right in draft-slot order{rookie ? "" : " — the startup snaked, so even rounds ran right to left"} ·
        WAR by season is measured vs replacement wherever the player suited up, not only on the drafting roster ·{" "}
        {value?.mode === "exp"
          ? "value ranks WAR against the slot's Bridge A expectation over the pick's finished seasons"
          : "the startup has no slot expectation, so value ranks career WAR against the round's own median"}
      </div>
    </>
  );
}
