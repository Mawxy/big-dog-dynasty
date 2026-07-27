import { useEffect, useMemo, useState } from "react";
import type { DraftPick, Drafts, Franchises, SummaryRow } from "../lib/types";
import { j } from "../lib/data";
import { fmt } from "../lib/stats";
import { useLeague } from "../lib/context";
import { boxStats } from "../components/BoxMarks";

const POS: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
const sgn = (v: number, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);
const ROUNDS = [1, 2, 3, 4];

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

/** a rookie pick, deduped, with the franchise that actually made the selection */
interface Pick extends DraftPick { drafter: string; per: number }

export default function Draft() {
  const { meta } = useLeague();
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [warBySeason, setWarBySeason] = useState<Record<string, Record<string, number>> | null>(null);
  const [err, setErr] = useState(false);
  const [openAge, setOpenAge] = useState<Record<number, boolean>>({ 1: true });
  const [openClass, setOpenClass] = useState<Record<number, boolean>>({ 1: true });

  useEffect(() => {
    j<Drafts>("data/drafts.json").then(setDrafts).catch(() => setErr(true));
    j<Franchises>("data/franchises.json").then(setFr).catch(() => setFr({}));
    Promise.all(meta.seasons.map(s =>
      j<SummaryRow[]>(`data/${s}/summary.json`).catch(() => [] as SummaryRow[])))
      .then(all => {
        const by: Record<string, Record<string, number>> = {};
        meta.seasons.forEach((s, i) => {
          const m: Record<string, number> = {};
          for (const r of all[i]) m[r[0]] = r[6];
          by[s] = m;
        });
        setWarBySeason(by);
      })
      .catch(() => setWarBySeason({}));
  }, [meta]);

  const model = useMemo(() => {
    if (!drafts || !warBySeason) return null;
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
    // graded = has played at least one season. Everything below is WAR PER
    // SEASON, never career WAR — otherwise the oldest class wins by construction.
    const graded = all.filter(p => p.years > 0);
    const classes = [...new Set(all.map(p => p.season))].sort();
    const gradedClasses = [...new Set(graded.map(p => p.season))].sort();
    const pendingClasses = classes.filter(s => !gradedClasses.includes(s));

    // (a) per-round distributions
    const byRound = ROUNDS.map(rd => {
      const d = graded.filter(p => p.round === rd).map(p => p.per);
      return { round: rd, n: d.length, s: d.length >= 2 ? boxStats(d) : null };
    });

    // (b) median per-season WAR by exact slot
    const slotMed: Record<string, number | null> = {};
    for (const rd of ROUNDS)
      for (let i = 1; i <= 12; i++) {
        const slot = `${rd}.${String(i).padStart(2, "0")}`;
        slotMed[slot] = med(graded.filter(p => p.slot === slot).map(p => p.per));
      }

    // (c) WAR by career year — year N of a pick is the season (draft + N − 1)
    const warAt = (p: Pick, age: number): number | null => {
      const s = String(+p.season + age - 1);
      const v = warBySeason[s]?.[p.pid];
      return v == null ? null : v;
    };
    const maxYears = Math.max(1, ...graded.map(p => p.years));
    const ages = Array.from({ length: maxYears }, (_, i) => i + 1);
    const pendingAges = [maxYears + 1];
    const ageCell = (list: Pick[], age: number) => {
      const vals = list.filter(p => p.years >= age).map(p => warAt(p, age));
      const m = med(vals);
      return { age, med: m, n: vals.filter(v => v != null).length, pending: false };
    };
    const ageRows = Object.keys(slotMed).map(slot => {
      const list = graded.filter(p => p.slot === slot);
      const cells = [
        ...ages.map(a => ageCell(list, a)),
        ...pendingAges.map(a => ({ age: a, med: null, n: 0, pending: true })),
      ];
      return { slot, round: +slot[0], cells };
    }).filter(r => r.cells.some(c => c.n > 0));
    const ageByRound = ROUNDS.map(rd => {
      const list = graded.filter(p => p.round === rd);
      return {
        round: rd,
        cells: [
          ...ages.map(a => ageCell(list, a)),
          ...pendingAges.map(a => ({ age: a, med: null, n: 0, pending: true })),
        ],
      };
    });

    // (d) slot by class — one column per class, the pick that filled the slot
    const classRows = Object.keys(slotMed).map(slot => {
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
    });

    // (e) value over slot — ranked by war − expected, NOT raw WAR
    const withDiff = graded.filter(p => p.expected != null && p.diff != null)
      .sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));

    return {
      n: graded.length, gradedClasses, pendingClasses, byRound, slotMed,
      ages, pendingAges, ageRows, ageByRound, classRows,
      best: withDiff.slice(0, 8), worst: withDiff.slice(-8).reverse(),
      // widest per-season return on record — drives the box-plot domain
      absMax: Math.max(0, ...graded.map(p => Math.abs(p.per))),
      // how many picks sit behind each heat cell (varies as classes are added)
      cellN: (() => {
        const ns = Object.keys(slotMed).map(s => graded.filter(p => p.slot === s).length);
        const lo = Math.min(...ns), hi = Math.max(...ns);
        return lo === hi ? `n=${hi} per cell` : `n=${lo}–${hi} per cell`;
      })(),
    };
  }, [drafts, fr, warBySeason]);

  if (err) return <div className="empty">No draft data yet.</div>;
  if (!model) return <div className="empty">Loading draft data…</div>;

  // ---- (a) geometry: WAR per season ----
  // The design specifies a ±1.4 domain, which is what this league's data spans
  // today. Treat that as a FLOOR, not a constant: the axis grows if a future
  // class returns more than ±1.4, because the scale clamps and a pinned bar
  // would otherwise read as exactly 1.4. Ticks follow the domain.
  const W = 800;
  // .toFixed guards the float dust in ceil(x/0.2)*0.2 — it yields 1.4000000000000001
  const HI = Math.max(1.4, +(Math.ceil((model.absMax * 1.05) / 0.2) * 0.2).toFixed(2));
  const LO = -HI;
  const sx = (v: number) => Math.max(0, Math.min(W, ((v - LO) / (HI - LO)) * W));
  const pctX = (v: number) => ((v - LO) / (HI - LO) * 100).toFixed(2) + "%";
  const step = HI <= 1.6 ? 0.4 : HI <= 3 ? 0.5 : 1;
  const TICKS: number[] = [];
  for (let t = -Math.floor((HI - 1e-9) / step) * step; t < HI - 1e-9; t += step)
    TICKS.push(+t.toFixed(2));

  // ---- (b) diverging ramp: green for gains, rose for losses ----
  const medAll = Object.values(model.slotMed).filter((v): v is number => v != null);
  const hiPos = Math.max(0.01, ...medAll.filter(v => v > 0));
  const hiNeg = Math.max(0.01, ...medAll.filter(v => v < 0).map(Math.abs));
  const posLo = "#2e8f56", posHi = "#43d783", negLo = "#241419", negHi = "#a8474f";
  const heatBg = (m: number | null) => m == null ? "#0f1318" : Math.abs(m) < 0.005 ? "#151a21"
    : m > 0 ? mix(posLo, posHi, Math.sqrt(m / hiPos))
      : mix(negLo, negHi, Math.sqrt(Math.abs(m) / hiNeg));
  const heatFg = (m: number | null) => m == null ? "#3d4650" : Math.abs(m) < 0.005 ? "#7b8794"
    : lum(heatBg(m)) > 0.173 ? "#08170e" : "#fdeee0";
  const bestSlot = medAll.length ? Math.max(...medAll) : 0;
  const worstSlot = medAll.length ? Math.min(...medAll) : 0;
  const legend = [-1, -0.66, -0.33, -0.08, 0, 0.12, 0.3, 0.5, 0.72, 0.88, 1]
    .map(u => heatBg(u * (u < 0 ? hiNeg : hiPos)));

  const ink = (v: number | null) => v == null ? "var(--dim3)"
    : v > 0.02 ? "#43d783" : v < -0.02 ? "#e8757f" : "var(--dim)";
  /** that round's median per-season return, for the footnote — derived, so the
   *  sentence can't drift away from the chart above it */
  const roundMed = (rd: number) => model.byRound.find(b => b.round === rd)?.s?.md ?? null;

  // both draft tables share one width set so they line up column-for-column
  const ageCols = [...model.ages.map(a => ({ label: `Yr ${a}`, pending: false })),
    ...model.pendingAges.map(a => ({ label: `Yr ${a}*`, pending: true }))];
  const classCols = [...model.gradedClasses.map(s => ({ label: s, pending: false })),
    ...model.pendingClasses.map(s => ({ label: `${s}*`, pending: true }))];
  const colW = (n: number) => (68 / Math.max(1, n)).toFixed(2) + "%";

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Rookie draft returns</span>
        <span className="screen-note">
          <b>{model.n}</b> graded picks · {model.gradedClasses.join(" · ")} classes
          {model.pendingClasses.length ? ` · ${model.pendingClasses.join(", ")} class not yet scored` : ""}
        </span>
      </div>

      {/* (a) WAR per season by round */}
      <div style={{ padding: "0 var(--pad) 20px" }}>
        <div className="panel" style={{ margin: 0 }}>
          <div className="chart-label">
            WAR per season since drafted — box is the middle 50%, <span style={{ color: "var(--acc)" }}>line is the median</span>
          </div>
          <div className="box-rows">
            {model.byRound.map(b => (
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
          <div className="chart-label" style={{ marginBottom: 0 }}>Median WAR per season by exact slot · {model.cellN}</div>
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
              const m = model.slotMed[slot];
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
            opens once any class has played it — * marks one not yet played. Click a round to open its slots.
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
              {model.ageByRound.map(g => {
                const open = !!openAge[g.round];
                const gm = med(g.cells.map(c => c.pending ? null : c.med));
                return (
                  <RoundGroup key={g.round} round={g.round} open={open}
                    onToggle={() => setOpenAge(s => ({ ...s, [g.round]: !open }))}
                    cells={g.cells.map(c => ({ v: c.pending ? null : c.med, pending: c.pending }))}
                    rowMed={gm} ink={ink}
                    rows={!open ? [] : model.ageRows.filter(r => r.round === g.round).map(r => ({
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

      {/* (d) slot by class */}
      <div className="dwrap">
        <div className="dhead">
          <div className="chart-label" style={{ marginBottom: 0 }}>Slot by class · WAR per season</div>
          <div className="note">
            A class joins the table once it has one completed season;{" "}
            {model.pendingClasses.join(", ") || "the next class"} (*) sits reserved until then. Click a round to open its slots.
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
                const mine = model.classRows.filter(r => r.round === rd);
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

      {/* (e) best / worst value over slot */}
      <div className="pick-tables">
        {([["Best value over slot", "best", model.best], ["Worst value over slot", "worst", model.worst]] as const).map(([title, cls, rows]) => (
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
                    <td className="n vs" style={{ color: (r.diff ?? 0) > 0 ? "var(--acc)" : "var(--bad)" }}>{sgn(r.diff ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="footnote">
        Every pick is divided by the seasons it has actually had, so a {model.gradedClasses[model.gradedClasses.length - 1]} rookie
        is compared fairly against a {model.gradedClasses[0]} one
        {roundMed(1) != null && roundMed(3) != null && <>
          {" "}· a first-round pick has returned a median {sgn(roundMed(1) as number)} WAR per season,
          a third-rounder {sgn(roundMed(3) as number)}
        </>}
        {" "}· the value tables rank by WAR over the slot's expectation, not raw WAR — so a pick that returned
        less than its slot was expected to counts as a miss (Bridge A)
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
