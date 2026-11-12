import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Franchises, FranchiseTx, Team as TeamT } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeagueCaps } from "../../lib/caps";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { seasonRowOf } from "../../lib/seasons";
import { tradeWhen } from "../../lib/trades";
import { MOVE_LABEL } from "../model";
import { Band, DataError, LensStrip, Sheet, SheetRow, useBetaPath } from "../ui";
import "./league.css";
// the ledger's filter buttons and sheet search (`.trx-fil`, `.trx-psearch`)
import "./trade.css";

/**
 * EVERY TRANSACTION A FRANCHISE HAS MADE (Max, 2026-11-12) — the full log
 * behind the Team screen's seven-day window: trades, waiver claims, free-agent
 * moves and commissioner edits, newest first, back to its first season.
 *
 * It reads `franchises.json` and nothing else. Each franchise's `tx` is its
 * own side of the league's transaction log, so a trade is stated the way this
 * franchise saw it: what it got and what it gave. The priced, two-sided record
 * of the same deal lives on the ledger, and a trade row opens it there where
 * the league has one.
 *
 * TWO AXES, two strips: the season (the screen's spine, carried in the address
 * so the Team screen can hand over a year already picked) and the kind of
 * move. A season band heads each year when every season is on screen, so a
 * long log still says where the reader is.
 *
 * A TRADE IS TWO NEUTRAL BASKETS here as everywhere: both sides in the same
 * ink, because coloring what was got green and what was given red would call
 * a winner the log does not.
 *
 * TWO FILTERS ON TOP OF THOSE (Max, 2026-11-12), the ledger's own buttons and
 * sheets: a TEAM, which leaves the trades this franchise made with that one,
 * and a PLAYER OR PICK, which leaves every move the asset was part of. Both
 * ride the address, so "every trade between these two" is a link.
 *
 * THE OTHER SIDE IS FOUND BY TIMESTAMP, NOT BY NAME. The log names a trade
 * partner in prose, as the franchise was called that season, and a franchise
 * renames itself most years. But every franchise logs its own side of a deal
 * at the same timestamp, so the franchises holding a trade row at this row's
 * `ts` ARE the other sides, whatever they were called then.
 */

type Kind = "all" | "trade" | "move";

const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All types" },
  { id: "trade", label: "Trades" },
  { id: "move", label: "Roster moves" },
];

const isKind = (v: string | null): v is Kind => KINDS.some(k => k.id === v);

/** A route segment as a non-negative integer, or null. Team.tsx's own helper,
 *  for the same reason it has one: a garbage segment is not "no segment". */
const intParam = (seg: string | undefined): number | null => {
  if (seg == null) return null;
  const n = Number(seg);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/** a log row with a key that is actually unique: Sleeper batch-processes
 *  waivers, so one franchise can hold several moves at one timestamp */
interface Row extends FranchiseTx { id: string }

export default function TeamTransactions() {
  const { league } = useLeague();
  const caps = useLeagueCaps();
  const betaPath = useBetaPath();
  const nav = useNavigate();
  const ridSeg = useParams().rid;
  const rid = intParam(ridSeg);
  const rosterSeason = rosterSeasonOf(league);
  const teamsQ = useJson<TeamT[]>(`${rosterSeason}/teams.json`);
  const frQ = useJson<Franchises>("franchises.json");
  const [params, setParams] = useSearchParams();

  const team = teamsQ.data?.find(t => t.roster_id === rid) ?? null;
  // the franchise KEY: the roster id in a dynasty league, the owner's Sleeper
  // user_id in a redraft one. The log is keyed by it, never by the slot.
  const fkey = team ? String(team.fkey ?? rid) : null;
  const franchise = fkey != null ? frQ.data?.[fkey] ?? null : null;

  const all = useMemo<Row[]>(() => (franchise?.tx ?? [])
    .map((t, i) => ({ ...t, id: String(i) }))
    .sort((a, b) => b.ts - a.ts), [franchise]);

  /** the seasons the strip offers: every one with a row in the log, newest first */
  const seasons = useMemo(
    () => [...new Set(all.map(t => t.season))].sort((a, b) => Number(b) - Number(a)),
    [all]);
  const seasonSeg = params.get("season");
  const season = seasonSeg && seasons.includes(seasonSeg) ? seasonSeg : "all";
  const kindSeg = params.get("kind");
  const kind: Kind = isKind(kindSeg) ? kindSeg : "all";
  const set = (k: "season" | "kind" | "asset", v: string) => {
    const next = new URLSearchParams(params);
    if (v === "all") next.delete(k); else next.set(k, v);
    // replace, so Back leaves the log rather than stepping through filters
    setParams(next, { replace: true });
  };

  /** trade timestamp -> the franchise keys that logged a side of it */
  const sidesAt = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const [key, f] of Object.entries(frQ.data ?? {})) {
      for (const t of f.tx) {
        if (t.type !== "trade") continue;
        const l = m.get(t.ts);
        if (l) l.push(key); else m.set(t.ts, [key]);
      }
    }
    return m;
  }, [frQ.data]);
  /** the franchises on the other side of a trade row; none for a roster move */
  const othersOf = (t: FranchiseTx) =>
    (t.type === "trade" ? sidesAt.get(t.ts) ?? [] : []).filter(k => k !== fkey);

  const withSeg = params.get("with");
  const withKey = withSeg && frQ.data?.[withSeg] && withSeg !== fkey ? withSeg : null;
  const asset = params.get("asset");
  const [sheet, setSheet] = useState<"team" | "asset" | null>(null);

  /** the season's rows, before the kind, team and asset filters: what the
   *  sheets count against, so a row's count is what picking it will show */
  const scoped = useMemo(
    () => all.filter(t => season === "all" || t.season === season), [all, season]);
  const rows = useMemo(() => scoped.filter(t =>
    (kind === "all" || (kind === "trade") === (t.type === "trade"))
    && (!withKey || othersOf(t).includes(withKey))
    && (!asset || assetsOf(t).includes(asset))),
  [scoped, kind, withKey, asset, sidesAt, fkey]);

  /** the franchises this one has traded with in the season on screen, most
   *  deals first, under the name each goes by today */
  const tradedWith = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of scoped) for (const k of othersOf(t)) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [scoped, sidesAt, fkey]);
  /** every player, pick and FAAB sum in the season's rows, most moved first */
  const assets = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of scoped) for (const a of new Set(assetsOf(t))) n.set(a, (n.get(a) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [scoped]);

  /** the rows by season, in the order they already hold (newest first) */
  const groups = useMemo(() => {
    const out: { season: string; rows: Row[] }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.season === r.season) last.rows.push(r);
      else out.push({ season: r.season, rows: [r] });
    }
    return out;
  }, [rows]);

  const head = (name: string) => (
    <div className="v3-head">
      <button type="button" className="rail-back ptx-back" onClick={() => nav(-1)}>← Back</button>
      <h1>{name}</h1>
      <span className="sub">transactions</span>
    </div>
  );

  if (rid == null) return <div className="empty">No franchise {ridSeg} in {rosterSeason}.</div>;
  if (teamsQ.error || frQ.error) return <DataError what="Transactions didn't load" />;
  if (!teamsQ.data || !frQ.data) return <div className="empty">Loading…</div>;
  if (!team) return <div className="empty">No franchise {rid} in {rosterSeason}.</div>;

  /** the name this franchise played under in a season, for a trade's own side */
  const nameIn = (s: string) => seasonRowOf(franchise, s)?.name.trim() || team.team.trim();
  const count = (n: number) => `${n} transaction${n === 1 ? "" : "s"}`;
  /** a franchise as it is called today, and who runs it */
  const nowOf = (key: string) => {
    const ss = frQ.data?.[key]?.seasons ?? [];
    const last = ss[ss.length - 1];
    return { name: last?.name.trim() || `Franchise ${key}`, manager: last?.manager ?? "" };
  };
  /** picking a team with the kind strip on Roster moves would show nothing by
   *  construction: a roster move has no other side */
  const pickWith = (key: string | null) => {
    const next = new URLSearchParams(params);
    if (key == null) next.delete("with"); else next.set("with", key);
    if (key != null && kind === "move") next.delete("kind");
    setParams(next, { replace: true });
    setSheet(null);
  };
  const pickAsset = (a: string | null) => { set("asset", a ?? "all"); setSheet(null); };

  return (
    <>
      {head(team.team.trim())}
      {seasons.length > 1 && (
        <LensStrip label="Season" value={season} onChange={v => set("season", v)}
          options={[{ id: "all", label: "All" }, ...seasons.map(s => ({ id: s, label: s }))]} />
      )}
      <LensStrip label="Kind" value={kind} onChange={v => set("kind", v)} options={KINDS} />
      {/* THE COUNT AND THE TWO FILTERS, the ledger's own band: what is on
          screen out of the season's rows, then who with and what moved. */}
      <Band
        label={rows.length === scoped.length ? count(scoped.length) : `${rows.length} of ${scoped.length}`}
        right={(
          <span className="trx-fils">
            <button type="button" className={`trx-fil${withKey ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setSheet("team")}>
              {withKey ? `With ${nowOf(withKey).name}` : "All teams"}<span className="caret">▾</span>
            </button>
            <button type="button" className={`trx-fil${asset ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setSheet("asset")}>
              {asset ?? "All players"}<span className="caret">▾</span>
            </button>
          </span>
        )} />
      {!groups.length && (
        <div className="lgx-quiet">
          {all.length
            ? "Nothing in the log matches these filters."
            : "No transactions on file for this franchise."}
        </div>
      )}
      {groups.map(g => (
        <div key={g.season}>
          <Band label={g.season} note={`${count(g.rows.length)} · newest first`} />
          <div className="v3-feed">
            {g.rows.map(t => (t.type === "trade"
              ? <TradeRow key={t.id} t={t} self={nameIn(t.season)}
                  to={caps.trades ? betaPath(`/transactions?load=${t.ts}`) : null} />
              : (
                <div className="v3-act" key={t.id}>
                  <div className="when">
                    <span>{tradeWhen(t.ts)}</span>
                    <span>{MOVE_LABEL(t.type)}</span>
                  </div>
                  <div className="v3-wv">
                    <span className="add"><span className="k">Add</span>{t.adds?.join(", ") || "—"}</span>
                    <span className="drop"><span className="k">Drop</span>{t.drops?.join(", ") || "—"}</span>
                  </div>
                </div>
              )))}
          </div>
        </div>
      ))}
      {sheet === "team" && (
        <Sheet label="Filter by trade partner" title="Traded with · pick one" onClose={() => setSheet(null)}>
          <SheetRow on={!withKey} mark={!withKey ? "On" : undefined} name="All teams"
            meta={count(scoped.length)} onClick={() => pickWith(null)} />
          {tradedWith.map(([key, n]) => {
            const w = nowOf(key);
            return (
              <SheetRow key={key} on={key === withKey} mark={key === withKey ? "On" : undefined}
                name={w.name} meta={`${n} trade${n === 1 ? "" : "s"}${w.manager ? ` · ${w.manager}` : ""}`}
                onClick={() => pickWith(key)} />
            );
          })}
          {!tradedWith.length && (
            <div className="trx-pempty">
              No trades with anyone{season === "all" ? "" : ` in ${season}`}.
            </div>
          )}
        </Sheet>
      )}
      {sheet === "asset" && (
        <AssetSheet assets={assets} on={asset} onPick={pickAsset} onClose={() => setSheet(null)} />
      )}
    </>
  );
}

/** everything a log row names: the players, picks and FAAB that moved in it */
const assetsOf = (t: FranchiseTx): string[] =>
  [...(t.adds ?? []), ...(t.drops ?? []), ...(t.got ?? []), ...(t.gave ?? [])];

/**
 * Pick ONE player or pick. The ledger's player sheet, over this franchise's
 * own log: a search, most-moved first, cut at 60 because a sheet re-rendering
 * several hundred rows per keystroke janks a phone. The log names assets in
 * prose, so the name is the key.
 */
function AssetSheet({ assets, on, onPick, onClose }: {
  assets: [string, number][]; on: string | null;
  onPick: (a: string | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const hits = needle ? assets.filter(([a]) => a.toLowerCase().includes(needle)) : assets;
  return (
    <Sheet label="Filter by player or pick" title="Player or pick · pick one" onClose={onClose}>
      <div className="trx-psearch">
        <input type="search" autoFocus value={q} placeholder="Player or pick"
          aria-label="Search this franchise's transactions for a player or pick"
          onChange={e => setQ(e.target.value)} />
      </div>
      <SheetRow on={on == null} mark={on == null ? "On" : undefined}
        name="All players" onClick={() => onPick(null)} />
      {hits.slice(0, 60).map(([a, n]) => (
        <SheetRow key={a} on={a === on} mark={a === on ? "On" : undefined}
          name={a} meta={`${n} transaction${n === 1 ? "" : "s"}`}
          onClick={() => onPick(a)} />
      ))}
      {!hits.length && <div className="trx-pempty">Nothing in the log matches “{q}”.</div>}
    </Sheet>
  );
}

/** One trade as this franchise's log states it: what it got, what it gave.
 *  A link to the deal's priced row on the ledger where the league has one. */
function TradeRow({ t, self, to }: { t: FranchiseTx; self: string; to: string | null }) {
  const others = (t.with ?? []).map(n => n.trim()).filter(Boolean).join(" & ") || "The other side";
  const basket = (who: string, items: string[] | undefined) => (
    <div className="bk">
      <div className="who">{who} gets</div>
      {items?.length
        ? items.map((label, j) => <div className="it" key={j}>{label}</div>)
        : <div className="it">—</div>}
    </div>
  );
  const body = (
    <>
      <div className="when">
        <span>{tradeWhen(t.ts)}</span>
        <span>Trade</span>
        {to && <span className="go">Details →</span>}
      </div>
      <div className="v3-baskets">
        {basket(self, t.got)}
        {basket(others, t.gave)}
      </div>
    </>
  );
  return to
    ? <a className="v3-act lgx-trade" href={`#${to}`}>{body}</a>
    : <div className="v3-act lgx-trade">{body}</div>;
}
