/**
 * Color math for heat cells, shared by the screens that shade figures.
 *
 * views/Draft.tsx still carries its own copies of these two (it predates this
 * module); new heat maps import from here.
 */

/** linear blend of two #rrggbb colors, t clamped to 0..1 */
export function mix(a: string, b: string, t: number): string {
  t = Math.max(0, Math.min(1, t));
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + h(r1 + (r2 - r1) * t) + h(g1 + (g2 - g1) * t) + h(b1 + (b2 - b1) * t);
}

/** relative luminance, for picking ink off a cell's own color */
export function lum(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
