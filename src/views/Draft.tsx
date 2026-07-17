import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { PickBucket, PickValues } from "../lib/types";
import { jDaily } from "../lib/data";
import { fmt, quart, sd } from "../lib/stats";

const numCls = (v: number) => (v > 0.0005 ? "num good" : v < -0.0005 ? "num bad" : "num");

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
          classes {pv.meta.classes} · {pv.meta.picks_used} picks · 4 superflex leagues
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
        Average realized WAR by years since draft, from every rookie pick made in four
        12-team superflex dynasty leagues ({pv.meta.classes}). Real Big Dog WAR is used
        for seasons we have; earlier/outside seasons use league-calibrated historical WAR.
        Values are raw: each player-season counts at its actual WAR, negatives included.
        σ = standard deviation of 3-year WAR totals across the picks in that row.
        Hit % = share of picks that returned ≥ {pv.meta.hit_threshold_war} total WAR over
        their first three seasons. Longer horizons appear automatically once
        {" "}{pv.meta.min_classes_per_year} draft classes have matured that far
        (year 4 unlocks after the 2026 season).
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
  const roundOf = (b: PickBucket) => b.bucket[0];
  const rounds = [...new Set(rows.map(roundOf))];
  const hasSlots = rows[0]?.slots !== undefined;
  const nCols = 1 + (hasSlots ? 1 : 0) + years.length + 3;
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
          {hasSlots && <th className="hm">Slots</th>}
          {years.map(y => <th key={y}>Yr {y}</th>)}
          <th className="hm" style={{ textTransform: "none" }}>σ</th>
          <th>3-Yr Total</th><th>Hit %</th>
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
              return (
                <tr key={b.bucket}>
                  <td>{b.label ?? b.bucket}</td>
                  {b.slots !== undefined &&
                    <td className="hm" style={{ color: "var(--dim)" }}>{b.slots}</td>}
                  {years.map(y => {
                    const v = b.raw[String(y)];
                    return v === undefined
                      ? <td key={y} className="num">–</td>
                      : <td key={y} className={numCls(v)}>{fmt(v, 2)}</td>;
                  })}
                  <td className="num hm">{b.dist3.length >= 2 ? fmt(sd(b.dist3), 2) : "–"}</td>
                  {t === undefined
                    ? <td className="num">–</td>
                    : <td className={numCls(t)}><b>{fmt(t, 2)}</b></td>}
                  <td className="num">
                    {b.hit_rate === null ? "–" : `${Math.round(b.hit_rate * 100)}%`}
                  </td>
                </tr>
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(960);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setW(Math.max(320, Math.min(960, el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rows = buckets.filter(b => b.dist3 && b.dist3.length >= 4);
  if (!rows.length) return <div className="empty">Not enough matured picks yet.</div>;
  const compact = w < 620;
  const all = rows.flatMap(b => b.dist3);
  const lo = Math.min(...all), hi = Math.max(...all);
  const LBL = compact ? 60 : 84, L = LBL + (compact ? 10 : 36),
    W = w, R = W - (compact ? 14 : 88), ROW = compact ? 38 : 48, TOP = compact ? 24 : 30;
  const H = TOP + rows.length * ROW + 28;
  const x = (t: number) => L + (t - lo) / ((hi - lo) || 1) * (R - L);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo); t <= Math.floor(hi); t++) ticks.push(t);
  const c = "#8b96a5";
  return (
    <div ref={wrapRef}>
      <svg width={W} height={H} style={{ display: "block", background: "var(--card)", borderRadius: 10 }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP - 10} y2={H - 20}
              stroke="var(--line)" strokeDasharray="3 4" />
            <text x={x(t)} y={H - 7} fontSize="11" fill={c} textAnchor="middle">{t}</text>
          </g>
        ))}
        {rows.map((b, i) => {
          const v = b.dist3;
          const q1 = quart(v, .25), md = quart(v, .5), q3 = quart(v, .75);
          const mn = v[0], mx = v[v.length - 1];
          const y = TOP + i * ROW, h = compact ? 16 : 18, cy = y + h / 2;
          return (
            <g key={b.bucket}>
              <text x={LBL} y={cy + 4} fontSize={compact ? "10.5" : "12.5"}
                fill="var(--txt)" textAnchor="end">
                {b.label ?? b.bucket}
              </text>
              <line x1={x(mn)} x2={x(q1)} y1={cy} y2={cy} stroke={c} />
              <line x1={x(q3)} x2={x(mx)} y1={cy} y2={cy} stroke={c} />
              <line x1={x(mn)} x2={x(mn)} y1={y + 4} y2={y + h - 4} stroke={c} />
              <line x1={x(mx)} x2={x(mx)} y1={y + 4} y2={y + h - 4} stroke={c} />
              <rect x={x(q1)} y={y} width={Math.max(1, x(q3) - x(q1))} height={h}
                fill="#1e6fd933" stroke="#1e6fd9" />
              <line x1={x(md)} x2={x(md)} y1={y - 2} y2={y + h + 2}
                stroke="var(--acc)" strokeWidth={2} />
              <text x={x(md)} y={y - 5} fontSize="10.5" fill="var(--acc)" textAnchor="middle">
                {fmt(md, 1)}
              </text>
              {!compact && <>
                <text x={x(mn) - 5} y={cy + 4} fontSize="9.5" fill={c} textAnchor="end">
                  {fmt(mn, 1)}
                </text>
                <text x={x(mx) + 5} y={cy + 4} fontSize="9.5" fill={c} textAnchor="start">
                  {fmt(mx, 1)}
                </text>
                <text x={x(q1)} y={y + h + 12} fontSize="9.5" fill={c} textAnchor="middle">
                  {fmt(q1, 1)}
                </text>
                <text x={x(q3)} y={y + h + 12} fontSize="9.5" fill={c} textAnchor="middle">
                  {fmt(q3, 1)}
                </text>
                <text x={R + 34} y={cy + 4} fontSize="10.5" fill={c}>n={v.length}</text>
              </>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
