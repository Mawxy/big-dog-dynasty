import { Fragment, useMemo, useState } from "react";
import type { Franchises, Team, Trade as TradeT, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useIdentity } from "../../lib/identity";
import { rosterSeasonOf } from "../../lib/league";
import { readTrades } from "../../lib/trades";
import { RouteLink } from "../../components/RouteLink";
import {
  Band, DataError, fmtWar, NUL, sgnWar, sortBy, TapRow, Th, useBetaPath, useSort,
} from "../ui";
import { sideRealized, usePlayed } from "./tradeGrid";
import "./transactions.css";

/**
 * THE PARTNER ANALYZER (Max, 2026-11-12) — the Trade tab's second pill: each
 * manager's record as a trader, and who they trade with.
 *
 * One row per manager: how many trades they have made, the WAR their side of
 * those trades has returned (in), the WAR the other side's has (out), and the
 * difference. Tapping a row opens that manager's partners under it, each one
 * a link to the deals between the two on the Transactions page.
 *
 * A TRADE BELONGS TO THE MANAGER WHO MADE IT, NOT TO THE ROSTER SLOT (Max,
 * 2026-11-12). A franchise that changed hands carries its old owner's deals
 * in trades.json under the same roster id, and summing by slot credited
 * PicklesPapa's trades to Dchaillier10. So every side is keyed by the manager
 * `franchises.json` names for that slot IN THE SEASON OF THE TRADE. A manager
 * who has left the league keeps a row of his own, marked, because his partners'
 * rows still name him. Rows carry the manager's name only: the franchise name
 * changes most years and says nothing here the manager does not.
 *
 * WHAT THE WAR COLUMNS COVER, and the caption says so: two-team trades where a
 * scored week has passed and BOTH sides hold something with a return to judge
 * (a side of unmade picks has none yet). A three-team deal has no single
 * "other side", so it counts as a trade and stays out of the WAR. These are
 * the ledger's own rules (`sideRealized`, `usePlayed`), not a second opinion.
 *
 * NOTHING IS INKED. A signed net is direction, not a grade: the same realized
 * WAR is one manager's in and another's out, and a draft pick that has not
 * been made is not in either yet.
 */

/**
 * ONE PERSON UNDER TWO HANDLES (Max, 2026-11-12). Sleeper keys a manager by
 * display name here, and a renamed account reads as a franchise changing
 * hands. Craftzz and taird are the same person, so Craftzz's trades are
 * taird's. Old handle -> the one he goes by now; add a line for the next one.
 */
const SAME_PERSON: Record<string, string> = { Craftzz: "taird" };
const person = (manager: string) => SAME_PERSON[manager] ?? manager;

interface Pair { n: number; judged: number; net: number }
interface Stat {
  /** the manager, as franchises.json spells him */
  name: string;
  /** the roster slot his trades were made from */
  rid: number;
  n: number; judged: number; in: number; out: number;
  partners: Map<string, Pair>;
}
type Key = "n" | "in" | "out" | "net";

function build(
  trades: TradeT[], played: (t: TradeT) => boolean,
  mgrOf: (rid: number, season: string) => string,
): Map<string, Stat> {
  const m = new Map<string, Stat>();
  const stat = (name: string, rid: number) => {
    let s = m.get(name);
    if (!s) { s = { name, rid, n: 0, judged: 0, in: 0, out: 0, partners: new Map() }; m.set(name, s); }
    return s;
  };
  const pair = (s: Stat, other: string) => {
    let p = s.partners.get(other);
    if (!p) { p = { n: 0, judged: 0, net: 0 }; s.partners.set(other, p); }
    return p;
  };
  for (const t of trades) {
    if (t.sides.length < 2) continue;
    const who = t.sides.map(s => stat(mgrOf(s.rid, t.season), s.rid));
    who.forEach((s, i) => {
      s.n++;
      who.forEach((o, j) => { if (j !== i) pair(s, o.name).n++; });
    });
    if (t.sides.length !== 2 || !played(t)) continue;
    const ra = sideRealized(t.sides[0]), rb = sideRealized(t.sides[1]);
    if (ra == null || rb == null) continue;
    const [sa, sb] = who;
    sa.judged++; sa.in += ra; sa.out += rb;
    sb.judged++; sb.in += rb; sb.out += ra;
    const pa = pair(sa, sb.name), pb = pair(sb, sa.name);
    pa.judged++; pa.net += ra - rb;
    pb.judged++; pb.net += rb - ra;
  }
  return m;
}

export default function Partners() {
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const identity = useIdentity();
  const file = useJson<TradesPayload>("trades.json");
  const frQ = useJson<Franchises>("franchises.json");
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const played = usePlayed();
  const trades = useMemo(() => (file.data ? readTrades(file.data).trades : null), [file.data]);
  const fr = frQ.data;

  /** who ran a roster slot in a season: that season's row for the slot, else
   *  the slot's latest, else the franchise name the trade itself carries */
  const stats = useMemo(() => {
    if (!trades || !fr) return null;
    const mgrOf = (rid: number, season: string) => {
      const ss = fr[String(rid)]?.seasons ?? [];
      return person((ss.find(s => s.season === season) ?? ss[ss.length - 1])?.manager ?? `Team ${rid}`);
    };
    return build(trades, played, mgrOf);
  }, [trades, fr, played]);
  /** the seasons a manager held his slot, for the links out: a slot's trades
   *  filtered to those seasons are his and nobody else's */
  const seasonsOf = (s: Stat) =>
    (fr?.[String(s.rid)]?.seasons ?? []).filter(x => person(x.manager) === s.name).map(x => x.season);
  const allSeasons = useMemo(
    () => [...new Set((trades ?? []).map(t => t.season))], [trades]);

  const s = useSort<Key>("n");
  /** the manager whose partners are showing. Undefined until the reader
   *  picks: the page opens on the reader's own row where it knows one. */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const mineRaw = teams?.find(t => t.roster_id === identity.rid)?.manager;
  const mine = mineRaw ? person(mineRaw) : null;
  const openName = picked === undefined ? mine : picked;

  const rows = useMemo(() => {
    if (!stats || !teams) return null;
    const current = new Set(teams.map(t => person(t.manager)));
    // every manager in the league today, traded or not, then anyone who has left
    const names = [...new Set([...current, ...stats.keys()])];
    const list = names.map(name => {
      const st = stats.get(name);
      const judged = st?.judged ?? 0;
      return {
        name, st, former: !current.has(name),
        f: {
          n: st?.n ?? 0,
          // no judged trade is no figure, not zero WAR
          in: judged ? st!.in : null,
          out: judged ? st!.out : null,
          net: judged ? st!.in - st!.out : null,
        } as Record<Key, number | null>,
      };
    });
    return sortBy(list, r => r.f[s.sort], s.dir);
  }, [stats, teams, s.sort, s.dir]);

  if (file.error || frQ.error) return <DataError what="Trades didn't load" />;
  if (!rows || !stats) return <div className="empty">Loading trades…</div>;

  const total = (trades ?? []).filter(t => t.sides.length >= 2).length;
  /** the Transactions page, on the trades these managers made: their slots,
   *  and the seasons each held his (left off when that is every season) */
  const toTrades = (a: Stat, b?: Stat) => {
    let seasons = seasonsOf(a);
    if (b) { const sb = new Set(seasonsOf(b)); seasons = seasons.filter(x => sb.has(x)); }
    const q = new URLSearchParams();
    q.set("team", (b ? [a.rid, b.rid].sort((x, y) => x - y) : [a.rid]).join(","));
    if (b) q.set("match", "all");
    if (allSeasons.some(x => !seasons.includes(x))) q.set("season", seasons.sort().reverse().join(","));
    return betaPath(`/transactions?${q.toString()}`);
  };

  return (
    <div className="pax">
      <Band label={`${total} trade${total === 1 ? "" : "s"} · ${rows.length} managers`}
        note="All seasons · tap a manager for their partners" />
      <table className="v3tbl pax-tbl">
        <thead>
          <tr>
            {/* the name column is what the figures leave it */}
            <th className="t">Manager</th>
            <Th id="n" label="Trades" sort={s.sort} onSort={s.onSort} width="12%" />
            <Th id="in" label="WAR in" sort={s.sort} onSort={s.onSort} width="15%" />
            <Th id="out" label="WAR out" sort={s.sort} onSort={s.onSort} width="16%" />
            <Th id="net" label="Net" sort={s.sort} onSort={s.onSort} width="18%" />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isOpen = openName === r.name;
            const partners = [...(r.st?.partners ?? [])]
              .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
            return (
              <Fragment key={r.name}>
                <TapRow className={isOpen ? "pax-on" : ""} onTap={() => setPicked(isOpen ? null : r.name)}>
                  <td className="t pax-nm">
                    {r.name}
                    {/* under the name, not beside it (Max, 2026-11-12) */}
                    {r.former && <span className="sb">former</span>}
                  </td>
                  <td className="n">{r.f.n}</td>
                  <td className="n">{r.f.in == null ? NUL : fmtWar(r.f.in)}</td>
                  <td className="n">{r.f.out == null ? NUL : fmtWar(r.f.out)}</td>
                  <td className="n">{r.f.net == null ? NUL : sgnWar(r.f.net)}</td>
                </TapRow>
                {isOpen && (
                  <tr className="pax-drawer">
                    <td colSpan={5}>
                      {r.st && partners.length ? (
                        <>
                          <div className="pax-ph">
                            <span>Traded with</span>
                            <span className="n">Trades</span>
                            <span className="n">Net WAR</span>
                          </div>
                          {partners.map(([other, p]) => {
                            const o = stats.get(other);
                            return (
                              <RouteLink key={other} className="pax-p"
                                to={o ? toTrades(r.st!, o) : toTrades(r.st!)}>
                                <span className="nm">{other}</span>
                                <span className="n">{p.n}</span>
                                <span className="n">{p.judged ? sgnWar(p.net) : NUL}</span>
                              </RouteLink>
                            );
                          })}
                          <RouteLink className="lgx-all pax-all" to={toTrades(r.st)}>
                            All of {r.name}’s trades →
                          </RouteLink>
                        </>
                      ) : <div className="pax-none">No trades on record.</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="tnote screen">
        A trade counts for the manager who made it, so a franchise that changed hands is two
        rows (a manager who only changed handles is one). WAR in is what a manager’s side of their trades has produced while starting for
        them. WAR out is what the other side’s has. Both cover two-team trades where a scored
        week has passed and each side holds something with a return to judge, so a side of
        unmade picks is not in either yet, and a three-team deal counts as a trade only. A
        record, not a verdict: no figure is inked.
      </div>
    </div>
  );
}
