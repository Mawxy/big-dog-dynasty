export const fmt = (n: number, d = 2) => n.toFixed(d);
export const sgn = (v: number, d = 3) => (v > 0 ? "+" : "") + fmt(v, d);
export const clsOf = (n: number) => n > 0.0005 ? "num good" : n < -0.0005 ? "num bad" : "num";
export const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

export function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function quart(s: number[], q: number): number {
  const pos = (s.length - 1) * q, b = Math.floor(pos), r = pos - b;
  return s[b] + (s[b + 1] !== undefined ? r * (s[b + 1] - s[b]) : 0);
}
