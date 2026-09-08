import { useEffect, useState } from "react";

/**
 * A franchise's picture — the team logo its owner set on Sleeper, or failing
 * that the owner's own avatar (build_site_data.py chooses; this only draws).
 *
 * The same contract as `Portrait`: the image is in the layout from the first
 * paint, sized by its width/height attributes so the name beside it does not
 * jump when the file lands, and it unmounts on error rather than showing a
 * broken-image glyph or a placeholder. A slot with no picture is a fact about
 * the owner, not a gap for the site to paper over.
 *
 * NO FRAME (style.css `.portrait`), for the same reason as the headshots: the
 * picture sits straight on the rail's --deep.
 */
export default function TeamAvatar({ src, size = 112, className = "" }: {
  /** teams.json `avatar`; null/undefined draws nothing */
  src?: string | null;
  /** rendered square, in CSS px */
  size?: number;
  className?: string;
}) {
  const [ok, setOk] = useState(true);
  // a new picture is a new question; don't carry the last one's failure over
  useEffect(() => { setOk(true); }, [src]);
  if (!src || !ok) return null;
  return (
    <img
      className={`portrait team${className ? ` ${className}` : ""}`}
      src={src}
      alt=""
      width={size} height={size}
      decoding="async"
      onError={() => setOk(false)}
    />
  );
}
