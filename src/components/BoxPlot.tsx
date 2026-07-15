import { quart } from "../lib/stats";

export default function BoxPlot({ values, label }: { values: number[]; label: string }) {
  if (values.length < 4) return null;
  const v = [...values].sort((a, b) => a - b);
  const mn = v[0], q1 = quart(v, .25), md = quart(v, .5), q3 = quart(v, .75), mx = v[v.length - 1];
  const L = 16, R = 324, y = 16, h = 20, c = "#8b96a5";
  const x = (t: number) => L + (t - mn) / ((mx - mn) || 1) * (R - L);
  const lab = (t: number, px: number, py: number, col = c) => (
    <text x={px} y={py} fontSize="8.5" fill={col} textAnchor="middle">{t.toFixed(1)}</text>
  );
  return (
    <div>
      <div style={{ color: "var(--txt)", fontSize: 12.5 }}><b>{label}</b></div>
      <svg width={340} height={74} style={{ display: "block", margin: "4px 0" }}>
        <line x1={x(mn)} x2={x(q1)} y1={y + h / 2} y2={y + h / 2} stroke={c} />
        <line x1={x(q3)} x2={x(mx)} y1={y + h / 2} y2={y + h / 2} stroke={c} />
        <line x1={x(mn)} x2={x(mn)} y1={y + 4} y2={y + h - 4} stroke={c} />
        <line x1={x(mx)} x2={x(mx)} y1={y + 4} y2={y + h - 4} stroke={c} />
        <rect x={x(q1)} y={y} width={Math.max(1, x(q3) - x(q1))} height={h} fill="#1e6fd933" stroke="#1e6fd9" />
        <line x1={x(md)} x2={x(md)} y1={y} y2={y + h} stroke="var(--acc)" strokeWidth={2} />
        {lab(md, x(md), y - 5, "var(--acc)")}
        {lab(q1, x(q1), y + h + 12)}{lab(q3, x(q3), y + h + 12)}
        {lab(mn, x(mn), y + h + 23)}{lab(mx, x(mx), y + h + 23)}
      </svg>
    </div>
  );
}
