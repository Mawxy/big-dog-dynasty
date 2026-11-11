/** a rendered figure whose digits are all zero — "0", "0.00", "0.000" */
const ROUNDS_TO_ZERO = /^0(\.0*)?$/;

/**
 * toFixed, with the ASCII hyphen swapped for a true minus (−) — the same
 * glyph `sgn` emits, so signed and unsigned figures agree site-wide.
 *
 * THE SIGN IS DECIDED AFTER ROUNDING. `(-0.0004).toFixed(3)` is `"-0.000"`,
 * and a minus sign in front of a figure whose every digit is zero is a claim
 * the figure does not support — the board printed "−0.000" WAR for a week a
 * player was four ten-thousandths under. The rounded magnitude is what is
 * shown, so it is what decides the sign.
 */
export const fmt = (n: number, d = 2) => {
  const s = n.toFixed(d);
  if (!s.startsWith("-")) return s;
  const mag = s.slice(1);
  return ROUNDS_TO_ZERO.test(mag) ? mag : "−" + mag;
};

/**
 * Decimals for a WAR figure. THE number, and it is TWO (Max, 2026-11-11):
 * "WAR should never display to 3 decimals." Every WAR figure on the site
 * reads at this precision: season totals, week cells, per-game rates, trade
 * assets, pick values, benchmarks.
 *
 * It was three until then for the older in-shell views (franchise page, trade
 * cards, week grid, History, Insights) while the beta screens were already at
 * two, so the same player's season read 1.346 on one page and 1.35 on the
 * next. One number ends that.
 *
 * WAR only. Points, PPG, the indices and market values keep their own
 * precision; they are different quantities at different magnitudes. This is
 * display: the data files still carry three places.
 */
export const WAR_DP = 2;

/** standard normal CDF (Abramowitz–Stegun 26.2.17, |err| < 7.5e-8) */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/** inverse standard normal CDF (Acklam's rational approximation) */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** signed figure with a true minus sign (−, not the ASCII hyphen toFixed
 *  emits). The ONE sgn — Draft, DraftDetail and PlayoffPanel carried local
 *  copies that disagreed on glyph and decimals.
 *
 *  Sign after rounding, as in `fmt`: a value that renders as all zeros prints
 *  unsigned, so neither "−0.000" nor "+0.000" reaches a column. */
export const sgn = (v: number, d = WAR_DP) => {
  const s = fmt(Math.abs(v), d);
  if (ROUNDS_TO_ZERO.test(s)) return s;
  return (v > 0 ? "+" : v < 0 ? "−" : "") + s;
};

/** a WAR figure, unsigned */
export const fmtWar = (v: number) => fmt(v, WAR_DP);

/** a WAR figure, signed with a true minus glyph */
export const sgnWar = (v: number) => sgn(v, WAR_DP);

/* ---- the older names for the same thing ----------------------------------
   The beta screens went to two places first (Max, 2026-09-02) and carried
   their own constant and formatters. Since 2026-11-11 the whole site is at
   two, so these are aliases kept for the files that import them. */
export const WAR_DP_BETA = WAR_DP;
export const fmtWar2 = fmtWar;
export const sgnWar2 = sgnWar;

/** 1 -> "1st", 12 -> "12th" — teens handled (11th/12th/13th) */
export const ord = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/** meter-fill width: share of `max`, clamped so a negative value reads 0%
 *  (was exported as `pct`, a name five files reused for four other things) */
export const meterWidth = (v: number, max: number) =>
  Math.round((Math.max(0, v) / max) * 100) + "%";

/** a 0-1 rate as a whole-number percent string; null in, null out — callers
 *  pick their own null glyph (`rate(v) ?? "—"`) */
export const rate = (v: number | null | undefined): string | null =>
  v == null ? null : Math.round(v * 100) + "%";

/** ink for a signed WAR-over-expectation figure. One pair site-wide: Draft
 *  used --war-pos/--war-neg while DraftDetail used --good/--bad for the same
 *  quantity on linked pages. */
export const warInk = (v: number | null) => v == null ? "var(--dim3)"
  : v > 0.02 ? "var(--war-pos)" : v < -0.02 ? "var(--war-neg)" : "var(--dim)";
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
