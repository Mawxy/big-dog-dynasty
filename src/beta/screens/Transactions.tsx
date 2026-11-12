import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Franchises, FranchiseTx, Team, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeagueCaps } from "../../lib/caps";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { seasonRowOf } from "../../lib/seasons";
import { readTrades, tradeWhen } from "../../lib/trades";
import { tradeId } from "../../lib/tradeLineage";
import { MOVE_LABEL } from "../model";
import { Band, DataError, LensStrip, Sheet, SheetRow, useBetaPath } from "../ui";
import { GRID_NOTE, snapKey, TradeCard, useGridCtx, usePlayed, useWho } from "./tradeGrid";
// the roster-move rows (`.v3-feed`, `.v3-act`, `.lgx-who`)
import "./league.css";
// the filter buttons and the sheet search (`.trx-fil`, `.trx-psearch`)
import "./trade.css";
import "./transactions.css";

/**
 * TRANSACTIONS (Max, 2026-11-12) — everything the league has done to its
 * rosters, on a page of its own.
 *
 * The ledger used to be the Trade tab's second scope. It is not a tense of
 * the calculator: the calculator prices a hypothetical, this records what
 * happened, and nobody moves between the two mid-task. So the Trade tab keeps
 * the calculator, and the record lives here, reached from More, from the
 * Last 7 days module and from a franchise's own transaction log.
 *
 * TWO KINDS, NOT ONE FEED. The league has made about 160 trades and about
 * 1,700 waiver and free-agent moves; one stream would bury the trades. Trades
 * is the default, and the page's reason to exist.
 *
 * A TRADE IS A CLOSED CARD (`TradeCard`): what moved and who got it. The
 * figures open on a tap, per card. Newest first, under a band per NFL week.
 *
 * EVERY FILTER RIDES THE ADDRESS, so a filtered page is a link: `season`
 * (comma-joined), `team` (roster ids, comma-joined), `match=all` (only deals
 * BETWEEN the ticked teams), `player` (a pid, trades) and `asset` (a name,
 * roster moves, which the log states in prose). `load=<ts>` opens one trade.
 */

type Kind = "trades" | "moves";
const KINDS: { id: Kind; label: string }[] = [
  { id: "trades", label: "Trades" },
  { id: "moves", label: "Roster moves" },
];

/** how many roster moves go on screen at a time: the log runs to four figures */
const PAGE = 80;

/**
 * WHEN WEEK 1 OPENS: the Tuesday after Labor Day (the first Monday of
 * September), two days before the NFL's opening Thursday.
 *
 * Sleeper stamps every offseason move "week 1", so the week on a row cannot
 * tell a March trade from one made on opening weekend. The date can: anything
 * dated before this in its season is the offseason, whatever week it carries.
 */
const weekOneOpens = (season: number) => {
  const dow = new Date(season, 8, 1).getDay();
  const laborDay = 1 + ((8 - dow) % 7);
  return new Date(season, 8, laborDay + 1).getTime();
};

/**
 * Rows in the order they already hold (newest first), cut into runs of ONE NFL
 * WEEK (Max, 2026-11-12; the first cut was by calendar month). A week is the
 * unit the league thinks in: "the week 8 trades". The offseason is one band
 * per season, because it has no weeks.
 */
function byWeek<T extends { ts: number; season: string; week: number }>(rows: T[]):
  { key: string; label: string; rows: T[] }[] {
  const out: { key: string; label: string; rows: T[] }[] = [];
  for (const r of rows) {
    const off = r.ts < weekOneOpens(Number(r.season));
    const key = `${r.season}:${off ? "off" : r.week}`;
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else out.push({ key, label: `${r.season} · ${off ? "Offseason" : `Week ${r.week}`}`, rows: [r] });
  }
  return out;
}

/* ========================================================================
   THE FILTERS BOTH KINDS SHARE — season and team, in the address
   ======================================================================== */

type SetParams = (changes: Record<string, string | null>) => void;

function useFilters() {
  const [params, setParams] = useSearchParams();
  /** REPLACE, so Back leaves the page rather than stepping through filters */
  const set: SetParams = useCallback(changes => setParams(p => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") n.delete(k); else n.set(k, v);
    }
    return n;
  }, { replace: true }), [setParams]);
  const seasonRaw = params.get("season") ?? "";
  const teamRaw = params.get("team") ?? "";
  /** the seasons in force — empty is every season ("all" is the old ledger's
   *  word for that, and still arrives on old links) */
  const seasonsOn = useMemo(
    () => new Set(seasonRaw.split(",").filter(s => /^\d{4}$/.test(s))), [seasonRaw]);
  /** the franchises in force, by roster id — empty is every team */
  const teamsOn = useMemo(() => new Set(
    teamRaw.split(",").map(Number).filter(n => Number.isInteger(n) && n > 0)), [teamRaw]);
  const match: "any" | "all" = params.get("match") === "all" ? "all" : "any";
  return { params, set, seasonsOn, teamsOn, match };
}
type Filters = ReturnType<typeof useFilters>;

/* THE RESTING LABELS ARE ONE WORD EACH — "Seasons", "Teams", "Players" — so
   the three filters hold one line on a phone. A filter that is on says what
   it is on instead. */
const seasonWords = (on: Set<string>) => on.size === 0 ? "Seasons"
  : on.size <= 3 ? [...on].sort().reverse().join(" · ") : `${on.size} seasons`;

/** MULTI-SELECT: rows toggle and the sheet stays open; "All seasons" clears
 *  the set and closes, because there is nothing left to pick after it. */
function SeasonSheet({ f, seasons, count, total, noun, onClose }: {
  f: Filters; seasons: string[]; count: (season: string) => number;
  total: number; noun: string; onClose: () => void;
}) {
  const all = f.seasonsOn.size === 0;
  const toggle = (id: string) => {
    const next = new Set(f.seasonsOn);
    if (next.has(id)) next.delete(id); else next.add(id);
    // the list's order (newest first), not tap order
    f.set({ season: seasons.filter(s => next.has(s)).join(",") });
  };
  return (
    <Sheet label="Filter by season" title="Seasons · pick any" onClose={onClose}>
      <SheetRow on={all} mark={all ? "On" : undefined} name="All seasons"
        meta={`${total} ${noun}${total === 1 ? "" : "s"} on record`}
        onClick={() => { f.set({ season: null }); onClose(); }} />
      {seasons.map(id => {
        const on = f.seasonsOn.has(id), n = count(id);
        return (
          <SheetRow key={id} on={on} mark={on ? "On" : undefined} name={id}
            meta={`${n} ${noun}${n === 1 ? "" : "s"}`} onClick={() => toggle(id)} />
        );
      })}
    </Sheet>
  );
}

/** MULTI-SELECT, the same grammar. `between` adds the two rows that decide how
 *  the ticked set matches, which only a trade (a thing with two sides) has. */
function TeamSheet({ f, teams, count, total, noun, between, onClose }: {
  f: Filters; teams: Team[]; count: (rid: number) => number;
  total: number; noun: string; between?: boolean; onClose: () => void;
}) {
  const all = f.teamsOn.size === 0;
  const toggle = (rid: number) => {
    const next = new Set(f.teamsOn);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    f.set({ team: [...next].sort((a, b) => a - b).join(",") });
  };
  return (
    <Sheet label="Filter by franchise" title="Franchises · pick any" onClose={onClose}>
      <SheetRow on={all} mark={all ? "On" : undefined} name="All teams"
        meta={`${total} ${noun}${total === 1 ? "" : "s"}`}
        onClick={() => { f.set({ team: null, match: null }); onClose(); }} />
      {between && (
        <>
          <SheetRow on={f.match === "any"} mark={f.match === "any" ? "On" : undefined}
            name="Any ticked team" meta="A trade any of them was in"
            onClick={() => f.set({ match: null })} />
          <SheetRow on={f.match === "all"} mark={f.match === "all" ? "On" : undefined}
            name="Between ticked teams only" meta="Tick two: the deals between those two"
            onClick={() => f.set({ match: "all" })} />
        </>
      )}
      {teams.slice().sort((a, b) => a.team.localeCompare(b.team)).map(t => {
        const n = count(t.roster_id), on = f.teamsOn.has(t.roster_id);
        return (
          <SheetRow key={t.roster_id} on={on} mark={on ? "On" : undefined}
            name={t.team} meta={`${n} ${noun}${n === 1 ? "" : "s"} · ${t.manager}`}
            onClick={() => toggle(t.roster_id)} />
        );
      })}
    </Sheet>
  );
}

/** Pick ONE of a searchable list, most-moved first, cut at 60: a sheet
 *  re-rendering several hundred rows per keystroke janks a phone. */
function PickSheet({ title, placeholder, allLabel, items, on, noun, onPick, onClose }: {
  title: string; placeholder: string; allLabel: string;
  items: { id: string; name: string; n: number }[];
  on: string | null; noun: string;
  onPick: (id: string | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const hits = needle ? items.filter(p => p.name.toLowerCase().includes(needle)) : items;
  return (
    <Sheet label={title} title={`${title} · pick one`} onClose={onClose}>
      <div className="trx-psearch">
        <input type="search" autoFocus value={q} placeholder={placeholder}
          aria-label={`Search: ${placeholder}`} onChange={e => setQ(e.target.value)} />
      </div>
      <SheetRow on={on == null} mark={on == null ? "On" : undefined}
        name={allLabel} onClick={() => onPick(null)} />
      {hits.slice(0, 60).map(p => (
        <SheetRow key={p.id} on={p.id === on} mark={p.id === on ? "On" : undefined}
          name={p.name} meta={`${p.n} ${noun}${p.n === 1 ? "" : "s"}`}
          onClick={() => onPick(p.id)} />
      ))}
      {!hits.length && <div className="trx-pempty">Nothing matches “{q}”.</div>}
    </Sheet>
  );
}

/* ========================================================================
   THE SCREEN
   ======================================================================== */

export default function Transactions() {
  const { league } = useLeague();
  const caps = useLeagueCaps();
  const f = useFilters();
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  /* A LEAGUE THE PIPELINE NEVER SCORES has no trades.json, so it has no
     Trades view to offer: the page is its roster moves, and a trade there is
     stated on each franchise's own log. */
  const kind: Kind = !caps.trades || f.params.get("kind") === "moves" ? "moves" : "trades";
  return (
    <>
      <div className="v3-head">
        <h1>Transactions</h1>
        <span className="sub">
          {kind === "trades" ? "every trade, newest first" : "waivers, free agents and commissioner moves"}
        </span>
      </div>
      {caps.trades && (
        <LensStrip label="Kind" value={kind} options={KINDS}
          // a player and an asset name are different keys: neither survives the switch
          onChange={v => f.set({ kind: v === "moves" ? "moves" : null, player: null, asset: null })} />
      )}
      {kind === "trades" ? <Trades f={f} teams={teams} /> : <Moves f={f} teams={teams} />}
    </>
  );
}

/* ========================================================================
   TRADES
   ======================================================================== */

function Trades({ f, teams }: { f: Filters; teams: Team[] | null }) {
  const betaPath = useBetaPath();
  const file = useJson<TradesPayload>("trades.json");
  const all = useMemo(() => (file.data
    ? readTrades(file.data).trades.filter(t => t.sides.length >= 2).sort((a, b) => b.ts - a.ts)
    : null), [file.data]);
  /* built ONCE for the feed, never per card: the pick ladder, the market feed
     and the at-trade read (see `useGridCtx`) */
  const ctx = useGridCtx();
  const who = useWho();
  const played = usePlayed();
  const [sheet, setSheet] = useState<"season" | "team" | "player" | null>(null);
  /** the cards whose figures are showing: any number at once */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /** the card a `?load=` link named: opened, marked and scrolled to */
  const [marked, setMarked] = useState<string | null>(null);

  const wantTs = f.params.get("load");
  useEffect(() => {
    if (!wantTs || !all) return;
    const t = all.find(x => String(x.ts) === wantTs);
    if (t) {
      const k = snapKey(t);
      setMarked(k);
      setOpen(prev => new Set(prev).add(k));
    }
    // the named trade has to be on screen: the link's own filters step aside
    f.set(t ? { load: null, season: null, team: null, match: null, player: null } : { load: null });
  }, [wantTs, all, f.set]);
  const scrollTo = useCallback((el: HTMLElement | null) => {
    el?.scrollIntoView({ block: "center" });
  }, []);

  const playerOn = f.params.get("player");
  const seasons = useMemo(
    () => [...new Set((all ?? []).map(t => t.season))].sort().reverse(), [all]);
  const inSeason = useMemo(
    () => (all ?? []).filter(t => f.seasonsOn.size === 0 || f.seasonsOn.has(t.season)),
    [all, f.seasonsOn]);
  const both = f.match === "all" && f.teamsOn.size >= 2;
  const shown = useMemo(() => inSeason.filter(t =>
    (f.teamsOn.size === 0 || (both
      ? [...f.teamsOn].every(r => t.sides.some(s => s.rid === r))
      : t.sides.some(s => f.teamsOn.has(s.rid))))
    && (!playerOn || t.sides.some(s => s.got.some(a => a.pid === playerOn)))),
  [inSeason, f.teamsOn, both, playerOn]);
  /** every player who has moved in a deal — as himself or as the pick he
   *  became — off the WHOLE record, so a filtered-in name always resolves */
  const traded = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const t of all ?? []) {
      const seen = new Set<string>();
      for (const s of t.sides) for (const a of s.got) {
        if (!a.pid || seen.has(a.pid)) continue;
        seen.add(a.pid);
        const name = a.kind === "player" ? a.label : (a.label.split(" → ")[1] ?? a.label);
        const e = m.get(a.pid);
        if (e) e.n++; else m.set(a.pid, { id: a.pid, name, n: 1 });
      }
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [all]);
  const groups = useMemo(() => byWeek(shown), [shown]);

  if (file.error) return <DataError what="Trades didn't load" />;
  if (!all) return <div className="empty">Loading trades…</div>;

  const nameOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  const ownerOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.manager ?? nameOf(rid);
  const allTeams = f.teamsOn.size === 0;
  const teamWords = allTeams ? "Teams"
    // "between" names the two MANAGERS: two franchise names and a "vs" do not
    // fit a filter button on a phone
    : both && f.teamsOn.size === 2 ? [...f.teamsOn].map(ownerOf).join(" vs ")
      : f.teamsOn.size <= 2 ? [...f.teamsOn].map(nameOf).join(" · ")
        : `${f.teamsOn.size} teams${both ? " · all" : ""}`;
  const playerName = playerOn ? traded.find(p => p.id === playerOn)?.name ?? "Player" : null;
  const filtered = !allTeams || playerOn != null;
  const toggle = (k: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="txc-wrap">
      <Band
        label={!filtered
          ? `${inSeason.length} trade${inSeason.length === 1 ? "" : "s"}`
          : `${shown.length} of ${inSeason.length}`}
        right={(
          <span className="trx-fils">
            <button type="button" className={`trx-fil${f.seasonsOn.size ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setSheet("season")}>
              {seasonWords(f.seasonsOn)}<span className="caret">▾</span>
            </button>
            <button type="button" className={`trx-fil${allTeams ? "" : " on"}`}
              aria-haspopup="dialog" onClick={() => setSheet("team")}>
              {teamWords}<span className="caret">▾</span>
            </button>
            <button type="button" className={`trx-fil${playerOn ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setSheet("player")}>
              {playerName ?? "Players"}<span className="caret">▾</span>
            </button>
          </span>
        )} />
      <div className="txc-feed">
        {groups.map(g => (
          <div className="txc-group" key={g.key}>
            <div className="txc-month">
              {g.label}<span className="n">{g.rows.length} trade{g.rows.length === 1 ? "" : "s"}</span>
            </div>
            {g.rows.map(t => {
              const k = snapKey(t);
              return (
                <TradeCard key={k} t={t} ctx={ctx} who={who} owner={ownerOf} played={played(t)}
                  open={open.has(k)} onToggle={() => toggle(k)} marked={marked === k}
                  cardRef={marked === k ? scrollTo : undefined}
                  to={betaPath(`/trade/${tradeId(t)}`)} />
              );
            })}
          </div>
        ))}
        {!shown.length && (
          <div className="empty">
            {filtered ? "No trades match these filters."
              : f.seasonsOn.size ? "No trades in those seasons." : "No trades on record."}
          </div>
        )}
      </div>
      <div className="tnote screen">
        Tap a trade for its figures. {GRID_NOTE}
      </div>

      {sheet === "season" && (
        <SeasonSheet f={f} seasons={seasons} noun="trade" total={all.length}
          count={id => all.filter(t => t.season === id).length} onClose={() => setSheet(null)} />
      )}
      {sheet === "team" && teams && (
        <TeamSheet f={f} teams={teams} noun="trade" between total={inSeason.length}
          count={rid => inSeason.filter(t => t.sides.some(s => s.rid === rid)).length}
          onClose={() => setSheet(null)} />
      )}
      {sheet === "player" && (
        <PickSheet title="Player" placeholder="Player" allLabel="All players" noun="trade"
          items={traded} on={playerOn}
          onPick={pid => { f.set({ player: pid }); setSheet(null); }}
          onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/* ========================================================================
   ROSTER MOVES — waivers, free agents, commissioner edits
   ======================================================================== */

/** a log row with the franchise it belongs to and a key that is actually
 *  unique: Sleeper batch-processes waivers, so one franchise can hold several
 *  moves at one timestamp */
interface Move extends FranchiseTx { id: string; fkey: string }

function Moves({ f, teams }: { f: Filters; teams: Team[] | null }) {
  const frQ = useJson<Franchises>("franchises.json");
  const [sheet, setSheet] = useState<"season" | "team" | "asset" | null>(null);
  const asset = f.params.get("asset");

  /** every franchise's own side of the log, less its trades (those are the
   *  other view, priced), newest first */
  const all = useMemo<Move[] | null>(() => {
    if (!frQ.data) return null;
    const out: Move[] = [];
    for (const [fkey, fr] of Object.entries(frQ.data))
      fr.tx.forEach((t, i) => { if (t.type !== "trade") out.push({ ...t, fkey, id: `${fkey}:${i}` }); });
    return out.sort((a, b) => b.ts - a.ts);
  }, [frQ.data]);

  /** the franchise KEY behind a roster id: the id itself in a dynasty league,
   *  the owner's user id in a redraft one. The log is keyed by it. */
  const keyOf = useCallback(
    (rid: number) => String(teams?.find(t => t.roster_id === rid)?.fkey ?? rid), [teams]);
  const keysOn = useMemo(() => new Set([...f.teamsOn].map(keyOf)), [f.teamsOn, keyOf]);

  const seasons = useMemo(
    () => [...new Set((all ?? []).map(t => t.season))].sort().reverse(), [all]);
  const inSeason = useMemo(
    () => (all ?? []).filter(t => f.seasonsOn.size === 0 || f.seasonsOn.has(t.season)),
    [all, f.seasonsOn]);
  const namesOf = (t: FranchiseTx) => [...(t.adds ?? []), ...(t.drops ?? [])];
  const shown = useMemo(() => inSeason.filter(t =>
    (keysOn.size === 0 || keysOn.has(t.fkey))
    && (!asset || namesOf(t).includes(asset))),
  [inSeason, keysOn, asset]);
  /** everyone added or dropped in the seasons on screen, most moved first */
  const assets = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of inSeason) for (const a of new Set(namesOf(t))) n.set(a, (n.get(a) ?? 0) + 1);
    return [...n.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, c]) => ({ id: name, name, n: c }));
  }, [inSeason]);

  /* A PAGE AT A TIME. The log runs to four figures and a phone does not need
     1,700 rows in the document to show the newest eighty. Any change to what
     is filtered starts again from the top. */
  const filterKey = `${[...f.seasonsOn].join()}|${[...f.teamsOn].join()}|${asset ?? ""}`;
  const [page, setPage] = useState({ key: filterKey, n: PAGE });
  const limit = page.key === filterKey ? page.n : PAGE;
  const groups = useMemo(() => byWeek(shown.slice(0, limit)), [shown, limit]);

  if (frQ.error) return <DataError what="Transactions didn't load" />;
  if (!all) return <div className="empty">Loading roster moves…</div>;

  const allTeams = f.teamsOn.size === 0;
  const nameOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  const teamWords = allTeams ? "Teams"
    : f.teamsOn.size <= 2 ? [...f.teamsOn].map(nameOf).join(" · ") : `${f.teamsOn.size} teams`;
  const filtered = !allTeams || asset != null;
  /** the franchise as it was called in the season of the move */
  const teamIn = (t: Move) => {
    const fr = frQ.data?.[t.fkey];
    const ss = fr?.seasons ?? [];
    return (seasonRowOf(fr, t.season)?.name ?? ss[ss.length - 1]?.name ?? `Franchise ${t.fkey}`).trim();
  };
  const noun = (n: number) => `${n.toLocaleString()} move${n === 1 ? "" : "s"}`;

  return (
    <div className="txc-wrap">
      <Band
        label={!filtered ? noun(inSeason.length)
          : `${shown.length.toLocaleString()} of ${inSeason.length.toLocaleString()}`}
        right={(
          <span className="trx-fils">
            <button type="button" className={`trx-fil${f.seasonsOn.size ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setSheet("season")}>
              {seasonWords(f.seasonsOn)}<span className="caret">▾</span>
            </button>
            <button type="button" className={`trx-fil${allTeams ? "" : " on"}`}
              aria-haspopup="dialog" onClick={() => setSheet("team")}>
              {teamWords}<span className="caret">▾</span>
            </button>
            <button type="button" className={`trx-fil${asset ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setSheet("asset")}>
              {asset ?? "Players"}<span className="caret">▾</span>
            </button>
          </span>
        )} />
      {groups.map(g => (
        <div className="txm-group" key={g.key}>
          <div className="txc-month">{g.label}</div>
          <div className="v3-feed">
            {g.rows.map(t => (
              <div className="v3-act" key={t.id}>
                <div className="when">
                  <span>{tradeWhen(t.ts)}</span>
                  <span>{MOVE_LABEL(t.type)}</span>
                </div>
                <div className="v3-wv">
                  <span className="add"><span className="k">Add</span>{t.adds?.join(", ") || "—"}</span>
                  <span className="drop"><span className="k">Drop</span>{t.drops?.join(", ") || "—"}</span>
                </div>
                <div className="idc-s lgx-who">{teamIn(t)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!shown.length && (
        <div className="empty">
          {filtered || f.seasonsOn.size ? "No roster moves match these filters." : "No roster moves on record."}
        </div>
      )}
      {shown.length > limit && (
        <div className="txm-more">
          <button type="button" className="trx-fil"
            onClick={() => setPage({ key: filterKey, n: limit + PAGE })}>
            Show {Math.min(PAGE, shown.length - limit)} more
          </button>
          <span className="n">{limit.toLocaleString()} of {shown.length.toLocaleString()} shown</span>
        </div>
      )}

      {sheet === "season" && (
        <SeasonSheet f={f} seasons={seasons} noun="move" total={all.length}
          count={id => all.filter(t => t.season === id).length} onClose={() => setSheet(null)} />
      )}
      {sheet === "team" && teams && (
        <TeamSheet f={f} teams={teams} noun="move" total={inSeason.length}
          count={rid => { const k = keyOf(rid); return inSeason.filter(t => t.fkey === k).length; }}
          onClose={() => setSheet(null)} />
      )}
      {sheet === "asset" && (
        <PickSheet title="Player" placeholder="Player" allLabel="All players" noun="move"
          items={assets} on={asset}
          onPick={a => { f.set({ asset: a }); setSheet(null); }}
          onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
