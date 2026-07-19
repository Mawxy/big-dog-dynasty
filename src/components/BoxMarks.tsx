import { quart } from "../lib/stats";

/** Shared palette for hand-rolled SVG charts. */
export const AXIS = "#8b96a5";
const FILL = "#1e6fd933", STROKE = "#1e6fd9";

export interface BoxStats { mn: number; q1: number; md: number; q3: number; mx: number }

/** Five-number summary. Sorts a copy, so callers can pass raw values. */
export function boxStats(values: number[]): BoxStats {
  const v = [...values].sort((a, b) => a - b);
  return { mn: v[0], q1: quart(v, .25), md: quart(v, .5), q3: quart(v, .75), mx: v[v.length - 1] };
}

/** Integer gridline positions spanning [lo, hi]. */
export function intTicks(lo: number, hi: number): number[] {
  const t: number[] = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) t.push(v);
  return t;
}

/** The box-and-whisker marks themselves — whiskers, end caps, IQR box, median
 *  rule — on a caller-supplied x scale. Callers own the axis, the labels and
 *  the layout; this owns the geometry so every chart draws an identical box.
 *  `y` is the top of the box, `cap` the whisker-cap inset, `medianOverhang`
 *  how far the median rule extends past the box. */
export default function BoxMarks({ s, x, y, h, cap = 4, medianOverhang = 0 }: {
  s: BoxStats; x: (t: number) => number; y: number; h: number;
  cap?: number; medianOverhang?: number;
}) {
  const cy = y + h / 2;
  return (
    <>
      <line x1={x(s.mn)} x2={x(s.q1)} y1={cy} y2={cy} stroke={AXIS} />
      <line x1={x(s.q3)} x2={x(s.mx)} y1={cy} y2={cy} stroke={AXIS} />
      <line x1={x(s.mn)} x2={x(s.mn)} y1={y + cap} y2={y + h - cap} stroke={AXIS} />
      <line x1={x(s.mx)} x2={x(s.mx)} y1={y + cap} y2={y + h - cap} stroke={AXIS} />
      <rect x={x(s.q1)} y={y} width={Math.max(1, x(s.q3) - x(s.q1))} height={h}
        fill={FILL} stroke={STROKE} />
      <line x1={x(s.md)} x2={x(s.md)} y1={y - medianOverhang} y2={y + h + medianOverhang}
        stroke="var(--acc)" strokeWidth={2} />
    </>
  );
}
