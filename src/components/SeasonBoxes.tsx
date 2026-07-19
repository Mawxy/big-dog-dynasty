import { useWidth } from "../lib/useWidth";
import BoxMarks, { AXIS, boxStats } from "./BoxMarks";

interface Row { season: string; values: number[] }

/** Grouped horizontal box plots — one row per season, one shared, labeled axis.
 *  Fixed height, width tracks the parent container (so it can size-match
 *  sibling charts). */
export default function SeasonBoxes({ rows, domain, height = 230 }: {
  rows: Row[]; domain?: [number, number]; height?: number;
}) {
  const [ref, W] = useWidth<HTMLDivElement>(540, 320);
  const usable = rows.filter(r => r.values.length >= 4);
  if (!usable.length) return null;
  // shared axis from the league's all-time single-week min/max, so every
  // player's chart is directly comparable AND the scale adapts to any league's
  // scoring. Extends if this player's own data somehow falls outside it.
  const all = usable.flatMap(r => r.values);
  const lo = Math.min(domain?.[0] ?? 0, 0, ...all);
  const hi = Math.max(domain?.[1] ?? 65, ...all);
  const L = 52, R = W - 14;
  const T = 8, axisH = 24, H = height;
  const rowH = (H - T - axisH) / usable.length;
  const x = (t: number) => L + (t - lo) / ((hi - lo) || 1) * (R - L);
  const span = (hi - lo) || 1;
  const step = span <= 30 ? 5 : span <= 60 ? 10 : 20;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 0.001; t += step) ticks.push(t);
  // the domain bounds (league all-time single-week min/max) get explicit,
  // labeled boundary lines so the edges of the plot are always legible;
  // drop any step tick whose label would crowd a boundary label.
  const shown = ticks.filter(t => Math.abs(x(t) - x(lo)) > 18 && Math.abs(x(t) - x(hi)) > 18);
  const fmt = (t: number) => Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : t.toFixed(1);
  const grid = "#242c38", bound = "#4a5568", boundTxt = "#aab6c5";
  return (
    <div ref={ref}>
      <div style={{ color: "var(--txt)", fontSize: 13, marginBottom: 4 }}>
        <b>Weekly points by season</b>
      </div>
      <svg width={W} height={H}>
        {shown.map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={T} y2={H - axisH + 4} stroke={grid} />
            <text x={x(t)} y={H - 6} fontSize="9.5" fill={AXIS} textAnchor="middle">{t}</text>
          </g>
        ))}
        {[lo, hi].map(t => (
          <g key={`bound-${t}`}>
            <line x1={x(t)} x2={x(t)} y1={T} y2={H - axisH + 4} stroke={bound} strokeDasharray="3 3" />
            <text x={x(t)} y={H - 6} fontSize="9.5" fill={boundTxt} textAnchor="middle" fontWeight={700}>{fmt(t)}</text>
          </g>
        ))}
        {usable.map((r, i) => {
          const s = boxStats(r.values);
          const cy = T + i * rowH + rowH / 2, h = 16;
          return (
            <g key={r.season}>
              <title>{`${r.season} — min ${s.mn.toFixed(1)} · Q1 ${s.q1.toFixed(1)} · median ${s.md.toFixed(1)} · Q3 ${s.q3.toFixed(1)} · max ${s.mx.toFixed(1)}`}</title>
              <text x={0} y={cy + 4} fontSize="11.5" fill="#e6ebf2" fontWeight={700}>{r.season}</text>
              <BoxMarks s={s} x={x} y={cy - h / 2} h={h} cap={3} />
              <text x={x(s.md)} y={cy - h / 2 - 3} fontSize="8.5" fill="var(--acc)"
                textAnchor="middle" fontWeight={700}>{s.md.toFixed(1)}</text>
              <text x={x(s.mn)} y={cy + h / 2 + 9} fontSize="8" fill={AXIS} textAnchor="middle">{s.mn.toFixed(1)}</text>
              <text x={x(s.mx)} y={cy + h / 2 + 9} fontSize="8" fill={AXIS} textAnchor="middle">{s.mx.toFixed(1)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
