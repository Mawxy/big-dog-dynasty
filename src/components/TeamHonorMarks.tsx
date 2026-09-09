import {
  TEAM_HONOR_LABEL, TEAM_HONOR_NOTE, TEAM_HONOR_ORDER, TEAM_HONOR_SYMBOL, type TeamHonorKey,
} from "../lib/teamHonors";

/**
 * Franchise honor marks — the player marks' shapes (HonorSprite must be on the
 * page), coloured for the franchise ladder: `.hmark--t-<key>` in style.css.
 * Same anatomy as HonorMarks so the two rows read as one system.
 */
export function TeamHonorMark({ k, size = 20 }: { k: TeamHonorKey; size?: number }) {
  return (
    <svg className={`hmark hmark--t-${k}`} width={size} height={size} role="img"
      aria-label={TEAM_HONOR_LABEL[k]}>
      <title>{`${TEAM_HONOR_LABEL[k]} — ${TEAM_HONOR_NOTE[k]}`}</title>
      <use href={`#hm-${TEAM_HONOR_SYMBOL[k]}`} />
    </svg>
  );
}

/**
 * A row of marks. A mark earned more than once renders once with a tabular
 * ×N, as the player row does — a count is a figure.
 */
export default function TeamHonorMarks(
  { marks, size = 20, showCounts = true }:
  { marks: [TeamHonorKey, number][] | TeamHonorKey[]; size?: number; showCounts?: boolean },
) {
  const pairs: [TeamHonorKey, number][] = marks.length && Array.isArray(marks[0])
    ? marks as [TeamHonorKey, number][]
    : (marks as TeamHonorKey[]).map(k => [k, 1]);
  return (
    <div className="hmark-row">
      {pairs.map(([k, n]) => (
        <span key={k} className="hmark-item">
          <TeamHonorMark k={k} size={size} />
          {showCounts && n > 1 && <span className="hmark-x">×{n}</span>}
        </span>
      ))}
    </div>
  );
}

/** the key — always all four, always in rarity order, definitions on hover */
export function TeamHonorLegend() {
  return (
    <div className="hmark-legend">
      {TEAM_HONOR_ORDER.map(k => (
        <span key={k} className="hmark-leg" title={`${TEAM_HONOR_LABEL[k]} — ${TEAM_HONOR_NOTE[k]}`}>
          <TeamHonorMark k={k} size={16} />
          <span className="lb">{TEAM_HONOR_LABEL[k]}</span>
        </span>
      ))}
    </div>
  );
}
