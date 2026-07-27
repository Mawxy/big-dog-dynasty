import { useEffect, useMemo, useState } from "react";
import type { DraftPick, Drafts, Franchises, PickValues } from "../lib/types";
import { j, jDaily } from "../lib/data";
import { fmt } from "../lib/stats";
import { boxStats } from "../components/BoxMarks";

const POS: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
const sgn = (v: number, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);
const ROUNDS = [1, 2, 3, 4];
const SLOTS = ROUNDS.flatMap(rd => Array.from({ length: 12 }, (_, i) => `${rd}.${String(i + 1).padStart(2, "0")}`));

/** median of the values present; null when there are none */
function med(a: (number | null)[]): number | null {
  const s = a.filter((v): v is number => v != null).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mix(a: string, b: string, t: number): string {
  t = Math.max(0, Math.min(1, t));
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + h(r1 + (r2 - r1) * t) + h(g1 + (g2 - g1) * t) + h(b1 + (b2 - b1) * t);
}
/** relative luminance, for picking ink off the cell's own colour */
function lum(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** a rookie pick from THIS league, deduped, with the franchise that drafted it */
interface Pick extends DraftPick { drafter: string; per: number }

/**
 * Two sources, deliberately separated:
 *
 *  - "What is a pick at this slot worth?" (box plots, heat map, career-year
 *    table) reads `pick_values.json` — 1,065 rookie picks across five 12-team
 *    superflex leagues, 2019-2025, every observation already calibrated to this
 *    league's WAR scale. Big Dog alone has three graded classes, which puts
 *    exactly ONE pick behind each slot at career year 3; 14 of 48 slots came
 *    back empty and the rest were a median of one.
 *
 *  - "What did WE do with our picks?" (slot by class, best/worst value) reads
 *    `drafts.json`, because those tables name our players and our franchises.
 */
export default function Draft() {
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [err, setErr] = useState(false);
  const [openAge, setOpenAge] = useState<Record<number, boolean>>({ 1: true });
  const [openClass, setOpenClass] = useState<Record<number, boolean>>({ 1: true });

  useEffect(() => {
    j<Drafts>("data/drafts.json").then(setDrafts).catch(() => setErr(true));
    j<Franchises>("data/franchises.json").then(setFr).catch(() => setFr({}));
    jDaily<PickValues>("data/pick_values.json").then(setPv).catch(() => setPv(null));
  }, []);

  /** slot-value blocks, from the multi-league corpus */
  const corpus = useMemo(() => {
    if (!pv?.picks?.length) return null;
    const years = pv.meta.years_published.map(String);
    const bySlot = new Map(pv.picks.map(b => [b.bucket, b]));
    /** every per-season observation for a slot, pooled across career years */
    const pool = (slot: string): number[] => {
      const b = bySlot.get(slot);
      return b ? years.flatMap(y => b.dist[y] ?? []) : [];
    };
    const slotMed: Record<string, number | null> = {};
    for (const s of SLOTS) slotMed[s] = med(pool(s));

    const byRound = ROUNDS.map(rd => {
      const d = SLOTS.filter(s => s.startsWith(`${rd}.`)).flatMap(pool);
      return { round: rd, n: d.length, s: d.length >= 2 ? boxStats(d) : null };
    });

    // career-year cells: median of that year's samples, for the slot / the round
    const cellAt = (slots: string[], y: string) => {
      const vals = slots.flatMap(s => bySlot.get(s)?.dist[y] ?? []);
      return { med: med(vals), n: vals.length, pending: false };
    };
    const ages = years.map(Number);
    const pendingAges = [Math.max(...ages) + 1];
    const blank = pendingAges.map(a => ({ age: a, med: null, n: 0, pending: true }));
    const ageRows = SLOTS.map(slot => ({
      slot, round: +slot[0],
      cells: [...years.map(y => ({ age: +y, ...cellAt([slot], y) })), ...blank],
    })).filter(r => r.cells.some(c => c.n > 0));
    const ageByRound = ROUNDS.map(rd => {
      const slots = SLOTS.filter(s => s.startsWith(`${rd}.`));
      return { round: rd, cells: [...years.map(y => ({ age: +y, ...cellAt(slots, y) })), ...blank] };
    });

    const ns = SLOTS.map(s => pool(s).length).filter(n => n > 0);
    return {
      slotMed, byRound, ages, pendingAges, ageRows, ageByRound,
      absMax: Math.max(0, ...SLOTS.flatMap(pool).map(Math.abs)),
      cellN: ns.length ? (Math.min(...ns) === Math.max(...ns)
        ? `n=${ns[0]} per cell` : `n=${Math.min(...ns)}–${Math.max(...ns)} per cell`) : "",
      picks: pv.meta.picks_analyzed ?? pv.meta.picks_used,
      classes: pv.meta.classes,
    };
  }, [pv]);

  /** our own draft record, for the two tables that name names */
  const league = useMemo(() => {
    if (!drafts) return null;
    const nameOf = (rid: string): string => {
      const f = fr?.[rid];
      return f?.seasons.length ? f.seasons[f.seasons.length - 1].name : `Roster ${rid}`;
    };
    // drafts.json lists a traded pick under BOTH franchises — dedupe on
    // season|slot|pid and keep the `traded: false` entry, whose key is the
    // franchise that actually made the selection.
    const uniq = new Map<string, { p: DraftPick; rid: string }>();
    for (const [rid, picks] of Object.entries(drafts))
      for (const p of picks) {
        if (p.kind !== "rookie") continue;
        const k = `${p.season}|${p.slot}|${p.pid}`;
        const cur = uniq.get(k);
        if (!cur || (cur.p.traded && !p.traded)) uniq.set(k, { p, rid });
      }
    const all: Pick[] = [...uniq.values()].map(({ p, rid }) => ({
      ...p, drafter: nameOf(rid), per: p.years > 0 ? p.war / p.years : 0,
    }));
    const graded = all.filter(p => p.years > 0);
    const classes = [...new Set(all.map(p => p.season))].sort();
    const gradedClasses = [...new Set(graded.map(p => p.season))].sort();
    const pendingClasses = classes.filter(s => !gradedClasses.includes(s));

    const classRows = SLOTS.map(slot => {
      const cells = [...gradedClasses, ...pendingClasses].map(season => {
        const p = all.find(x => x.slot === slot && x.season === season);
        const pending = pendingClasses.includes(season);
        return {
          season, pending,
          per: !p || pending || p.years <= 0 ? null : p.per,
          name: p?.name ?? "",
        };
      });
      return { slot, round: +slot[0], cells, med: med(cells.map(c => c.per)) };
    }).filter(r => r.cells.some(c => c.per != null || c.name));

    // ranked by war − expected, NOT raw WAR
    const withDiff = graded.filter(p => p.expected != null && p.diff != null)
      .sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));
    return {
      n: graded.length, gradedClasses, pendingClasses, classRows,
      best: withDiff.slice(0, 8), worst: withDiff.slice(-8).reverse(),
    };
  }, [drafts, fr]);

  if (err) return <div className="empty">No draft data yet.</div>;
  if (!league) return <div className="empty">Loading draft data…</div>;

  // ---- (a) geometry: WAR per season ----
  // Domain follows the data. The design's ±1.4 fitted three Big Dog classes;
  // the corpus reaches wider, and a clamped bar would silently read as the edge.
  const W = 800;
  const HI = Math.max(1.4, +(Math.ceil(((corpus?.absMax ?? 0) * 1.05) / 0.2) * 0.2).toFixed(2));
  const LO = -HI;
  const sx = (v: number) => Math.max(0, Math.min(W, ((v - LO) / (HI - LO)) * W));
  const pctX = (v: number) => ((v - LO) / (HI - LO) * 100).toFixed(2) + "%";
  const step = HI <= 1.6 ? 0.4 : HI <= 3 ? 0.5 : 1;
  const TICKS: number[] = [];
  for (let t = -Math.floor((HI - 1e-9) / step) * step; t < HI - 1e-9; t += step)
    TICKS.push(+t.toFixed(2));

  // ---- (b) diverging ramp: green for gains, rose for losses ----
  const medAll = Object.values(corpus?.slotMed ?? {}).filter((v): v is number => v != null);
  const hiPos = Math.max(0.01, ...medAll.filter(v => v > 0));
  const hiNeg = Math.max(0.01, ...medAll.filter(v => v < 0).map(Math.abs));
  const heatBg = (m: number | null) => m == null ? "#0f1318" : Math.abs(m) < 0.005 ? "#151a21"
    : m > 0 ? mix("#2e8f56", "#43d783", Math.sqrt(m / hiPos))
      : mix("#241419", "#a8474f", Math.sqrt(Math.abs(m) / hiNeg));
  const heatFg = (m: number | null) => m == null ? "#3d4650" : Math.abs(m) < 0.005 ? "#7b8794"
    : lum(heatBg(m)) > 0.173 ? "#08170e" : "#fdeee0";
  const bestSlot = medAll.length ? Math.max(...medAll) : 0;
  const worstSlot = medAll.length ? Math.min(...medAll) : 0;
  const legend = [-1, -0.66, -0.33, -0.08, 0, 0.12, 0.3, 0.5, 0.72, 0.88, 1]
    .map(u => heatBg(u * (u < 0 ? hiNeg : hiPos)));

  /** every signed WAR figure on this screen resolves to the same pair */
  const ink = (v: number | null) => v == null ? "var(--dim3)"
    : v > 0.02 ? "var(--war-pos)" : v < -0.02 ? "var(--war-neg)" : "var(--dim)";
  const roundMed = (rd: number) => corpus?.byRound.find(b => b.round === rd)?.s?.md ?? null;

  // both draft tables share one width set so they line up column-for-column
  const ageCols = corpus ? [...corpus.ages.map(a => ({ label: `Yr ${a}`, pending: false })),
    ...corpus.pendingAges.map(a => ({ label: `Yr ${a}*`, pending: true }))] : [];
  const classCols = [...league.gradedClasses.map(s => ({ label: s, pending: false })),
    ...league.pendingClasses.map(s => ({ label: `${s}*`, pending: true }))];
  const colW = (n: number) => (68 / Math.max(1, n)).toFixed(2) + "%";

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Rookie draft returns</span>
        <span className="screen-note">
          {corpus && <><b>{corpus.picks.toLocaleString()}</b> picks, {corpus.classes} · </>}
          <b>{league.n}</b> of ours graded
          {league.pendingClasses.length ? ` · ${league.pendingClasses.join(", ")} not yet scored` : ""}
        </span>
      </div>

      {corpus && <>
        {/* (a) WAR per season by round */}
        <div style={{ padding: "0 var(--pad) 20px" }}>
          <div className="panel" style={{ margin: 0 }}>
            <div className="chart-label">
              WAR per season since drafted — box is the middle 50%, <span style={{ color: "var(--acc)" }}>line is the median</span>
            </div>
            <div className="box-rows">
              {corpus.byRound.map(b => (
                <div key={b.round} className="box-row">
                  <div className="lbl">RD {b.round}</div>
                  <svg viewBox="0 0 800 30" preserveAspectRatio="none">
                    {TICKS.map(t => (
                      <line key={t} x1={sx(t)} y1={0} x2={sx(t)} y2={30}
                        stroke={t === 0 ? "#4e5d6c" : "var(--rule)"} strokeWidth={1} />
                    ))}
                    {b.s && <>
                      <line x1={sx(b.s.mn)} y1={15} x2={sx(b.s.mx)} y2={15} stroke="#4e5d6c" strokeWidth={1.5} />
                      <rect x={sx(b.s.q1)} y={3} width={Math.max(1, sx(b.s.q3) - sx(b.s.q1))} height={24}
                        fill="#1e262f" stroke="#54636f" strokeWidth={1.5} />
                      <line x1={sx(b.s.md)} y1={1} x2={sx(b.s.md)} y2={29} stroke="var(--acc)" strokeWidth={3} />
                    </>}
                  </svg>
                  <div className="meta">
                    {b.s ? `n=${b.n}  ·  median ${sgn(b.s.md)}/yr  ·  best ${sgn(b.s.mx)}` : "not enough matured picks"}
                  </div>
                </div>
              ))}
            </div>
            <div className="axis">
              <div className="pad" />
              <div className="scale">
                {TICKS.map(t => <span key={t} style={{ left: pctX(t) }}>{sgn(t, 1)}</span>)}
              </div>
              <div className="tail" />
            </div>
          </div>
        </div>

        {/* (b) heat map */}
        <div style={{ padding: "0 var(--pad) 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, marginBottom: 11, flexWrap: "wrap" }}>
            <div className="chart-label" style={{ marginBottom: 0 }}>
              Median WAR per season by exact slot · {corpus.cellN}
            </div>
            <div className="heat-legend">
              <span>{fmt(worstSlot)}</span>
              <div className="sw">{legend.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
              <span>{sgn(bestSlot)}</span>
            </div>
          </div>
        </div>
        <div className="heat-head" style={{ padding: "0 var(--pad)" }}>
          <div className="pad" />
          {Array.from({ length: 12 }, (_, j) => <span key={j}>{String(j + 1).padStart(2, "0")}</span>)}
        </div>
        <div className="heat2">
          {ROUNDS.map(rd => (
            <div key={rd} className="heat-row">
              <div className="lbl">RD {rd}</div>
              {Array.from({ length: 12 }, (_, j) => {
                const slot = `${rd}.${String(j + 1).padStart(2, "0")}`;
                const m = corpus.slotMed[slot];
                const ring = m != null && m === bestSlot ? "inset 0 0 0 2px rgba(255,255,255,.9)"
                  : m != null && m === worstSlot ? "inset 0 0 0 2px #ffc9c9" : "none";
                return (
                  <div key={slot} className="cell"
                    style={{ background: heatBg(m), color: heatFg(m), boxShadow: ring }}>
                    {m == null ? "—" : sgn(m)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="heat-note">
          <span>Rows are draft rounds, columns are the pick within the round — so column 01 is every team's first-up selection.</span>
          <span className="end">Ringed cells: best and worst slot on record.</span>
        </div>

        {/* (c) WAR by career year */}
        <div className="dwrap" style={{ paddingTop: 22 }}>
          <div className="dhead">
            <div className="chart-label" style={{ marginBottom: 0 }}>WAR by career year</div>
            <div className="note">
              Median WAR a slot returned in its player's first season, second season, third. A year column
              opens once the corpus has scored it — * marks one not yet played. Click a round to open its slots.
            </div>
          </div>
          <div className="dscroll">
            <table className="dtbl">
              <colgroup>
                <col style={{ width: "15%" }} />
                {ageCols.map((_, i) => <col key={i} style={{ width: colW(ageCols.length) }} />)}
                <col style={{ width: "17%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="t">Slot</th>
                  {ageCols.map(c => (
                    <th key={c.label} className="n" style={{ color: c.pending ? "var(--dim3)" : undefined }}>{c.label}</th>
                  ))}
                  <th className="n med">Median</th>
                </tr>
              </thead>
              <tbody>
                {corpus.ageByRound.map(g => {
                  const open = !!openAge[g.round];
                  const gm = med(g.cells.map(c => c.pending ? null : c.med));
                  return (
                    <RoundGroup key={g.round} round={g.round} open={open}
                      onToggle={() => setOpenAge(s => ({ ...s, [g.round]: !open }))}
                      cells={g.cells.map(c => ({ v: c.pending ? null : c.med, pending: c.pending }))}
                      rowMed={gm} ink={ink}
                      rows={!open ? [] : corpus.ageRows.filter(r => r.round === g.round).map(r => ({
                        slot: r.slot,
                        cells: r.cells.map(c => ({ v: c.pending ? null : c.med, pending: c.pending })),
                        med: med(r.cells.map(c => c.pending ? null : c.med)),
                      }))} />
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </>}

      {/* (d) slot by class — our drafts */}
      <div className="dwrap">
        <div className="dhead">
          <div className="chart-label" style={{ marginBottom: 0 }}>Slot by class · WAR per season</div>
          <div className="note">
            Our own picks. A class joins the table once it has one completed season;{" "}
            {league.pendingClasses.join(", ") || "the next class"} (*) sits reserved until then. Click a round to open its slots.
          </div>
        </div>
        <div className="dscroll">
          <table className="dtbl">
            <colgroup>
              <col style={{ width: "15%" }} />
              {classCols.map((_, i) => <col key={i} style={{ width: colW(classCols.length) }} />)}
              <col style={{ width: "17%" }} />
            </colgroup>
            <thead>
              <tr>
                <th className="t">Slot</th>
                {classCols.map(c => (
                  <th key={c.label} className="n" style={{ color: c.pending ? "#48545f" : undefined }}>{c.label}</th>
                ))}
                <th className="n med">Median</th>
              </tr>
            </thead>
            <tbody>
              {ROUNDS.map(rd => {
                const open = !!openClass[rd];
                const mine = league.classRows.filter(r => r.round === rd);
                if (!mine.length) return null;
                // round row = median of the values printed on that row — the same
                // rule the slot rows follow, so the summary can't contradict them
                const colMed = (i: number) => med(mine.map(r => r.cells[i].per));
                const gCells = classCols.map((c, i) => ({ v: c.pending ? null : colMed(i), pending: c.pending }));
                return (
                  <RoundGroup key={rd} round={rd} open={open}
                    onToggle={() => setOpenClass(s => ({ ...s, [rd]: !open }))}
                    cells={gCells} rowMed={med(gCells.map(c => c.v))} ink={ink}
                    rows={!open ? [] : mine.map(r => ({
                      slot: r.slot,
                      cells: r.cells.map(c => ({ v: c.pending ? null : c.per, pending: c.pending, name: c.name })),
                      med: r.med,
                    }))} />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* (e) best / worst value over slot — our picks */}
      <div className="pick-tables">
        {([["Best value over slot", "best", league.best], ["Worst value over slot", "worst", league.worst]] as const).map(([title, cls, rows]) => (
          <div key={cls}>
            <div className={`pick-title ${cls}`}>{title}</div>
            <table>
              <colgroup>
                <col style={{ width: "10%" }} /><col style={{ width: "10%" }} /><col style={{ width: "36%" }} />
                <col style={{ width: "13%" }} /><col style={{ width: "13%" }} /><col style={{ width: "18%" }} />
              </colgroup>
              <thead><tr>
                <th className="t">Slot</th><th className="t">Yr</th><th className="t">Player</th>
                <th className="n">Exp</th><th className="n">WAR</th><th className="n key">Vs exp</th>
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={`${r.season}|${r.slot}|${r.pid}`}>
                    <td className="t" style={{ font: "600 15px/1 var(--cond)", color: "var(--txt2)" }}>{r.slot}</td>
                    <td className="t sub">{r.season}</td>
                    <td className="who">
                      <div className="line">
                        <span className="pos mini" style={{ background: POS[r.pos] || "var(--rule)" }}>{r.pos}</span>
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

      <div className="footnote">
        {corpus && <>
          Slot value — the box plots, the heat map and the career-year table — pools {corpus.picks.toLocaleString()} rookie
          picks from five 12-team superflex leagues ({corpus.classes}), every season calibrated to this league's WAR
          scale · a first-round pick has returned a median {roundMed(1) != null ? sgn(roundMed(1) as number) : "—"} WAR
          per season, a third-rounder {roundMed(3) != null ? sgn(roundMed(3) as number) : "—"} ·{" "}
        </>}
        Slot by class and the value tables are our own {league.gradedClasses.join("–")} picks only · every pick is divided
        by the seasons it has actually had, and the value tables rank by WAR over the slot's expectation, not raw WAR (Bridge A)
      </div>
    </>
  );
}

interface Cell { v: number | null; pending: boolean; name?: string }

/** A collapsible round: the round row carries its own medians, its slot rows
 *  zebra within the group. Used by both draft tables so their geometry matches. */
function RoundGroup({ round, open, onToggle, cells, rowMed, rows, ink }: {
  round: number; open: boolean; onToggle: () => void;
  cells: Cell[]; rowMed: number | null; ink: (v: number | null) => string;
  rows: { slot: string; cells: Cell[]; med: number | null }[];
}) {
  return (
    <>
      <tr className="rd" onClick={onToggle}>
        <td className="lbl">
          <span className="caret" style={{ color: open ? "var(--acc)" : "var(--dim)" }}>{open ? "▾" : "▸"}</span>
          RD {round}
        </td>
        {cells.map((c, i) => (
          <td key={i} className="n">
            <span className="v" style={{ color: c.pending || c.v == null ? "var(--dim3)" : ink(c.v) }}>
              {c.v == null ? "—" : sgn(c.v)}
            </span>
          </td>
        ))}
        <td className="n med">
          <span className="v" style={{ color: rowMed == null ? "var(--dim3)" : ink(rowMed) }}>
            {rowMed == null ? "—" : sgn(rowMed)}
          </span>
        </td>
      </tr>
      {rows.map((r, i) => (
        <tr key={r.slot} style={{ background: i % 2 ? "#0f141a" : "var(--band)" }}>
          <td className="slot" style={{ color: round === 1 ? "var(--txt)" : "#8b96a5" }}>{r.slot}</td>
          {r.cells.map((c, k) => (
            <td key={k} className="n">
              <span className="v" style={{ color: c.pending || c.v == null ? "var(--dim3)" : ink(c.v) }}>
                {c.v == null ? "—" : sgn(c.v)}
              </span>
              {c.name != null && <div className="who">{c.name || "—"}</div>}
            </td>
          ))}
          <td className="n med">
            <span className="v" style={{ color: r.med == null ? "var(--dim3)" : ink(r.med) }}>
              {r.med == null ? "—" : sgn(r.med)}
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}
