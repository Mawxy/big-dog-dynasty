import { quart } from "../lib/stats";

interface Row { season: string; values: number[] }

/** Grouped horizontal box plots — one row per season, one shared, labeled axis. */
export default function SeasonBoxes({ rows }: { rows: Row[] }) {
  const usable = rows.filter(r => r.values.length >= 4);
  if (!usable.length) return null;
  const all = usable.flatMap(r => r.values);
  const lo = Math.min(0, ...all), hi = Math.max(...all);
  const L = 52, R = 528, W = 540;
  const rowH = 34, T = 8, axisH = 24;
  const H = T + usable.length * rowH + axisH;
  const x = (t: number) => L + (t - lo) / ((hi - lo) || 1) * (R - L);
  const span = (hi - lo) || 1;
  const step = span <= 30 ? 5 : span <= 60 ? 10 : 20;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 0.001; t += step) ticks.push(t);
  const c = "#8b96a5", grid = "#242c38";
  return (
    <div>
      <div style={{ color: "var(--txt)", fontSize: 13, marginBottom: 4 }}>
        <b>Weekly points by season</b>
      </div>
      <svg width={W} height={H} style={{ maxWidth: "100%" }}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={T} y2={H - axisH + 4} stroke={grid} />
            <text x={x(t)} y={H - 6} fontSize="9.5" fill={c} textAnchor="middle">{t}</text>
          </g>
        ))}
        {usable.map((r, i) => {
          const v = [...r.values].sort((a, b) => a - b);
          const mn = v[0], q1 = quart(v, .25), md = quart(v, .5), q3 = quart(v, .75), mx = v[v.length - 1];
          const cy = T + i * rowH + rowH / 2, h = 16;
          return (
            <g key={r.season}>
              <title>{`${r.season} — min ${mn.toFixed(1)} · Q1 ${q1.toFixed(1)} · median ${md.toFixed(1)} · Q3 ${q3.toFixed(1)} · max ${mx.toFixed(1)}`}</title>
              <text x={0} y={cy + 4} fontSize="11.5" fill="#e6ebf2" fontWeight={700}>{r.season}</text>
              <line x1={x(mn)} x2={x(q1)} y1={cy} y2={cy} stroke={c} />
              <line x1={x(q3)} x2={x(mx)} y1={cy} y2={cy} stroke={c} />
              <line x1={x(mn)} x2={x(mn)} y1={cy - 5} y2={cy + 5} stroke={c} />
              <line x1={x(mx)} x2={x(mx)} y1={cy - 5} y2={cy + 5} stroke={c} />
              <rect x={x(q1)} y={cy - h / 2} width={Math.max(1, x(q3) - x(q1))} height={h}
                fill="#1e6fd933" stroke="#1e6fd9" />
              <line x1={x(md)} x2={x(md)} y1={cy - h / 2} y2={cy + h / 2} stroke="var(--acc)" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
