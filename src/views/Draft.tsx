import { useEffect, useState } from "react";
import type { PickBucket, PickValues } from "../lib/types";
import { j } from "../lib/data";
import { fmt, quart } from "../lib/stats";

type Mode = "floor" | "smooth" | "raw";
const MODES: [Mode, string][] = [
  ["floor", "Floored"],
  ["smooth", "Smoothed"],
  ["raw", "Raw"],
];

const numCls = (v: number) => (v > 0.0005 ? "num good" : v < -0.0005 ? "num bad" : "num");

export default function Draft() {
  const [pv, setPv] = useState<PickValues | null>(null);
  const [err, setErr] = useState(false);
  const [mode, setMode] = useState<Mode>("floor");
  useEffect(() => {
    j<PickValues>("data/pick_values.json").then(setPv).catch(() => setErr(true));
  }, []);
  if (err) return <div className="empty">No draft data yet — run scripts/pick_value.py.</div>;
  if (!pv) return <div className="empty">Loading draft data…</div>;

  const years = pv.meta.years_published;

  return (
    <>
      <div className="bar">
        {MODES.map(([m, label]) => (
          <button key={m} className={"chip" + (mode === m ? " on" : "")}
            onClick={() => setMode(m)}>{label}</button>
        ))}
        <span style={{ color: "var(--dim)", fontSize: 13 }}>
          classes {pv.meta.classes} · {pv.meta.picks_used} picks · 4 superflex leagues
        </span>
      </div>

      <h2 style={{ margin: "6px 0 8px", fontSize: 17 }}>Value by pick</h2>
      <ValueTable rows={pv.picks} years={years} mode={mode} firstCol="Pick" />

      <h2 style={{ margin: "26px 0 8px", fontSize: 17 }}>Value by tier</h2>
      <ValueTable rows={pv.bands} years={years} mode={mode} firstCol="Tier" />

      <h2 style={{ margin: "26px 0 4px", fontSize: 17 }}>3-year WAR distributions</h2>
      <div style={{ color: "var(--dim)", fontSize: 13, marginBottom: 10 }}>
        Raw (unfloored) 3-season WAR totals of every matured pick in each tier — box is
        the middle half, line is the median, whiskers are best/worst outcomes.
      </div>
      <PickBoxes buckets={pv.bands} />

      <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.6, margin: "14px 2px", maxWidth: 780 }}>
        Average realized WAR by years since draft, from every rookie pick made in four
        12-team superflex dynasty leagues ({pv.meta.classes}). Real Big Dog WAR is used
        for seasons we have; earlier/outside seasons use league-calibrated historical WAR.
        <b> Floored</b> clamps each player-season at 0 — busts ride the bench, so a pick is
        an option, not a liability. <b>Smoothed</b> additionally enforces that value never
        rises down the board (irons out small-sample jumps). <b>Raw</b> is unclamped.
        Hit % = share of picks that returned ≥ {pv.meta.hit_threshold_war} total WAR over
        their first three seasons. Longer horizons appear automatically once
        {" "}{pv.meta.min_classes_per_year} draft classes have matured that far
        (year 4 unlocks after the 2026 season).
      </p>
    </>
  );
}

function ValueTable({ rows, years, mode, firstCol }:
  { rows: PickBucket[]; years: number[]; mode: Mode; firstCol: string }) {
  const src = (b: PickBucket) => (mode === "smooth" ? b.smooth ?? b.floor : b[mode]);
  const tot3 = (b: PickBucket): number | undefined => {
    const s = src(b);
    const vals = [1, 2, 3].map(y => s[String(y)]);
    return vals.every(v => v !== undefined)
      ? vals.reduce((a, v) => a + (v as number), 0) : undefined;
  };
  return (
    <table>
      <thead>
        <tr>
          <th>{firstCol}</th>
          {rows[0]?.slots !== undefined && <th>Slots</th>}
          <th className="hm">n</th>
          {years.map(y => <th key={y}>Yr {y}</th>)}
          <th>3-yr</th><th>Hit %</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(b => {
          const s = src(b);
          const t = tot3(b);
          const newRound = b.bucket.includes(".")
            ? b.bucket.endsWith(".01") && b.bucket !== "1.01"
            : b.bucket.endsWith("E") && b.bucket !== "1E";
          return (
            <tr key={b.bucket} className={newRound ? "rdstart" : ""}>
              <td>{b.label ?? b.bucket}</td>
              {b.slots !== undefined && <td style={{ color: "var(--dim)" }}>{b.slots}</td>}
              <td className="num hm">{b.n[String(years[0])] ?? 0}</td>
              {years.map(y => {
                const v = s[String(y)];
                return v === undefined
                  ? <td key={y} className="num">–</td>
                  : <td key={y} className={numCls(v)}>{fmt(v, 2)}</td>;
              })}
              {t === undefined
                ? <td className="num">–</td>
                : <td className={numCls(t)}><b>{fmt(t, 2)}</b></td>}
              <td className="num">
                {b.hit_rate === null ? "–" : `${Math.round(b.hit_rate * 100)}%`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** tiers as horizontal box-and-whisker rows on one shared WAR axis */
function PickBoxes({ buckets }: { buckets: PickBucket[] }) {
  const rows = buckets.filter(b => b.dist3 && b.dist3.length >= 4);
  if (!rows.length) return <div className="empty">Not enough matured picks yet.</div>;
  const all = rows.flatMap(b => b.dist3);
  const lo = Math.min(...all), hi = Math.max(...all);
  const LBL = 76, L = LBL + 8, W = 740, R = W - 46, ROW = 26, TOP = 22;
  const H = TOP + rows.length * ROW + 26;
  const x = (t: number) => L + (t - lo) / ((hi - lo) || 1) * (R - L);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo); t <= Math.floor(hi); t++) ticks.push(t);
  const c = "#8b96a5";
  return (
    <div className="wkwrap">
      <svg width={W} height={H} style={{ display: "block", background: "var(--card)", borderRadius: 10 }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP - 6} y2={H - 20}
              stroke={t === 0 ? c : "var(--line)"} strokeDasharray={t === 0 ? "" : "3 4"} />
            <text x={x(t)} y={H - 7} fontSize="10" fill={c} textAnchor="middle">{t}</text>
          </g>
        ))}
        {rows.map((b, i) => {
          const v = b.dist3;
          const q1 = quart(v, .25), md = quart(v, .5), q3 = quart(v, .75);
          const mn = v[0], mx = v[v.length - 1];
          const y = TOP + i * ROW, h = 14, cy = y + h / 2;
          return (
            <g key={b.bucket}>
              <text x={LBL} y={cy + 4} fontSize="11" fill="var(--txt)" textAnchor="end">
                {b.label ?? b.bucket}
              </text>
              <line x1={x(mn)} x2={x(q1)} y1={cy} y2={cy} stroke={c} />
              <line x1={x(q3)} x2={x(mx)} y1={cy} y2={cy} stroke={c} />
              <line x1={x(mn)} x2={x(mn)} y1={y + 3} y2={y + h - 3} stroke={c} />
              <line x1={x(mx)} x2={x(mx)} y1={y + 3} y2={y + h - 3} stroke={c} />
              <rect x={x(q1)} y={y} width={Math.max(1, x(q3) - x(q1))} height={h}
                fill="#1e6fd933" stroke="#1e6fd9" />
              <line x1={x(md)} x2={x(md)} y1={y - 1} y2={y + h + 1}
                stroke="var(--acc)" strokeWidth={2} />
              <text x={R + 8} y={cy + 4} fontSize="10" fill={c}>n={v.length}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
