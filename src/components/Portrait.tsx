import { useEffect, useState } from "react";
import { useLeague } from "../lib/context";
import { headshots } from "../lib/league";

/**
 * A player headshot, keyed on the Sleeper player id the whole site runs on.
 * `lib/league.headshots` lists the sources best-first — ESPN's transparent
 * PNG (via the ESPN id in players_min), then Sleeper's JPG on white — and
 * this walks them on error. No API call.
 *
 * Nobody has a photo for everyone (rookies before camp, deep practice-squad
 * bodies), and the CDNs answer those with a 404 rather than a placeholder.
 * The image is therefore only in the layout once it has loaded: an empty
 * bordered square where a face should be would read as a broken page, and a
 * generic silhouette would be a claim ("this is what he looks like") the site
 * cannot back. Absent is absent.
 *
 * Achromatic on purpose — 1px --rule on --band, radius zero. Position colour
 * stays on the badge and the spine; a tinted frame would be a fifth accent.
 */
export default function Portrait({ pid, size = 112, className = "" }: {
  pid: string;
  /** rendered square, in CSS px */
  size?: number;
  className?: string;
}) {
  const { players } = useLeague();
  const [i, setI] = useState(0);
  const [ok, setOk] = useState(false);
  // a new pid is a new question; don't carry the last player's answer over
  useEffect(() => { setI(0); setOk(false); }, [pid]);
  const src = headshots(players, pid)[i];
  if (!src) return null;
  return (
    <img
      className={`portrait${ok ? " on" : ""}${className ? ` ${className}` : ""}`}
      src={src}
      alt=""
      width={size} height={size}
      loading="lazy" decoding="async"
      onLoad={() => setOk(true)}
      onError={() => { setOk(false); setI(n => n + 1); }}
    />
  );
}
