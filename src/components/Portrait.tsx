import { useEffect, useState } from "react";
import { useLeague } from "../lib/context";
import { headshots } from "../lib/league";

/**
 * A player headshot, keyed on the Sleeper player id the whole site runs on.
 * `lib/league.headshots` lists the sources best-first — ESPN's transparent
 * cutout, via the ESPN id in players_min — and this walks them on error. No
 * API call.
 *
 * Nobody has a photo for everyone (rookies before camp, deep practice-squad
 * bodies), and the CDNs answer those with a 404 rather than a placeholder.
 * The image is therefore only in the layout once it has loaded: an empty
 * bordered square where a face should be would read as a broken page, and a
 * generic silhouette would be a claim ("this is what he looks like") the site
 * cannot back. Absent is absent.
 *
 * No frame (style.css .portrait): the cutout sits straight on the rail.
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
      // NOT loading="lazy": the image is display:none until it has loaded
      // (style.css .portrait), and a lazy image with no box is never fetched —
      // it sat hidden forever on the first try. One image per page is not a
      // bandwidth problem.
      decoding="async"
      onLoad={() => setOk(true)}
      onError={() => { setOk(false); setI(n => n + 1); }}
    />
  );
}
