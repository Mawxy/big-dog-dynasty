import BoxMarks, { AXIS, boxStats } from "./BoxMarks";

export default function BoxPlot({ values, label }: { values: number[]; label: string }) {
  if (values.length < 4) return null;
  const s = boxStats(values);
  const L = 16, R = 324, y = 16, h = 20;
  const x = (t: number) => L + (t - s.mn) / ((s.mx - s.mn) || 1) * (R - L);
  const lab = (t: number, px: number, py: number, col = AXIS) => (
    <text x={px} y={py} fontSize="8.5" fill={col} textAnchor="middle">{t.toFixed(1)}</text>
  );
  return (
    <div>
      <div style={{ color: "var(--txt)", fontSize: 12.5 }}><b>{label}</b></div>
      <svg width={340} height={74} style={{ display: "block", margin: "4px 0" }}>
        <BoxMarks s={s} x={x} y={y} h={h} />
        {lab(s.md, x(s.md), y - 5, "var(--acc)")}
        {lab(s.q1, x(s.q1), y + h + 12)}{lab(s.q3, x(s.q3), y + h + 12)}
        {lab(s.mn, x(s.mn), y + h + 23)}{lab(s.mx, x(s.mx), y + h + 23)}
      </svg>
    </div>
  );
}
