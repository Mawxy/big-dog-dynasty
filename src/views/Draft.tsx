import { useEffect, useMemo, useState } from "react";
import type { DraftPick, Drafts, Franchises, PickBucket, PickValues } from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { fmt } from "../lib/stats";
import { POS_COLOR } from "../lib/league";
import { boxStats } from "../components/BoxMarks";
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

/** one row of the returns table at any of its three depths */
interface TreeNode {
  key: string;
  /** 0 = round, 1 = Early/Mid/Late tier, 2 = exact slot */
  depth: 0 | 1 | 2;
  label: string;
  /** the tier's slot range, printed under its label */
  sub?: string;
  cells: { v: number | null; pending: boolean }[];
  med: number | null;
  hit: number | null;
  hitN: number;
  children: TreeNode[];
}

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
 *  - "What did WE do with our picks?" (best / worst value over slot) reads
 *    `drafts.json`, because that table names our players and our franchises.
 */
export default function Draft() {
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [err, setErr] = useState(false);
  // one nested table now: keys are "1" (round), "1E" (tier), "1.01" (slot)
  const [open, setOpen] = useState<Record<string, boolean>>({ "1": true });

  useEffect(() => {
    jl<Drafts>("drafts.json").then(setDrafts).catch(() => setErr(true));
    jl<Franchises>("franchises.json").then(setFr).catch(() => setFr({}));
    jlDaily<PickValues>("pick_values.json").then(setPv).catch(() => setPv(null));
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

    const ages = years.map(Number);
    const pendingAges = [Math.max(...ages) + 1];

    // ---- the nested table: round -> Early/Mid/Late -> exact pick ----------
    // EVERY level is the median of ITS OWN pooled observations. A parent is
    // therefore NOT the median of the rows beneath it — round 1's 168 year-3
    // picks have a median of +0.38 while its three tiers read +0.61 / +0.26 /
    // +0.19, and the pooled figure is the true one. This is exactly what the
    // old split career-year / tier tables disagreed about: the career-year
    // round row pooled, the tier round row took the median of three summaries
    // (which, with three tiers, just reprinted the middle one). Same picks,
    // two answers. Pooling at every level is the rule now; the footnote says so.
    const hitOf = (b?: PickBucket) => ({ hit: b?.hit_rate ?? null, hitN: b?.hit_n ?? 0 });
    /** pooled hit rate — matured picks summed, never an average of percentages */
    const poolHit = (bs: PickBucket[]) => {
      const hitN = bs.reduce((a, b) => a + (b.hit_n ?? 0), 0);
      return { hitN, hit: hitN ? bs.reduce((a, b) => a + (b.hit_rate ?? 0) * (b.hit_n ?? 0), 0) / hitN : null };
    };
    const mkNode = (
      key: string, depth: 0 | 1 | 2, label: string, sub: string | undefined,
      distFor: (y: string) => number[], hit: { hit: number | null; hitN: number },
      children: TreeNode[],
    ): TreeNode => {
      const cells = [
        ...years.map(y => ({ v: med(distFor(y)), pending: false })),
        ...pendingAges.map(() => ({ v: null, pending: true })),
      ];
      return {
        key, depth, label, sub, children, ...hit, cells,
        med: med(cells.filter(c => !c.pending).map(c => c.v)),
      };
    };
    /** a band names its slot range for display ("1.01–1.04"); parse it back so
     *  the tier's children are the real slots, with an E/M/L fallback */
    const bandSlots = (b: PickBucket): string[] => {
      const m = /(\d)\.(\d{2})\D+(\d)\.(\d{2})/.exec(b.slots ?? "");
      const rd = m ? +m[1] : +b.bucket[0];
      const a = m ? +m[2] : ({ E: 1, M: 5, L: 9 }[b.bucket[1]] ?? 1);
      const z = m ? +m[4] : a + 3;
      return Array.from({ length: z - a + 1 }, (_, i) => `${rd}.${String(a + i).padStart(2, "0")}`);
    };
    const tree: TreeNode[] = ROUNDS.map(rd => {
      const rdSlots = SLOTS.filter(s => s.startsWith(`${rd}.`));
      const bands = (pv.bands ?? []).filter(b => +b.bucket[0] === rd);
      const tierNodes = bands.map(b => mkNode(
        b.bucket, 1, b.label ?? b.bucket, b.slots,
        y => b.dist[y] ?? [], hitOf(b),
        bandSlots(b).map(s => mkNode(
          s, 2, s, undefined,
          y => bySlot.get(s)?.dist[y] ?? [], hitOf(bySlot.get(s)), [],
        )),
      ));
      return mkNode(
        String(rd), 0, `RD ${rd}`, undefined,
        y => rdSlots.flatMap(s => bySlot.get(s)?.dist[y] ?? []),
        poolHit(bands.length ? bands : rdSlots.map(s => bySlot.get(s)).filter((b): b is PickBucket => !!b)),
        tierNodes,
      );
    });

    const ns = SLOTS.map(s => pool(s).length).filter(n => n > 0);
    return {
      tree, hitThreshold: pv.meta.hit_threshold_war,
      slotMed, byRound, ages, pendingAges,
      // observed extremes — the box-plot axis sits exactly 0.1 outside these
      lo: Math.min(...SLOTS.flatMap(pool)),
      hi: Math.max(...SLOTS.flatMap(pool)),
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

    // ranked by war − expected, NOT raw WAR
    const withDiff = graded.filter(p => p.expected != null && p.diff != null)
      .sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));
    return {
      n: graded.length, gradedClasses, pendingClasses,
      best: withDiff.slice(0, 8), worst: withDiff.slice(-8).reverse(),
    };
  }, [drafts, fr]);

  if (err) return <div className="empty">No draft data yet.</div>;
  if (!league) return <div className="empty">Loading draft data…</div>;

  // ---- (a) geometry: WAR per season ----
  // The axis ends ON the outermost ticks: each end is the observed extreme
  // rounded outward to the next 0.5. Padding to an arbitrary offset left the
  // plot running past its own last tick, which reads as a broken scale.
  // Returns are lopsided (best season well past +2, worst around −1.5), so the
  // axis is not symmetric about zero — zero keeps its emphasised gridline.
  const W = 800;
  const step = ((corpus?.hi ?? 0) - (corpus?.lo ?? 0)) <= 6 ? 0.5 : 1;
  const LO = +(Math.floor((corpus?.lo ?? 0) / step) * step).toFixed(2);
  const HI = +(Math.ceil((corpus?.hi ?? 0) / step) * step).toFixed(2);
  const sx = (v: number) => Math.max(0, Math.min(W, ((v - LO) / (HI - LO)) * W));
  const pct = (v: number) => (v - LO) / (HI - LO) * 100;
  const pctX = (v: number) => pct(v).toFixed(2) + "%";
  const TICKS: number[] = [];
  for (let t = LO; t <= HI + 1e-9; t += step) TICKS.push(+t.toFixed(2));

  // ---- (b) diverging ramp: green for gains, rose for losses ----
  const medAll = Object.values(corpus?.slotMed ?? {}).filter((v): v is number => v != null);
  const hiPos = Math.max(0.01, ...medAll.filter(v => v > 0));
  const hiNeg = Math.max(0.01, ...medAll.filter(v => v < 0).map(Math.abs));
  const heatBg = (m: number | null) => m == null ? "#0f1318" : Math.abs(m) < 0.005 ? "#151a21"
    : m > 0 ? mix("#2e8f56", "#43d783", Math.sqrt(m / hiPos))
      : mix("#241419", "#a8474f", Math.sqrt(Math.abs(m) / hiNeg));
  // Ink comes from the cell's own computed luminance, not from the value:
  // dark on the light greens, cream on the dark roses. The switch at 0.173 is
  // where each option stops clearing 4.5:1, so no cell lands in the band where
  // neither reads. A single flat ink can't cover a ramp this wide.
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

  const yearCols = corpus ? [...corpus.ages.map(a => ({ label: `Yr ${a}`, pending: false })),
    ...corpus.pendingAges.map(a => ({ label: `Yr ${a}*`, pending: true }))] : [];
  const W_FIRST = 19, W_MED = 15, W_HIT = 12;
  const W_YEAR = ((100 - W_FIRST - W_MED - W_HIT) / Math.max(1, yearCols.length)).toFixed(2) + "%";

  // The table is a tree flattened to rows: a node is visible when every
  // ancestor is open, which is exactly "push, then recurse if open".
  const treeRows: TreeNode[] = [];
  if (corpus) {
    const walk = (n: TreeNode) => {
      treeRows.push(n);
      if (open[n.key]) n.children.forEach(walk);
    };
    corpus.tree.forEach(walk);
  }
  const allKeys = corpus
    ? corpus.tree.flatMap(r => [r.key, ...r.children.map(t => t.key)])   // leaves have nothing to open
    : [];
  const allOpen = allKeys.length > 0 && allKeys.every(k => open[k]);
  const toggleAll = () =>
    setOpen(allOpen ? {} : Object.fromEntries(allKeys.map(k => [k, true])));

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
                  <div className="lbl">
                    <span>RD {b.round}</span>
                    {b.s && <span className="n">n={b.n}</span>}
                  </div>
                  <div className="plot">
                    <svg viewBox="0 0 800 46" preserveAspectRatio="none">
                      {TICKS.map(t => (
                        <line key={t} x1={sx(t)} y1={16} x2={sx(t)} y2={46}
                          stroke={t === 0 ? "#4e5d6c" : "var(--rule)"} strokeWidth={1} />
                      ))}
                      {b.s && <>
                        <line x1={sx(b.s.mn)} y1={31} x2={sx(b.s.mx)} y2={31} stroke="#4e5d6c" strokeWidth={1.5} />
                        {/* whisker end caps */}
                        <line x1={sx(b.s.mn)} y1={23} x2={sx(b.s.mn)} y2={39} stroke="#4e5d6c" strokeWidth={1.5} />
                        <line x1={sx(b.s.mx)} y1={23} x2={sx(b.s.mx)} y2={39} stroke="#4e5d6c" strokeWidth={1.5} />
                        <rect x={sx(b.s.q1)} y={19} width={Math.max(1, sx(b.s.q3) - sx(b.s.q1))} height={24}
                          fill="#1e262f" stroke="#54636f" strokeWidth={1.5} />
                        <line x1={sx(b.s.md)} y1={17} x2={sx(b.s.md)} y2={45} stroke="var(--acc)" strokeWidth={3} />
                      </>}
                    </svg>
                    {b.s && <>
                      <Lab cls="end" pct={pct(b.s.mn)} text={sgn(b.s.mn)} />
                      <Lab cls="med" pct={pct(b.s.md)} text={sgn(b.s.md)} />
                      <Lab cls="end" pct={pct(b.s.mx)} text={sgn(b.s.mx)} />
                    </>}
                  </div>
                </div>
              ))}
            </div>
            <div className="axis">
              <div className="pad" />
              <div className="scale">
                {/* every tick label centres on its tick, including the two on
                    the plot edges — they overhang into the panel's padding,
                    which is why .panel keeps 20px of it */}
                {TICKS.map(t => <span key={t} style={{ left: pctX(t) }}>{sgn(t, 1)}</span>)}
              </div>
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

      </>}

      {/* (c) returns by round -> tier -> pick */}
      {corpus && (
        <div className="dwrap" style={{ paddingTop: 22 }}>
          <div className="dhead">
            <div className="chart-label" style={{ marginBottom: 0 }}>Returns by round, tier and pick</div>
            <button type="button" className="dexpand" aria-expanded={allOpen} onClick={toggleAll}>
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div className="dscroll">
            <table className="dtbl">
              <thead>
                <tr>
                  <th className="t" style={{ width: `${W_FIRST}%` }}>Round · Tier · Pick</th>
                  {yearCols.map(c => (
                    <th key={c.label} className="n"
                      style={{ width: W_YEAR, color: c.pending ? "var(--dim3)" : undefined }}>{c.label}</th>
                  ))}
                  <th className="n med" style={{ width: `${W_MED}%` }}>Median</th>
                  <th className="n" style={{ width: `${W_HIT}%` }}>Hit %</th>
                </tr>
              </thead>
              <tbody>
                {treeRows.map(n => {
                  const kids = n.children.length > 0;
                  const isOpen = !!open[n.key];
                  return (
                    <tr key={n.key} className={`lvl${n.depth}${kids ? " tap" : ""}`}
                      onClick={kids ? () => setOpen(s => ({ ...s, [n.key]: !s[n.key] })) : undefined}>
                      <td className="lbl">
                        <span className="caret" style={{ color: !kids ? "transparent" : isOpen ? "var(--acc)" : "var(--dim)" }}>
                          {kids ? (isOpen ? "▾" : "▸") : "·"}
                        </span>
                        {n.label}
                        {n.sub && <div className="who">{n.sub}</div>}
                      </td>
                      {n.cells.map((c, i) => (
                        <td key={i} className="n">
                          <span className="v" style={{ color: c.pending || c.v == null ? "var(--dim3)" : ink(c.v) }}>
                            {c.v == null ? "—" : sgn(c.v)}
                          </span>
                        </td>
                      ))}
                      <td className="n med">
                        <span className="v" style={{ color: n.med == null ? "var(--dim3)" : ink(n.med) }}>
                          {n.med == null ? "—" : sgn(n.med)}
                        </span>
                      </td>
                      <td className="n">
                        <span className="v hit">{n.hit == null ? "—" : `${Math.round(n.hit * 100)}%`}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="tnote">
            Median WAR a pick returned in each season since it was drafted — * marks a year the corpus has
            not scored yet. Hit % is the share of picks returning at
            least {fmt(corpus.hitThreshold, 0)} WAR across their first three seasons.
          </div>
        </div>
      )}

      {/* (d) best / worst value over slot — our picks */}
      <div className="pick-tables">
        {([["Best value over slot", "best", league.best], ["Worst value over slot", "worst", league.worst]] as const).map(([title, cls, rows]) => (
          <div key={cls}>
            <div className={`pick-title ${cls}`}>{title}</div>
            <table>
              <thead><tr>
                <th className="t" style={{ width: "10%" }}>Slot</th>
                <th className="t" style={{ width: "10%" }}>Yr</th>
                <th className="t" style={{ width: "36%" }}>Player</th>
                <th className="n" style={{ width: "13%" }}>Exp</th>
                <th className="n" style={{ width: "13%" }}>WAR</th>
                <th className="n key" style={{ width: "18%" }}>Vs exp</th>
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={`${r.season}|${r.slot}|${r.pid}`}>
                    <td className="t" style={{ font: "600 15px/1 var(--cond)", color: "var(--txt2)" }}>{r.slot}</td>
                    <td className="t sub">{r.season}</td>
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

      <div className="footnote">
        {corpus && <>
          Slot value — the box plots, the heat map and the returns table — pools {corpus.picks.toLocaleString()} rookie
          picks from five 12-team superflex leagues ({corpus.classes}), every season calibrated to this league's WAR
          scale · a first-round pick has returned a median {roundMed(1) != null ? sgn(roundMed(1) as number) : "—"} WAR
          per season, a third-rounder {roundMed(3) != null ? sgn(roundMed(3) as number) : "—"} · every row of the
          returns table is the median of its own picks, so a round is not the middle of the three tiers under it ·{" "}
        </>}
        The value tables are our own {league.gradedClasses.join("–")} picks only · every pick is divided
        by the seasons it has actually had, and the value tables rank by WAR over the slot's expectation, not raw WAR (Bridge A)
      </div>
    </>
  );
}

/**
 * A figure sitting above the box plot, positioned as a percentage of the plot
 * width so it stays registered to the chart at any size. Centred on its mark,
 * except within a whisker's width of either end, where it tucks in rather than
 * overflowing the panel.
 */
function Lab({ cls, pct, text }: { cls: string; pct: number; text: string }) {
  const shift = pct < 2 ? "translateX(0)" : pct > 98 ? "translateX(-100%)" : "translateX(-50%)";
  return <span className={`lab ${cls}`} style={{ left: `${pct}%`, transform: shift }}>{text}</span>;
}

