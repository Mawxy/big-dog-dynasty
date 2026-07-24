import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { PickBucket, PickValues } from "../lib/types";
import { jDaily } from "../lib/data";
import { fmt, clsOf, sd } from "../lib/stats";
import { useWidth } from "../lib/useWidth";
import BoxMarks, { AXIS, boxStats, intTicks } from "../components/BoxMarks";

export default function Draft() {
  const [pv, setPv] = useState<PickValues | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    jDaily<PickValues>("data/pick_values.json").then(setPv).catch(() => setErr(true));
  }, []);
  if (err) return <div className="empty">No draft data yet — run scripts/pick_value.py.</div>;
  if (!pv) return <div className="empty">Loading draft data…</div>;
  if (!pv.picks || !pv.bands)
    return <div className="empty">Draft data is out of date — hard-refresh (Ctrl+F5).</div>;

  const years = pv.meta.years_published;

  return (
    <>
      <div className="bar">
        <span style={{ color: "var(--dim)", fontSize: 13 }}>
          classes {pv.meta.classes} · {(pv.meta.picks_analyzed ?? pv.meta.picks_used).toLocaleString()} picks analyzed
        </span>
      </div>

      <Section title="Value by pick">
        <ValueTable rows={pv.picks} years={years} firstCol="Pick" />
      </Section>

      <Section title="Value by tier">
        <ValueTable rows={pv.bands} years={years} firstCol="Tier" />
      </Section>

      <Section title="3-year WAR distributions">
        <div style={{ color: "var(--dim)", fontSize: 13, marginBottom: 10 }}>
          Total WAR over the first three seasons for every matured pick in each tier — box
          is the middle half, gold line is the median, whiskers are best/worst outcomes.
        </div>
        <PickBoxes buckets={pv.bands} />
      </Section>

      <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.6, margin: "14px 2px", maxWidth: 780 }}>
        Average realized WAR by years since draft, from every rookie pick made in five
        12-team superflex dynasty leagues ({pv.meta.classes}). Real Big Dog WAR is used
        for seasons we have; earlier/outside seasons use league-calibrated historical WAR.
        Values are raw: each player-season counts at its actual WAR, negatives included.
        σ = standard deviation of 3-year WAR totals across the picks in that row.
        Hit % = share of picks that returned ≥ {pv.meta.hit_threshold_war} total WAR over
        their first three seasons. Longer horizons appear automatically once every slot
        has enough real observations behind it — at least
        {" "}{pv.meta.min_obs_by_round["1"]} picks per slot in rounds 1–3 and
        {" "}{pv.meta.min_obs_by_round["4"]} in round 4 — so adding leagues to the
        corpus can unlock a year without waiting for another season.
      </p>
    </>
  );
}

function Section({ title, children, defaultOpen = true }:
  { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ margin: "6px 0 22px" }}>
      <h2 onClick={() => setOpen(o => !o)}
        style={{ margin: "0 0 8px", fontSize: 17, cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--dim)", fontSize: 12, marginRight: 6 }}>
          {open ? "▼" : "►"}
        </span>
        {title}
      </h2>
      {open && children}
    </div>
  );
}

function ValueTable({ rows, years, firstCol }:
  { rows: PickBucket[]; years: number[]; firstCol: string }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (rd: string) => setClosed(prev => {
    const next = new Set(prev);
    if (next.has(rd)) next.delete(rd); else next.add(rd);
    return next;
  });
  const [open, setOpen] = useState<string | null>(null);
  const toggleRow = (bk: string) => setOpen(prev => (prev === bk ? null : bk));
  const roundOf = (b: PickBucket) => b.bucket[0];
  const rounds = [...new Set(rows.map(roundOf))];
  const nCols = 1 + years.length + 3;
  const tot3 = (b: PickBucket): number | undefined => {
    const vals = [1, 2, 3].map(y => b.raw[String(y)]);
    return vals.every(v => v !== undefined)
      ? vals.reduce((a, v) => a + (v as number), 0) : undefined;
  };
  return (
    <table className="pvtbl">
      <thead>
        <tr>
          <th>{firstCol}</th>
          {years.map(y => <th key={y}>Yr {y}</th>)}
          <th className="hm" style={{ textTransform: "none", fontSize: 15 }}>σ</th>
          <th>Total</th><th>Hit %</th>
        </tr>
      </thead>
      <tbody>
        {rounds.map(rd => (
          <Fragment key={rd}>
            <tr onClick={() => toggle(rd)}
              style={{ cursor: "pointer", userSelect: "none" }}>
              <td colSpan={nCols}
                style={{ background: "#11151c", color: "var(--dim)", fontWeight: 600, fontSize: 12.5 }}>
                {closed.has(rd) ? "► " : "▼ "}Round {rd}
              </td>
            </tr>
            {!closed.has(rd) && rows.filter(b => roundOf(b) === rd).map(b => {
              const t = tot3(b);
              const isOpen = open === b.bucket;
              return (
                <Fragment key={b.bucket}>
                  <tr onClick={() => toggleRow(b.bucket)}
                    className={isOpen ? "sorted" : undefined}
                    style={{ cursor: "pointer" }}>
                    <td>{b.label ?? b.bucket}</td>
                    {years.map(y => {
                      const v = b.raw[String(y)];
                      return v === undefined
                        ? <td key={y} className="num">–</td>
                        : <td key={y} className={clsOf(v)}>{fmt(v, 2)}</td>;
                    })}
                    <td className="num hm">{b.dist3.length >= 2 ? fmt(sd(b.dist3), 2) : "–"}</td>
                    {t === undefined
                      ? <td className="num">–</td>
                      : <td className={clsOf(t)}><b>{fmt(t, 2)}</b></td>}
                    <td className="num">
                      {b.hit_rate === null ? "–" : `${Math.round(b.hit_rate * 100)}%`}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="wkbox">
                      <td colSpan={nCols} className="detail">
                        <PickDetail b={b} years={years} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/** tiers as horizontal box-and-whisker rows on one shared WAR axis.
 *  Renders at container width; drops secondary labels when narrow (mobile). */
function PickBoxes({ buckets }: { buckets: PickBucket[] }) {
  const [wrapRef, w] = useWidth<HTMLDivElement>(960, 320, 960);
  const rows = buckets.filter(b => b.dist3 && b.dist3.length >= 4);
  if (!rows.length) return <div className="empty">Not enough matured picks yet.</div>;
  const compact = w < 620;
  const all = rows.flatMap(b => b.dist3);
  const lo = Math.min(...all), hi = Math.max(...all);
  const LBL = compact ? 60 : 84, L = LBL + (compact ? 10 : 36),
    W = w, R = W - (compact ? 14 : 88), ROW = compact ? 38 : 48, TOP = compact ? 24 : 30;
  const H = TOP + rows.length * ROW + 28;
  const x = (t: number) => L + (t - lo) / ((hi - lo) || 1) * (R - L);
  return (
    <div ref={wrapRef}>
      <svg width={W} height={H} style={{ display: "block", background: "var(--card)", borderRadius: 10 }}>
        {intTicks(lo, hi).map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP - 10} y2={H - 20}
              stroke="var(--line)" strokeDasharray="3 4" />
            <text x={x(t)} y={H - 7} fontSize="11" fill={AXIS} textAnchor="middle">{t}</text>
          </g>
        ))}
        {rows.map((b, i) => {
          const s = boxStats(b.dist3);
          const y = TOP + i * ROW, h = compact ? 16 : 18, cy = y + h / 2;
          return (
            <g key={b.bucket}>
              <text x={LBL} y={cy + 4} fontSize={compact ? "10.5" : "12.5"}
                fill="var(--txt)" textAnchor="end">
                {b.label ?? b.bucket}
              </text>
              <BoxMarks s={s} x={x} y={y} h={h} medianOverhang={2} />
              <text x={x(s.md)} y={y - 5} fontSize="10.5" fill="var(--acc)" textAnchor="middle">
                {fmt(s.md, 1)}
              </text>
              {!compact && <>
                <text x={x(s.mn) - 5} y={cy + 4} fontSize="9.5" fill={AXIS} textAnchor="end">
                  {fmt(s.mn, 1)}
                </text>
                <text x={x(s.mx) + 5} y={cy + 4} fontSize="9.5" fill={AXIS} textAnchor="start">
                  {fmt(s.mx, 1)}
                </text>
                <text x={x(s.q1)} y={y + h + 12} fontSize="9.5" fill={AXIS} textAnchor="middle">
                  {fmt(s.q1, 1)}
                </text>
                <text x={x(s.q3)} y={y + h + 12} fontSize="9.5" fill={AXIS} textAnchor="middle">
                  {fmt(s.q3, 1)}
                </text>
                <text x={R + 34} y={cy + 4} fontSize="10.5" fill={AXIS}>n={b.dist3.length}</text>
              </>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const MIN_BOX = 4;

/** Expanded row panel: per-year box plots + overall box, next to a
 *  median/IQR/range trajectory over years since draft. */
function PickDetail({ b, years }: { b: PickBucket; years: number[] }) {
  const [wrapRef, w] = useWidth<HTMLDivElement>(680);
  const label = b.label ?? b.bucket;
  const yearRows = years
    .filter(k => (b.dist[String(k)] ?? []).length >= MIN_BOX)
    .map(k => ({ label: `Yr ${k}`, data: b.dist[String(k)] }));
  const hasOverall = b.dist3.length >= MIN_BOX;
  if (!yearRows.length && !hasOverall)
    return <div style={{ color: "var(--dim)", fontSize: 13 }}>
      Not enough matured picks yet for {label}.
    </div>;
  const stacked = w < 620;
  const colW = stacked ? w : Math.floor((w - 20) / 2);
  const h4: CSSProperties = { margin: "0 0 6px", fontSize: 12.5, color: "var(--dim)", fontWeight: 600 };
  return (
    <div ref={wrapRef} style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
      <div style={{ width: colW, minWidth: 0 }}>
        <h4 style={h4}>WAR distribution by year (single season)</h4>
        {yearRows.length
          ? <BoxChart rows={yearRows} width={colW} />
          : <div style={{ color: "var(--dim)", fontSize: 12 }}>too few picks per year</div>}
        {hasOverall && <>
          <h4 style={{ ...h4, margin: "12px 0 6px" }}>Overall — 3-year WAR total</h4>
          <BoxChart rows={[{ label: "3-yr", data: b.dist3 }]} width={colW} />
        </>}
      </div>
      <div style={{ width: colW, minWidth: 0 }}>
        <h4 style={h4}>WAR by year — median (gold), IQR & range (dotted)</h4>
        <TrajChart b={b} years={years} width={colW} />
        <div style={{ color: "var(--dim)", fontSize: 11, marginTop: 5 }}>
          n by year: {years.map(k => `Yr ${k}: ${(b.dist[String(k)] ?? []).length}`).join("  ·  ")}
        </div>
      </div>
    </div>
  );
}

/** Horizontal box-and-whisker rows on one shared WAR axis. */
function BoxChart({ rows, width }: { rows: { label: string; data: number[] }[]; width: number }) {
  const all = rows.flatMap(r => r.data);
  if (!all.length) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 0.5) { lo -= 0.25; hi += 0.25; }
  const LBL = 40, L = LBL + 10, R = width - 14, ROW = 36, TOP = 14;
  const H = TOP + rows.length * ROW + 20;
  const x = (t: number) => L + (t - lo) / ((hi - lo) || 1) * (R - L);
  return (
    <svg width={width} height={H} style={{ display: "block", background: "var(--card)", borderRadius: 8 }}>
      {intTicks(lo, hi).map(t => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={H - 16} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={x(t)} y={H - 4} fontSize="10" fill={AXIS} textAnchor="middle">{t}</text>
        </g>
      ))}
      {rows.map((r, i) => {
        const s = boxStats(r.data);
        const y = TOP + i * ROW + 6, h = 16, cy = y + h / 2;
        return (
          <g key={r.label}>
            <text x={LBL} y={cy + 4} fontSize="11" fill="var(--txt)" textAnchor="end">{r.label}</text>
            <BoxMarks s={s} x={x} y={y} h={h} cap={3} medianOverhang={3} />
            <text x={x(s.md)} y={y - 5} fontSize="9.5" fill="var(--acc)" textAnchor="middle">{fmt(s.md, 1)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Median line + dotted IQR/range across years since draft. */
function TrajChart({ b, years, width }: { b: PickBucket; years: number[]; width: number }) {
  const yrs = years.filter(k => (b.dist[String(k)] ?? []).length >= MIN_BOX);
  if (!yrs.length) return <div style={{ color: "var(--dim)", fontSize: 12 }}>too few picks per year</div>;
  const S = yrs.map(k => boxStats(b.dist[String(k)]));
  let lo = Math.min(...S.map(s => s.mn)), hi = Math.max(...S.map(s => s.mx));
  if (hi - lo < 0.5) { lo -= 0.25; hi += 0.25; }
  const L = 30, R = width - 12, TOP = 12, BOT = 22, H = 190;
  const px = (i: number) => yrs.length === 1 ? (L + R) / 2 : L + i / (yrs.length - 1) * (R - L);
  const py = (t: number) => TOP + (hi - t) / ((hi - lo) || 1) * (H - TOP - BOT);
  const poly = (get: (s: typeof S[number]) => number) => S.map((s, i) => `${px(i)},${py(get(s))}`).join(" ");
  const band = [...S.map((s, i) => `${px(i)},${py(s.q3)}`),
    ...S.map((s, i) => `${px(i)},${py(s.q1)}`).reverse()].join(" ");
  const blue = "#1e6fd9";
  return (
    <svg width={width} height={H} style={{ display: "block", background: "var(--card)", borderRadius: 8 }}>
      {intTicks(lo, hi).map(t => (
        <g key={t}>
          <line x1={L} x2={R} y1={py(t)} y2={py(t)} stroke="var(--line)" strokeDasharray="3 4" />
          <text x={L - 4} y={py(t) + 3} fontSize="9" fill={AXIS} textAnchor="end">{t}</text>
        </g>
      ))}
      {yrs.length > 1 && <polygon points={band} fill="#1e6fd91f" stroke="none" />}
      <polyline points={poly(s => s.mx)} fill="none" stroke={AXIS} strokeWidth={1} strokeDasharray="2 3" />
      <polyline points={poly(s => s.q3)} fill="none" stroke={blue} strokeWidth={1} strokeDasharray="4 3" />
      <polyline points={poly(s => s.q1)} fill="none" stroke={blue} strokeWidth={1} strokeDasharray="4 3" />
      <polyline points={poly(s => s.mn)} fill="none" stroke={AXIS} strokeWidth={1} strokeDasharray="2 3" />
      <polyline points={poly(s => s.md)} fill="none" stroke="var(--acc)" strokeWidth={2} />
      {S.map((s, i) => <circle key={i} cx={px(i)} cy={py(s.md)} r={3} fill="var(--acc)" />)}
      {yrs.map((k, i) => (
        <text key={k} x={px(i)} y={H - 6} fontSize="10" fill={AXIS} textAnchor="middle">Yr {k}</text>
      ))}
    </svg>
  );
}
