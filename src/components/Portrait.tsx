import { useEffect, useState } from "react";

/**
 * A player headshot from Sleeper's public CDN — no API call, no pipeline
 * change, keyed on the same Sleeper player id the whole site already runs on.
 *
 * Sleeper does not have a photo for everyone (rookies before camp, deep
 * practice-squad bodies, the odd veteran), and the CDN answers those with a
 * 404 rather than a placeholder. The image is therefore only in the layout
 * once it has loaded: an empty bordered square where a face should be would
 * read as a broken page, and a generic silhouette would be a claim ("this is
 * what he looks like") the site cannot back. Absent is absent.
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
  const [ok, setOk] = useState<boolean | null>(null);
  // a new pid is a new question; don't carry the last player's answer over
  useEffect(() => { setOk(null); }, [pid]);
  if (ok === false) return null;
  return (
    <img
      className={`portrait${ok ? " on" : ""}${className ? ` ${className}` : ""}`}
      src={`https://sleepercdn.com/content/nfl/players/thumb/${pid}.jpg`}
      alt=""
      width={size} height={size}
      loading="lazy" decoding="async"
      onLoad={() => setOk(true)}
      onError={() => setOk(false)}
    />
  );
}
