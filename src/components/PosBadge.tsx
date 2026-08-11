/**
 * The position badge — one component for every size the sheet defines.
 *
 * Thirteen call sites hand-rolled `<span className={`pos ${pos}`}>` around the
 * three-line component that used to live here, and drifted: three sizes, two
 * ways of tinting, and a label that is sometimes the position and sometimes
 * not (a traded pick reads "PK"). The classes emitted here are exactly the
 * ones those sites emitted, so nothing moves a pixel.
 *
 * `size` names the sheet's own modifiers (`.pos.sm`, `.pos.wide`,
 * `.pos.mini`). `color` tints inline INSTEAD of the `.pos.QB`-style class —
 * that is how the mini and wide badges reach positions the sheet has no class
 * for, so passing it drops the position class the way those sites did.
 */
export default function PosBadge({ pos, rank, size, text, color }: {
  pos: string;
  /** rank within position, appended to the label (RB4) */
  rank?: number | string;
  size?: "sm" | "mini" | "wide";
  /** label override for the rare badge whose text is not its position */
  text?: string;
  /** inline tint; replaces the position class */
  color?: string;
}) {
  const cls = ["pos", size, color ? null : pos].filter(Boolean).join(" ");
  return (
    <span className={cls} style={color ? { background: color } : undefined}>
      {text ?? pos}{rank ?? ""}
    </span>
  );
}
