import type { ReactNode } from "react";

/**
 * THE MOBILE-FIRST UI'S ICONS. Inline SVG on a 24px grid, one stroke weight,
 * `currentColor` throughout, so a tab's icon takes the tab's own ink and every
 * palette colours them for free. Drawn here rather than pulled from a library:
 * the set is nine glyphs and the board ships no icon dependency.
 *
 * Decorative by contract (`aria-hidden`): every control that carries one also
 * carries its word or an aria-label.
 */
const PATHS: Record<string, ReactNode> = {
  /* My Team — a shield, the franchise's own crest */
  team: <path d="M12 3.2 5 5.8v5.4c0 4.3 2.9 7.6 7 9.6 4.1-2 7-5.3 7-9.6V5.8z" />,
  /* League — a trophy */
  league: (
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0z" />
      <path d="M8 5.5H5.2v1.2A3.3 3.3 0 0 0 8.4 10M16 5.5h2.8v1.2a3.3 3.3 0 0 1-3.2 3.3" />
      <path d="M12 13v3.5M8.5 20h7M9.5 20c0-2 1-3.5 2.5-3.5s2.5 1.5 2.5 3.5" />
    </>
  ),
  /* Players — a ranked list */
  players: (
    <>
      <circle cx="5.5" cy="6.5" r="1.4" />
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="5.5" cy="17.5" r="1.4" />
      <path d="M10 6.5h9.5M10 12h9.5M10 17.5h6" />
    </>
  ),
  /* Trade — two arrows passing */
  trade: (
    <>
      <path d="M4 8.5h14.5M15 5l3.5 3.5L15 12" />
      <path d="M20 15.5H5.5M9 12l-3.5 3.5L9 19" />
    </>
  ),
  /* More — a two-by-two grid */
  more: (
    <>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" />
    </>
  ),
  /* Draft — a clipboard */
  drafts: (
    <>
      <rect x="5.5" y="5" width="13" height="15.5" rx="2" />
      <path d="M9.5 5V3.8h5V5M9 10.5h6M9 14h6M9 17.5h3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="m15.2 15.2 4.8 4.8" />
    </>
  ),
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ id, size = 24 }: { id: string; size?: number }) {
  const body = PATHS[id];
  if (!body) return null;
  return (
    <svg className="mf-ic" width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">{body}</svg>
  );
}
