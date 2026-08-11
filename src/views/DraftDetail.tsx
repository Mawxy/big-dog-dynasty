import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Drafts, Franchises, SummaryRow, Trade, TradesPayload } from "../lib/types";
import { jl } from "../lib/data";
import { useJson } from "../lib/useJson";
import { readTrades } from "../lib/trades";
import { sgnWar, warInk } from "../lib/stats";
import { latestSeasonOf, POS_COLOR } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { buildHistory, pickLabel, type HistRow } from "../lib/draftHistory";
import DraftBoardGrid from "../components/DraftBoardGrid";
import PickTable from "../components/PickTable";
import PosBadge from "../components/PosBadge";
import TradeCard from "../components/TradeCard";
import { PlayerLink } from "../components/PlayerLink";
import DataTable, { applySort, sortCol, useTableSort, type Col, type Grp } from "../components/DataTable";

const nul = <span className="fig quiet">—</span>;

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
  const [warBy, setWarBy] = useState<Record<string, Record<string, number>> | null>(null);
  const { sortId, dir, onSort } = useTableSort("pick", 1);
  // every section collapses; the board is the page's face, so it starts open
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({ board: true });

  const latest = latestSeasonOf(meta);
  /** seasons this class has actually played (drafted season .. latest) */
  const played = useMemo(
    () => meta.seasons.filter(s => s >= season && s <= latest),
    [meta, season, latest]);

  const draftsFile = useJson<Drafts>("drafts.json");
  const drafts = draftsFile.data;
  const err = draftsFile.error;
  const fr = useJson<Franchises>("franchises.json").data;
  // readTrades, not an inline Array.isArray: a TradesFile written without its
  // `trades` key otherwise leaves this undefined
  const tradesFile = useJson<TradesPayload>("trades.json");
  const trades = useMemo<Trade[] | null>(
    () => (tradesFile.data ? readTrades(tradesFile.data).trades
      : tradesFile.error ? [] : null),
    [tradesFile.data, tradesFile.error]);

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

  /** the per-render table context, held stable so DataTable's rows can memoize */
  const yearCtx = useMemo<YearCtx>(() => ({ years: played }), [played]);

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
      cell: r => <PosBadge pos={r.pos} />,
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
        return v == null ? nul : <span style={{ color: warInk(v) }}>{sgnWar(v)}</span>;
      },
    })),
    {
      id: "tot", label: "Total", grp: 1, w: 9, align: "n", keyCol: true, td: "n",
      sort: r => r.years > 0 ? r.war : null,
      cell: r => r.years > 0 || played.length
        ? <span className="fig" style={{ color: warInk(r.war) }}>{sgnWar(r.war)}</span> : nul,
    },
  ], [played, warBy]);

  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: "WAR by season", cls: "edge" },
  ];
  const sorted = useMemo(
    () => rows ? applySort(rows, sortCol(cols, sortId, "pick"), dir) : [],
    [rows, cols, sortId, dir]);
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
        <DataTable cols={cols} groups={groups} rows={sorted} ctx={yearCtx}
          label={`Returns by pick · ${season} draft`}
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
          {/* two trades processed in one Sleeper batch share a ts — key on the
              pair, the way the franchise page's trade list already does */}
          {pickTrades.map((t, i) => (
            <TradeCard key={`${t.ts}-${i}`} trade={t} players={players}
              emphasize={a => a.kind !== "player" && a.label.startsWith(`${season} `)} />
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
          {/* One draft, so no year column — and the pick label comes from
              pickLabel, not the file's `slot`: the startup snaked and its slot
              is the draft COLUMN, so 2.12 and 2.01 read backwards. The Draft
              tab pools rookie classes only, where the two coincide. */}
          {([["Best value", "best", value.best], ["Worst value", "worst", value.worst]] as const).map(([title, tone, list]) => (
            <PickTable<HistRow> key={tone} title={title} tone={tone} rows={list}
              rowKey={r => `${r.slot}|${r.pid}`}
              lead={[{ label: "Pick", w: 12, of: r => pickLabel(r) }]}
              w={{ player: 40, exp: 16, war: 14, vs: 18 }}
              expLabel={value.mode === "exp" ? "Exp" : "Rd med"}
              vsLabel={value.mode === "exp" ? "Vs exp" : "Vs med"} />
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
