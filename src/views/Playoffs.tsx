import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { BracketFile } from "../lib/types";
import { jl } from "../lib/data";
import { useLeague, useLeaguePath } from "../lib/context";
import PlayoffBracket from "../components/PlayoffBracket";

/**
 * PLAYOFFS — every postseason, newest first, as collapsible brackets (the
 * same band control as the Draft tab's history boards). Each band links to
 * the year's own page for the MVP, the biggest upset and the superlatives.
 */
export default function Playoffs() {
  const { meta } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [brackets, setBrackets] = useState<Record<string, BracketFile> | null>(null);
  const [openS, setOpenS] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all(meta.seasons.map(s =>
      jl<BracketFile>(`${s}/bracket.json`)
        .then(b => [s, b] as const)
        .catch(() => null),
    )).then(all => {
      if (!live) return;
      const by: Record<string, BracketFile> = {};
      for (const e of all) if (e) by[e[0]] = e[1];
      setBrackets(by);
    });
    return () => { live = false; };
  }, [meta]);

  const seasons = useMemo(
    () => Object.keys(brackets ?? {}).sort().reverse(), [brackets]);
  // newest bracket open once loaded, the rest collapsed
  const open = openS ?? (seasons.length ? { [seasons[0]]: true } : {});

  const champOf = (b: BracketFile): string | null => {
    const fin = b.winners.find(g => g.p === 1);
    return fin?.w != null ? b.names[String(fin.w)] ?? null : null;
  };

  if (!brackets) return <div className="empty">Loading playoffs…</div>;
  if (!seasons.length) return <div className="empty">No playoff brackets on record yet.</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Playoffs</span>
        <span className="screen-note"><b>{seasons.length}</b> postseasons</span>
      </div>
      <div style={{ paddingTop: 4 }}>
        {seasons.map(season => {
          const b = brackets[season];
          const isOpen = !!open[season];
          const champ = champOf(b);
          return (
            <div key={season}>
              <button type="button" className="band dband" aria-expanded={isOpen}
                onClick={() => setOpenS({ ...open, [season]: !open[season] })}>
                <span className="band-label">
                  <span className="caret" style={{ color: isOpen ? "var(--acc)" : "var(--dim)" }}>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  {season} playoffs
                </span>
                <span className="band-note">
                  {champ && <>champion <span style={{ color: "var(--acc)" }}>{champ}</span> ·{" "}</>}
                  <span className="tlink" style={{ color: "var(--acc)" }}
                    onClick={e => { e.stopPropagation(); nav(lp(`/playoffs/${season}`)); }}>
                    Open playoffs page →
                  </span>
                </span>
              </button>
              {isOpen && <PlayoffBracket season={season} bracket={b} />}
            </div>
          );
        })}
        <div className="tnote" style={{ padding: "10px var(--pad) 22px", marginTop: 0 }}>
          Six teams, three weeks; seeds 1 and 2 rest through round 1. Click a game to open
          that week's matchup, or open a year's page for the MVP, the biggest upset and the
          rest of the story.
        </div>
      </div>
    </>
  );
}
