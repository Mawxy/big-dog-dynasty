import { useNavigate, useParams } from "react-router-dom";
import type { RecentTrades } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { pInfo } from "../../lib/league";
import { RECENT_NOTE, RecentFigs, RecentRows } from "../../components/RecentTrades";
import { Band, DataError } from "../ui";
import "./league.css";

/** data/recent_trades/<bucket>.json — MIRRORS dynasty_movers.py
 *  (RECENT_BUCKETS / recent_bucket): the same pid has to land in the same
 *  file on both ends. Numeric pids by modulus; anything else in bucket 0. */
const RECENT_BUCKETS = 32;
const recentBucket = (pid: string) => (/^\d+$/.test(pid) ? Number(pid) % RECENT_BUCKETS : 0);

/**
 * EVERY TRADE HE WAS IN this window, across the crawled dynasty leagues
 * (Max, 2026-09-09). The player page shows three and links here; this is
 * the same strip and the same rows with nothing held back — the shard now
 * carries the whole list, so the count in the band is the count on the page.
 */
export default function PlayerTrades() {
  const pid = useParams().pid!;
  const nav = useNavigate();
  const { players } = useLeague();
  const q = useJson<RecentTrades>(`data/recent_trades/${recentBucket(pid)}.json`, "globalDaily");
  const recent = q.data?.players[pid] ?? null;
  const [name, pos, nfl] = pInfo(players, pid);
  const label = q.data?.names[pid]?.[0] && !q.data.names[pid][0].startsWith("#") ? q.data.names[pid][0] : name;

  return (
    <>
      <div className="v3-head">
        <button type="button" className="rail-back ptx-back" onClick={() => nav(-1)}>← Back</button>
        <h1>{label}</h1>
        <span className="sub">{[nfl || null, pos].filter(Boolean).join(" · ")} · recent trades</span>
      </div>
      {q.error ? <DataError what="Trades didn't load" />
        : !q.data ? <div className="empty">Loading…</div>
        : (
          <>
            <Band label={`Last ${q.data.meta.window_days} days`}
              note={`Across the crawled dynasty leagues · as of ${q.data.meta.as_of.slice(0, 10)} · newest first`} />
            {!recent ? (
              <div className="tnote screen">
                Not traded in any crawled league in the last {q.data.meta.window_days} days.
              </div>
            ) : (
              <>
                <RecentFigs recent={recent} />
                <RecentRows pid={pid} trades={recent.trades} file={q.data} players={players} />
                {recent.trades.length < recent.n && (
                  <div className="tnote screen">
                    Showing {recent.trades.length} of {recent.n} — the rest are in the corpus but
                    not in this shard; the next crawl writes them all.
                  </div>
                )}
                <div className="tnote screen">{RECENT_NOTE}</div>
              </>
            )}
          </>
        )}
    </>
  );
}
