import { quart } from "../lib/stats";

/** Compact vertical box-and-whisker. Pass a shared `domain` so plots in
 *  sibling cards are drawn to the same scale and stay comparable. */
export default function VBoxPlot({ values, domain, height = 230 }: {
  values: number[]; domain?: [number, number]; height?: number;
}) {
  if (values.length < 4) return null;
  const v = [...values].sort((a, b) => a - b);
  const mn = v[0], q1 = quart(v, .25), md = quart(v, .5), q3 = quart(v, .75), mx = v[v.length - 1];
  const [lo, hi] = domain ?? [mn, mx];
  const T = 10, B = height - 12;
  const y = (t: number) => B - (t - lo) / ((hi - lo) || 1) * (B - T);
  const bx = 6, w = 28, cx = bx + w / 2, c = "#8b96a5";

  // labels right of the plot; skip any that would collide with one already placed
  const placed: number[] = [];
  const labels: { t: number; col: string; bold?: boolean }[] = [
    { t: md, col: "var(--acc)", bold: true }, { t: mx, col: c }, { t: mn, col: c },
    { t: q3, col: c }, { t: q1, col: c },
  ];
  const texts = labels.flatMap(l => {
    const py = y(l.t);
    if (placed.some(p => Math.abs(p - py) < 10)) return [];
    placed.push(py);
    return [(
      <text key={l.t + l.col} x={bx + w + 6} y={py + 3} fontSize="8.5"
        fill={l.col} fontWeight={l.bold ? 700 : 400}>{l.t.toFixed(1)}</text>
    )];
  });

  return (
    <svg width={92} height={height} style={{ flexShrink: 0 }}>
      <line x1={cx} x2={cx} y1={y(mn)} y2={y(q1)} stroke={c} />
      <line x1={cx} x2={cx} y1={y(q3)} y2={y(mx)} stroke={c} />
      <line x1={bx + 6} x2={bx + w - 6} y1={y(mn)} y2={y(mn)} stroke={c} />
      <line x1={bx + 6} x2={bx + w - 6} y1={y(mx)} y2={y(mx)} stroke={c} />
      <rect x={bx} y={y(q3)} width={w} height={Math.max(1, y(q1) - y(q3))} fill="#1e6fd933" stroke="#1e6fd9" />
      <line x1={bx} x2={bx + w} y1={y(md)} y2={y(md)} stroke="var(--acc)" strokeWidth={2} />
      {texts}
    </svg>
  );
}
