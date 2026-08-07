import { HONOR_LABEL, HONOR_NOTE, HONOR_ORDER, type HonorKey } from "../lib/honors";

/**
 * Honor marks — five flat silhouettes rendered at 20px on the player rail.
 *
 * Interior detail is negative space, never added line work: at this size a
 * stroke fills in and the mark turns to mush. Each shape is masked once here
 * and referenced by <use>, so the mask ids exist a single time on the page.
 *
 * Color comes from CSS (`currentColor`), which is what lets the crown and the
 * gem take the position tint without four copies of each file.
 */
export function HonorSprite() {
  return (
    <svg width={0} height={0} aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        <mask id="hm-gem">
          <path d="M6 3h12l4 6-10 13L2 9Z" fill="#fff" />
          <g stroke="#000" strokeWidth="1.15">
            <path d="M2 9h20" /><path d="M11 3 8 9" /><path d="M13 3l3 6" />
            <path d="M8 9l4 13" /><path d="M16 9l-4 13" />
          </g>
        </mask>
        <mask id="hm-crown">
          <path d="M3 19V7l4.5 5L12 5l4.5 7L21 7v12Z" fill="#fff" />
          <path d="M3.4 15.6h17.2" stroke="#000" strokeWidth="1.15" />
        </mask>
        <mask id="hm-dog">
          <path d="M4 5.5 6.8 3 9.4 6h5.2L17.2 3 20 5.5v7l-2.8 3v4H6.8v-4L4 12.5Z" fill="#fff" />
          <g stroke="#000" strokeWidth="1.05">
            <path d="M7 4.3 8.5 6.1" /><path d="M17 4.3 15.5 6.1" /><path d="M7.4 15.2h9.2" />
          </g>
          <path d="M11 16.6h2l-.35 1.6h-1.3Z" fill="#000" />
        </mask>

        <symbol id="hm-champ" viewBox="0 0 24 24">
          <path d="M6.5 3h11l-1.5 8H8Zm.2 1.2H3.2v5.2h4l-.3-1.4H4.6V5.6h2.1Zm10.6 0h3.5v5.2h-4l.3-1.4h2.3V5.6h-2.1ZM11 11.8h2V15h-2Zm-2.3 4h6.6v1.8H8.7Zm-1.9 2.6h10.4V21H6.8Z" fill="currentColor" />
        </symbol>
        <symbol id="hm-mvp" viewBox="0 0 24 24">
          <path d="M4 5.5 6.8 3 9.4 6h5.2L17.2 3 20 5.5v7l-2.8 3v4H6.8v-4L4 12.5Z" fill="currentColor" mask="url(#hm-dog)" />
        </symbol>
        <symbol id="hm-king" viewBox="0 0 24 24">
          <path d="M3 19V7l4.5 5L12 5l4.5 7L21 7v12Z" fill="currentColor" mask="url(#hm-crown)" />
        </symbol>
        <symbol id="hm-elite" viewBox="0 0 24 24">
          <path d="M6 3h12l4 6-10 13L2 9Z" fill="currentColor" mask="url(#hm-gem)" />
        </symbol>
        <symbol id="hm-bar" viewBox="0 0 24 24">
          <path d="M12 2.5l2.85 6.66 7.15.61-5.5 4.87 1.68 6.88L12 17.77 5.82 21.52 7.5 14.64 2 9.77l7.15-.61Z" fill="currentColor" />
        </symbol>
      </defs>
    </svg>
  );
}

/**
 * The key — a divided strip on --deep, the same cell anatomy as the figure
 * strip, so it reads as part of the board rather than as loose caption text.
 *
 * Always all five, always in rarity order, whether or not this player earned
 * them: a legend that changes per player is not a legend, and a reader cannot
 * tell a rare mark from a common one without seeing the whole ladder.
 *
 * The threshold each mark was measured against lives in the tooltip rather
 * than printed under every label — five definitions set as body copy turned
 * the key into the loudest thing on the page.
 */
export function HonorLegend() {
  return (
    <div className="hmark-legend">
      {HONOR_ORDER.map(k => (
        <span key={k} className="hmark-leg" title={`${HONOR_LABEL[k]} — ${HONOR_NOTE[k]}`}>
          <HonorMark k={k} size={16} />
          <span className="lb">{HONOR_LABEL[k]}</span>
        </span>
      ))}
    </div>
  );
}

export function HonorMark({ k, size = 20 }: { k: HonorKey; size?: number }) {
  return (
    <svg className={`hmark hmark--${k}`} width={size} height={size} role="img"
      aria-label={HONOR_LABEL[k]}>
      <title>{`${HONOR_LABEL[k]} — ${HONOR_NOTE[k]}`}</title>
      <use href={`#hm-${k}`} />
    </svg>
  );
}

/**
 * A row of marks. A tier earned more than once renders one mark and a tabular
 * ×N, not N copies — copies wrap a long career onto a second line and the
 * rarity ordering stops being scannable. A count is a figure, which is what the
 * board does with counts everywhere else.
 */
export default function HonorMarks(
  { marks, size = 20, showCounts = true }:
  { marks: [HonorKey, number][] | HonorKey[]; size?: number; showCounts?: boolean },
) {
  const pairs: [HonorKey, number][] = marks.length && Array.isArray(marks[0])
    ? marks as [HonorKey, number][]
    : (marks as HonorKey[]).map(k => [k, 1]);
  // An empty row still renders: in the ladder this is a grid cell, and
  // returning null there collapses the column and shifts the WAR figure.
  return (
    <div className="hmark-row">
      {pairs.map(([k, n]) => (
        <span key={k} className="hmark-item">
          <HonorMark k={k} size={size} />
          {showCounts && n > 1 && <span className="hmark-x">×{n}</span>}
        </span>
      ))}
    </div>
  );
}
