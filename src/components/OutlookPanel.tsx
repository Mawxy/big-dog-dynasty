import { useState } from "react";
import type { Insights } from "../lib/types";

/**
 * THE WRITTEN OUTLOOK, FOLDED (Max, 2026-11-17).
 *
 * The verdict panel on a team page used to print the whole outlook, a
 * thousand characters of prose above the roster. It now leads with a
 * HEADLINE and opens into the text under it, the weekly recap's grammar:
 * kicker, headline, a "Read" line, and a tap opens the body in place.
 *
 * `headline` is written with the outlook (insights.json, one per team). An
 * outlook published before the field existed has none, and it draws open the
 * way it always did, so nothing is hidden behind a row with no headline on it.
 */
export default function OutlookPanel({ insight, season, generated }: {
  insight: Insights["teams"][string];
  season?: number;
  generated?: string;
}) {
  const [open, setOpen] = useState(!insight.headline);
  return (
    <div className={`verdict vfold${open ? " open" : ""}`}>
      <button type="button" className="vfold-head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className="k">{season} outlook</span>
        {insight.headline && <span className="hl">{insight.headline}</span>}
        <span className="meta">{insight.head} · written {generated}</span>
        <span className="more">{open ? "Close ▴" : "Read the outlook ▾"}</span>
      </button>
      {open && <div className="body">{insight.text}</div>}
    </div>
  );
}
