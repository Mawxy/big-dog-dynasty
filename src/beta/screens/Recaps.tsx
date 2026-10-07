import { useState } from "react";
import { useParams } from "react-router-dom";
import { useJson } from "../../lib/useJson";
import { inline, RecapBody } from "../../lib/recapMd";
import { RouteLink } from "../../components/RouteLink";
import { Band, useBetaPath } from "../ui";
import "./recaps.css";

/**
 * THE WEEKLY RECAP (Max, 2026-10-07).
 *
 * One article per scored week, written from the published data and packed into
 * recaps.json by scripts/add_recap.py. Two places read it:
 *
 *   League   the newest recap, as a band directly above Last week: headline
 *            and first paragraph, and a tap opens the full article in place —
 *            the row-drawer grammar, under the headline in the same flow,
 *            never a modal.
 *   Recaps   every recap, newest first, each one the same headline row with
 *            the same drawer. /recaps/<id> opens with that one expanded, which
 *            is the address a shared link should carry.
 *
 * A league that has never published one (every league but the default today)
 * 404s on the file, and the League band simply does not draw: a missing recap
 * is not news, so it does not take up a band saying so.
 */

export interface Recap {
  id: string;
  season: number;
  week: number;
  headline: string;
  dek: string;
  body: string;
  published: string;
}
export interface RecapFile { recaps: Recap[] }

/** one recap: the headline row, and the article under it when open */
function RecapItem({ r, open, onToggle, kicker }: {
  r: Recap; open: boolean; onToggle: () => void; kicker: string;
}) {
  return (
    <div className={`rcp-item${open ? " open" : ""}`}>
      <button type="button" className="rcp-head" aria-expanded={open} onClick={onToggle}>
        <span className="rcp-kick">{kicker}</span>
        <span className="rcp-title">{r.headline}</span>
        {!open && r.dek && <span className="rcp-dek">{inline(r.dek)}</span>}
        <span className="rcp-more">{open ? "Close ▴" : "Read the recap ▾"}</span>
      </button>
      {open && (
        <article className="rcp-body">
          <div className="rcp-col">
            <RecapBody md={r.body} />
            <div className="rcp-foot">Published {r.published} · written from the board's own data</div>
          </div>
        </article>
      )}
    </div>
  );
}

/** League's band: the newest recap, collapsed until tapped */
export function RecapBand() {
  const betaPath = useBetaPath();
  const q = useJson<RecapFile>("recaps.json");
  const [open, setOpen] = useState(false);
  const r = q.data?.recaps?.[0];
  if (!r) return null;
  return (
    <>
      <Band label={`Weekly recap · ${r.season} wk ${r.week}`}
        right={<RouteLink to={betaPath("/recaps")} className="lgx-all">All recaps →</RouteLink>} />
      <RecapItem r={r} open={open} onToggle={() => setOpen(o => !o)} kicker={`Week ${r.week} recap`} />
    </>
  );
}

/** Seasons' week board: that week's recap, if one was written, collapsed
 *  until tapped. Draws nothing for a week with no recap. */
export function RecapForWeek({ season, week }: { season: string | number; week: number }) {
  const betaPath = useBetaPath();
  const q = useJson<RecapFile>("recaps.json");
  const [open, setOpen] = useState(false);
  const r = q.data?.recaps?.find(x => x.season === Number(season) && x.week === week);
  if (!r) return null;
  return (
    <>
      <Band label={`Weekly recap · ${r.season} wk ${r.week}`}
        right={<RouteLink to={betaPath("/recaps")} className="lgx-all">All recaps →</RouteLink>} />
      <RecapItem r={r} open={open} onToggle={() => setOpen(o => !o)} kicker={`Week ${r.week} recap`} />
    </>
  );
}

/** the archive: every recap, newest first */
export default function Recaps() {
  const { id } = useParams();
  const q = useJson<RecapFile>("recaps.json");
  const [open, setOpen] = useState<string | null>(id ?? null);
  const list = q.data?.recaps ?? [];
  return (
    <>
      <div className="v3-head"><h1>Weekly recaps</h1>
        {list.length > 0 && <span className="sub">{list.length} published · newest first</span>}</div>
      {q.loading ? <div className="empty">Loading…</div>
        : q.error || !list.length ? <div className="empty">No recaps published for this league yet.</div>
        : list.map(r => (
          <RecapItem key={r.id} r={r} open={open === r.id}
            onToggle={() => setOpen(o => (o === r.id ? null : r.id))}
            kicker={`${r.season} · Week ${r.week}`} />
        ))}
    </>
  );
}
