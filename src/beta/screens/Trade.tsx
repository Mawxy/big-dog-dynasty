import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  PickValues, PicksOwned, Team, Trade as TradeT, TradeAsset, TradeSide,
  TradesPayload, Values,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { fmt, sgn } from "../../lib/stats";
import { latestSeasonOf, POS_COLOR, rosterSeasonOf } from "../../lib/league";
import { ROUND_ORD } from "../../lib/rosterModel";
import { readTrades } from "../../lib/trades";
import { useMobile } from "../../lib/useWidth";
import {
  makePickIndexer, tradeLedger,
  type PickIndexer, type PricedAsset, type SideLedger, type ValueBridge,
} from "../../lib/tradeModel";
import { tierOf, useAssets, usePickTiers, type Asset } from "../model";
import ScopeControl, { ALL_SEASONS, seasonSet, useScope, type ScopeSeason } from "../Scope";
import {
  Band, DataError, fmtWar, IdLines, Ledger, LedgerRow, LEDGER_GUARDRAIL, NUL,
  PosSpine, sgnWar, Sheet, SheetRow, useBetaPath,
} from "../ui";
import "./trade.css";

/**
 * TRADE — one screen, two tenses.
 *
 * BUILD is the machine: two franchises, several competing packages, priced in
 * every currency the board keeps. HISTORY is the league ledger — the whole
 * absorbed contents of `views/Ledger.tsx`, which is why `${base}/ledger` now
 * redirects here with `?scope=history`. A settled deal and a hypothetical one
 * are the same object in two tenses, so they are one screen on one axis rather
 * than two destinations a reader has to know the difference between.
 *
 * TEAM-AGNOSTIC BY DEFAULT (decision #13, restored by Max 2026-09-02). The
 * panels open as "Side A gets / Side B gets" and draw from the whole priced
 * field plus generic picks — the machine is a scale for a package, not a
 * negotiation between two rosters. Naming a franchise on a side is an
 * OPTIONAL narrowing: it limits the other side to what that franchise really
 * holds, which is how to check a package is one two teams could make. Either
 * way, NEITHER SIDE IS "YOU": there is no "my team" panel, no posture to tilt
 * by, and the two panels are typographically identical.
 *
 * BOTH SIDES STAY NEUTRAL, IN BOTH TENSES (SKILL §5). No figure on this screen
 * is inked by who is ahead. Colouring one basket green and the other amber
 * implies a winner when the colour is really just whose column it is, and the
 * sign already carries the direction.
 *
 * DELTAS ARE DERIVED, NEVER AUTHORED. Every difference here is computed from
 * two totals at render time. Nothing is stored per asset and nothing is stored
 * per offer, because a stored delta drifts the instant an asset moves and there
 * is no way to notice that it has.
 *
 * THE MATHS IS IN `lib/tradeModel`. The consolidation curve, the pick index
 * estimate and the arithmetic that ties the ledger together live there,
 * dependency-free, under `tests/tradeModel.test.ts`. This file decides layout
 * and formatting and nothing else.
 */

/* ========================================================================
   FORMATTERS
   ======================================================================== */

/** an unsigned market figure — thousands separated, no decimals */
const mkt = (v: number) => Math.round(v).toLocaleString();

/** A SIGNED market figure carrying the thousands separator the unsigned totals
 *  above it already have. `sgn` is a WAR/index formatter and drops it, which
 *  once put "6,388" and "−4351" in the same column. */
const sgnMkt = (v: number) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.round(Math.abs(v)).toLocaleString()}`;

/** an index figure. One decimal: DVI and CVI are 0–100 scales where a whole
 *  point is a real difference and a hundredth is noise. */
const idx = (v: number) => fmt(v, 1);
const sgnIdx = (v: number) => sgn(v, 1);

/** the date without its year — the season column beside it carries that */
const whenShort = (ts: number) => ts
  ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  : "—";

/* ========================================================================
   THE FROZEN AT-TRADE READ — one derivation, two readers
   ======================================================================== */

/**
 * `data/leagues/<key>/trade_snapshots.json`, keyed `"<ts>:<rid-rid…>"`.
 *
 * The first nightly run that sees a trade FREEZES what each side's haul was
 * worth on the day and never overwrites it (`scripts/trade_analysis.py`). `mkt`
 * is that side's KTC: players by pid and PICKS BY THEIR MID-TIER LADDER KEY
 * (since 2026-08-21 — a pick is a market asset until draft night), FAAB
 * skipped. It is null only where the writer could not price every asset on the
 * side, or where the committed value history does not reach back to the trade
 * — and entries frozen before picks were priced are backfilled from that
 * history rather than left as permanent em dashes.
 */
interface SnapSide { exp: number | null; mkt: number | null; fc?: number | null }
interface Snap { taken: string; kind: string; sides: Record<string, SnapSide> }
type Snaps = Record<string, Snap>;

/** the snapshot key, built exactly the way the writer builds it: the timestamp,
 *  then the trade's roster ids in ascending numeric order. Doubles as the row
 *  key, because it is unique even for two trades Sleeper stamped in one batch
 *  with the same `ts` — which a bare `ts` was not, and two ledger cards used to
 *  swap contents on any re-render because of it. */
const snapKey = (t: TradeT) =>
  `${t.ts}:${t.sides.map(s => s.rid).sort((x, y) => x - y).join("-")}`;

interface AtTrade {
  /** the frozen figures for one side of this trade */
  side: (rid: number) => SnapSide;
  /** THE VALUE COLUMN: the largest at-trade KTC any side of the deal carried.
   *  Null when no side could be priced — never zero, which would read as a
   *  trade of nothing rather than as one the market history cannot reach. */
  value: number | null;
}

/**
 * ONE derivation of the at-trade figures, read by the Value column AND by the
 * drawer.
 *
 * That is the whole point of the hook. The classic ledger derived the column's
 * figure on the card and the drawer's in a second closure over a second source,
 * which is a guarantee that the two disagree the moment either moves. Here the
 * column IS `value` and the drawer IS `side(rid)`, off one record.
 *
 * The fallback is the same figure by another road, not a second opinion:
 * `trade_analysis.py` stamps the snapshot onto each side of trades.json as
 * `mktThen` / `fcThen` / `expThen` in the same pass that writes the snapshot
 * file, so a deploy shipping trades.json without trade_snapshots.json still
 * prices the ledger — from figures frozen on the same day by the same code.
 */
function useAtTrade(): (t: TradeT) => AtTrade {
  const snaps = useJson<Snaps>("trade_snapshots.json").data;
  return useCallback((t: TradeT): AtTrade => {
    const sn = snaps?.[snapKey(t)];
    const frozen = new Map<number, SnapSide>();
    let value: number | null = null;
    for (const s of t.sides) {
      const rec = sn?.sides[String(s.rid)]
        ?? { exp: s.expThen ?? null, mkt: s.mktThen ?? null, fc: s.fcThen ?? null };
      frozen.set(s.rid, rec);
      if (rec.mkt != null) value = value == null ? rec.mkt : Math.max(value, rec.mkt);
    }
    return { side: rid => frozen.get(rid) ?? { exp: null, mkt: null, fc: null }, value };
  }, [snaps]);
}

/* ========================================================================
   REALIZED WAR
   ======================================================================== */

/** "2024 1st → Marvin Harrison": a pick that CONVERTED carries the player it
 *  became, and only a converted pick has a return anybody can judge. */
const converted = (a: TradeAsset) => a.label.split(" → ")[1];
const isRealized = (a: TradeAsset) => a.kind === "player" || !!converted(a);

/** A side's realized WAR: what the assets it can be judged on returned. Null —
 *  not zero — when nothing it received has converted yet, because "nothing yet"
 *  and "nothing" are different facts and only one of them is an em dash.
 *
 *  Written out again rather than imported from `components/TradeCard.tsx`: that
 *  module is the classic ledger's card, this screen exists to retire it, and
 *  importing a doomed component into its replacement inverts the dependency.
 *  Both copies belong in `lib/trades.ts` the day the classic view goes. */
const sideRealized = (s: TradeSide): number | null =>
  s.got.some(isRealized) ? s.war : null;

/**
 * A trade's sides in a STABLE order — roster id ascending.
 *
 * `trade_analysis.py` sorts each trade's sides by realized WAR descending, so
 * rendering them in file order would put the franchise that came out ahead in
 * the left column on every row of the ledger. That is a verdict expressed as a
 * layout, and picking a winner is the one thing this table refuses to do.
 * Roster id carries no claim, and it is the order the snapshot key already
 * uses, so the columns line up with the record behind them.
 */
const ordered = (t: TradeT) => t.sides.slice().sort((a, b) => a.rid - b.rid);

/**
 * THE WAR EDGE, WITH ITS OWNER.
 *
 * A magnitude and the franchise it belongs to, or an em dash and the reason it
 * has none. Never a bare signed number: a margin with no owner is the one thing
 * this column must not be.
 *
 * Four ways it declines, and they are four different facts:
 *   - a three-team deal has no two sides to difference
 *   - no football has been played since the deal (`played`)
 *   - a side received only picks that have not converted, so it has no return
 *   - the two returns are equal, which is a result rather than a refusal
 */
function warEdge(sides: TradeSide[], played: boolean):
  { v: number | null; owner: string | null; note: string | null } {
  if (sides.length > 2) return { v: null, owner: null, note: "3-team deal" };
  if (!played) return { v: null, owner: null, note: "not yet played" };
  const aw = sideRealized(sides[0]), bw = sideRealized(sides[1]);
  if (aw == null || bw == null) return { v: null, owner: null, note: "picks unconverted" };
  const d = aw - bw;
  if (Math.abs(d) < 0.0005) return { v: 0, owner: null, note: "even" };
  return { v: Math.abs(d), owner: d > 0 ? sides[0].team : sides[1].team, note: null };
}

/* ========================================================================
   THE SCREEN
   ======================================================================== */

export default function Trade() {
  const file = useJson<TradesPayload>("trades.json");
  // readTrades, not an inline Array.isArray: a trades.json written without its
  // `trades` key left the classic ledger stuck on "Loading" forever.
  const trades = useMemo(
    () => (file.data ? readTrades(file.data).trades : null), [file.data]);

  /**
   * THE HISTORY AXIS IS SEASONS WITH TRADES, not played seasons.
   *
   * Every other screen's History is a settled season, so it takes the played
   * list. The ledger's population is deals, and a deal made in the roster
   * season has already happened — the current year's trades are the ones a
   * reader is most likely to have come here for. Offering a season this league
   * never traded in would be a filter that can only return nothing.
   */
  const seasonIds = useMemo(
    () => [...new Set((trades ?? []).map(t => t.season))].sort().reverse(), [trades]);
  // ALL HISTORY (Max, 2026-09-02): the History tab is every deal the league
  // has made; a season is a filter on the ledger, beside the franchise filter.
  const [scope, setScope] = useScope(seasonIds, { all: true });
  const seasons = useMemo<ScopeSeason[]>(() => seasonIds.map(id => {
    const n = (trades ?? []).filter(t => t.season === id).length;
    return { id, note: `${n} trade${n === 1 ? "" : "s"}` };
  }), [seasonIds, trades]);

  /** the card a `?load=` link named — highlighted with the view's one accent
   *  and scrolled to. Every card is open; this is a pointer, not a state. */
  const [open, setOpen] = useState<string | null>(null);

  /* The League screen's activity cards link in with `?load=<ts>`. That used to
     drop the trade into the builder re-priced at today's values; it now opens
     that deal's own row in the ledger, because the builder draws from CURRENT
     rosters and a 2023 trade's players are mostly somewhere else by now. Scope,
     season and the dropped param move in ONE replace, so the scope control and
     this effect never fight over the query string. */
  const [params, setParams] = useSearchParams();
  const wantTs = params.get("load");
  useEffect(() => {
    if (!wantTs || !trades) return;
    const t = trades.find(x => String(x.ts) === wantTs);
    if (t) setOpen(snapKey(t));
    setParams(p => {
      const n = new URLSearchParams(p);
      n.delete("load");
      if (t) { n.set("scope", "history"); n.set("season", ALL_SEASONS); }
      return n;
    }, { replace: true });
  }, [wantTs, trades, setParams]);

  return (
    <>
      <div className="v3-head">
        <h1>Trade</h1>
        <span className="sub">
          {scope.scope === "history"
            ? "every deal, as the market saw it"
            : "two franchises, no you"}
        </span>
      </div>
      {/* "Build" rather than "Current": a trade being assembled is not a state
          the league is in. */}
      <ScopeControl value={scope} onChange={setScope} seasons={seasons} currentLabel="Build" all />

      {file.error
        ? <DataError what="Trades didn't load" />
        : file.loading
          ? <div className="empty">Loading trades…</div>
          : scope.scope === "history"
            ? <History trades={trades ?? []} season={scope.season} seasons={seasons}
                setSeason={id => setScope({ scope: "history", season: id })}
                open={open} setOpen={setOpen} />
            : <Build />}
    </>
  );
}

/* ========================================================================
   BUILD
   ======================================================================== */

/** which PANEL — that is, which franchise RECEIVES. Panel "a" lists what
 *  franchise A gets, which is drawn from franchise B's roster. */
type Side = "a" | "b";

interface Offer { id: number; a: string[]; b: string[] }
interface BuildState {
  /** the two franchises, by roster_id. SHARED across offers on purpose: the
   *  offers are competing packages between the same two teams, which is what
   *  makes putting them side by side a comparison rather than a list. */
  a: number | null; b: number | null;
  offers: Offer[];
  active: number;
}

/**
 * Persisted per league, on the same mechanism `lib/identity.ts` uses: one
 * `warboard.*` key holding a league-keyed map, read and written through
 * try/catch so private mode degrades to a session rather than to an exception.
 */
const STORE = "warboard.v3.trade";
const emptyBuild = (): BuildState =>
  ({ a: null, b: null, offers: [{ id: 1, a: [], b: [] }], active: 1 });

function readStore(): Record<string, BuildState> {
  try {
    const raw = window.localStorage.getItem(STORE);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? v as Record<string, BuildState> : {};
  } catch { return {}; }               // private mode, or a corrupt entry
}

function writeStore(all: Record<string, BuildState>) {
  try { window.localStorage.setItem(STORE, JSON.stringify(all)); }
  catch { /* private mode — the session still works, it just won't persist */ }
}

/** A stored entry is untrusted input: it outlives deploys, so it can predate
 *  any shape this file has ever had. Every field is checked or replaced. */
function readBuild(key: string): BuildState {
  const s = readStore()[key] as Partial<BuildState> | undefined;
  if (!s || !Array.isArray(s.offers) || !s.offers.length) return emptyBuild();
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter(x => typeof x === "string") as string[] : [];
  const offers = s.offers.map((o, i) => ({
    id: typeof o?.id === "number" ? o.id : i + 1,
    a: ids(o?.a), b: ids(o?.b),
  }));
  return {
    a: typeof s.a === "number" ? s.a : null,
    b: typeof s.b === "number" ? s.b : null,
    offers,
    active: offers.find(o => o.id === s.active)?.id ?? offers[0].id,
  };
}

function useBuildState(leagueKey: string) {
  const [st, setSt] = useState<BuildState>(() => readBuild(leagueKey));
  // The write rides inside the updater, exactly as identity.ts does it: one
  // place decides the next state and the same place persists it, so no caller
  // can change a basket without saving it. Switching league reloads the app, so
  // the key never changes under this hook.
  const set = useCallback((f: (p: BuildState) => BuildState) => {
    setSt(prev => {
      const next = f(prev);
      const all = readStore();
      all[leagueKey] = next;
      writeStore(all);
      return next;
    });
  }, [leagueKey]);
  return [st, set] as const;
}

/**
 * ONE OFFERABLE THING, on one roster.
 *
 * Not an `Asset` — an asset is a PRICE, and two of a franchise's picks can
 * share one (both its 2028 2nds price at the same Mid tier). A holding is an
 * instance, so a team that holds two of them can offer two of them, and a
 * basket that stores holding ids cannot contain a player nobody owns.
 */
interface Holding {
  /** unique within the roster; this is what a basket stores */
  id: string;
  /** the priced asset behind it — what the ledger actually values */
  asset: Asset;
  label: string;
  sub: string;
}

/** A basket's 3-year WAR. WAR is the one currency the trade model does not
 *  price — `s_lens(v)` is defined in market points and in index points, and a
 *  WAR sum lives in neither space — so it keeps its plain sum and its plain
 *  difference, and the consolidation row reads — under it. */
const sumWar = (rows: Holding[]) => rows.reduce((a, h) => a + (h.asset.war ?? 0), 0);

function Build() {
  const { league } = useLeague();
  const rosterSeason = rosterSeasonOf(league);
  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);
  const teams = teamsQ.data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const assets = useAssets();
  // Bridge B, market-implied: per-band, per-year WAR streams keyed by exactly
  // the labels `useAssets()` gives picks. Without it the pick-index estimator
  // declines and picks stay out of the index columns.
  const bridge = useJson<ValueBridge>("value_bridge.json", "leagueDaily").data;
  // only for the calendar — which rookie class drafts now, i.e. which year is
  // lag 0. The same expression `model.ts` uses to LABEL the current class, so
  // the two cannot drift apart.
  const pv = useJson<PickValues>("pick_values.json", "leagueDaily").data;
  // where every franchise's own picks project to land (tier, and the exact
  // slot for the class drafting now)
  const tiers = usePickTiers();

  // beta.css's breakpoint, not useWidth's 640px default: 900px is where the
  // shell's bottom bar becomes a left rail, and a layout that reflowed at some
  // other width would read as a second product.
  const desktop = !useMobile("(max-width: 899px)");

  const [st, set] = useBuildState(league.key || "default");
  /** phone only: whether the chip row is parked on "All offers". On desktop the
   *  loaded offer and the comparison are both on screen, so the control has
   *  nothing to do and is not rendered. */
  const [allView, setAllView] = useState(false);
  const [picking, setPicking] = useState<Side | null>(null);
  const [choosing, setChoosing] = useState<Side | null>(null);

  /* ---- the pick index estimator ------------------------------------------
     Fit once per data load, not once per render: `makePickIndexer` runs a
     monotone fit over the whole priced field to build the KTC→DVI and KTC→CVI
     ladders it evaluates picks on. Null until the field and the bridge are both
     in hand, and null forever if either is missing — at which point picks fall
     out of the index columns, which the caption says. */
  const indexer = useMemo<PickIndexer | null>(() => {
    if (!assets || !bridge) return null;
    const players = assets.filter(
      (x): x is Asset & { ktc: number; dvi: number; cvi: number } =>
        x.kind === "player" && x.ktc != null && x.dvi != null && x.cvi != null);
    return makePickIndexer({
      players, bridge,
      currentClass: pv ? pv.meta.generated_for_season + 1 : null,
    });
  }, [assets, bridge, pv]);

  /* ---- what each franchise actually holds --------------------------------
     Used once a side NAMES a franchise: then a player offered to the other
     side is on the roster the current rosters say holds him. With no
     franchise named the side draws from the open pool below instead — see
     `pool` — which is the classic machine's shape and the default. */
  const holdings = useMemo<Map<number, Holding[]> | null>(() => {
    if (!teams || !assets) return null;
    const byKey = new Map(assets.map(x => [x.key, x]));
    const name = new Map(teams.map(t => [t.roster_id, t.team]));
    const out = new Map<number, Holding[]>();

    for (const t of teams) {
      const players: Holding[] = [];
      for (const pid of t.players) {
        const a = byKey.get(`p${pid}`);
        // A rostered player the index does not price cannot be valued, so he
        // cannot be offered. The index's population is every player the model
        // prices, which today is every rostered player in the league.
        if (!a) continue;
        players.push({
          id: `p${pid}`, asset: a, label: a.label,
          sub: [a.nfl || null, a.pos, a.ktc?.toLocaleString() ?? null]
            .filter(Boolean).join(" · "),
        });
      }
      players.sort((x, y) => (y.asset.ktc ?? -1) - (x.asset.ktc ?? -1));

      const picks: Holding[] = [];
      for (const p of owned?.owned[String(t.roster_id)] ?? []) {
        const ord = ROUND_ORD[p.round - 1] ?? `${p.round}th`;
        // THE TIER IS INFERRED from the ORIGINAL owner's projected finish
        // (model.ts usePickTiers; Max, 2026-09-02) — a 1st from the projected
        // worst team is an Early 1st. Once a class is the one drafting NOW,
        // `useAssets` names it by exact slot rather than by tier, and the same
        // projection gives the slot itself.
        const ps = tiers?.get(p.orig);
        const a = byKey.get(`k${p.season} ${tierOf(tiers, p.orig)} ${ord}`)
          ?? byKey.get(`k${p.season} Pick ${p.round}.${String(ps?.slot ?? 6).padStart(2, "0")}`);
        if (!a) continue;
        picks.push({
          id: `k${p.season}-${p.round}-${p.orig}`, asset: a,
          label: `${p.season} ${ord}`,
          sub: ["Pick",
            p.orig === t.roster_id ? "own" : `from ${name.get(p.orig) ?? `Team ${p.orig}`}`,
            `proj. ${tierOf(tiers, p.orig).toLowerCase()}`,
            a.ktc?.toLocaleString() ?? null].filter(Boolean).join(" · "),
        });
      }
      picks.sort((x, y) => x.id.localeCompare(y.id));
      out.set(t.roster_id, [...players, ...picks]);
    }
    return out;
  }, [teams, assets, owned, tiers]);

  /* ---- THE OPEN POOL: team-agnostic, the classic machine's shape ---------
     (Max, 2026-09-02, restoring decision #13's letter.) A side with NO
     franchise named draws from every priced player and every generic pick —
     "is this fair" asked about a package, not about two rosters. Naming a
     franchise is an OPTIONAL narrowing: then that side's basket is limited to
     what the other franchise actually holds, which is the acceptance test the
     roster-bound version was built for. Holding ids are the asset keys, so an
     open-pool basket survives a later naming only where the named roster holds
     the same asset; the rest drop and are counted, as ever. */
  const pool = useMemo<Holding[] | null>(() => {
    if (!assets) return null;
    const rows: Holding[] = assets.map(a => ({
      id: a.key, asset: a, label: a.label,
      sub: (a.kind === "player"
        ? [a.nfl || null, a.pos, a.ktc?.toLocaleString() ?? null]
        : ["Pick", a.ktc?.toLocaleString() ?? null]).filter(Boolean).join(" · "),
    }));
    // players by price, then picks by their own label order (year, tier, round)
    rows.sort((x, y) => (x.asset.kind === y.asset.kind
      ? (x.asset.kind === "player" ? (y.asset.ktc ?? -1) - (x.asset.ktc ?? -1)
        : x.label.localeCompare(y.label))
      : (x.asset.kind === "player" ? -1 : 1)));
    return rows;
  }, [assets]);

  /**
   * A basket's stored ids, resolved against the source they were drawn from:
   * the OTHER franchise's holdings when one is named (it is who gives them
   * up), the open pool when not.
   *
   * An id that no longer resolves — the player has since been traded, or the
   * franchise on the other side was changed — is dropped and COUNTED, so the
   * panel can say so rather than quietly shrinking under a total the reader
   * has already read.
   */
  const resolve = useCallback((from: number | null, ids: string[]) => {
    const src = from == null ? pool ?? [] : holdings?.get(from) ?? [];
    const byId = new Map(src.map(h => [h.id, h]));
    const rows: Holding[] = [];
    let lost = 0;
    for (const id of ids) {
      const h = byId.get(id);
      if (h) rows.push(h); else lost++;
    }
    return { rows, lost };
  }, [holdings, pool]);

  const offer = st.offers.find(o => o.id === st.active) ?? st.offers[0];
  const viewA = resolve(st.b, offer.a);      // what A gets comes off B's roster
  const viewB = resolve(st.a, offer.b);

  const upd = (f: (o: Offer) => Offer) => set(p => ({
    ...p, offers: p.offers.map(o => (o.id === p.active ? f(o) : o)),
  }));
  const add = (side: Side, id: string) => upd(o => side === "a"
    ? { ...o, a: o.a.includes(id) ? o.a : [...o.a, id] }
    : { ...o, b: o.b.includes(id) ? o.b : [...o.b, id] });
  const drop = (side: Side, id: string) => upd(o => side === "a"
    ? { ...o, a: o.a.filter(x => x !== id) }
    : { ...o, b: o.b.filter(x => x !== id) });

  /** Naming a franchise — or un-naming it back to the open pool — EMPTIES the
   *  baskets it supplies, across every offer, because the franchises are
   *  shared. Panel B lists what B receives, which comes off A's roster, so
   *  replacing A invalidates it. Dropped rather than silently re-pointed at a
   *  source that never held those assets. */
  const chooseTeam = (side: Side, rid: number | null) => set(p => {
    if (side === "a") {
      if (p.a === rid) return p;
      return { ...p, a: rid, offers: p.offers.map(o => ({ ...o, b: [] })) };
    }
    if (p.b === rid) return p;
    return { ...p, b: rid, offers: p.offers.map(o => ({ ...o, a: [] })) };
  });

  const addOffer = () => {
    setAllView(false);
    // ids are monotonic, so removing the middle offer never renumbers the
    // others under the reader's finger
    set(p => {
      const id = Math.max(0, ...p.offers.map(o => o.id)) + 1;
      return { ...p, offers: [...p.offers, { id, a: [], b: [] }], active: id };
    });
  };
  const dropOffer = (id: number) => set(p => {
    const next = p.offers.filter(o => o.id !== id);
    const kept = next.length ? next : [{ id: 1, a: [], b: [] }];
    return {
      ...p, offers: kept,
      active: kept.some(o => o.id === p.active) ? p.active : kept[0].id,
    };
  });
  const loadOffer = (id: number) => { setAllView(false); set(p => ({ ...p, active: id })); };

  /* ---- the ledger --------------------------------------------------------
     Computed straight, not memoized: a basket is a handful of assets and the
     expensive half (the estimator's monotone fit over ~370 players) is already
     behind its own memo. A memo here would need every input to the two baskets
     in its dependency list, and a stale ledger is exactly the failure the
     "deltas are derived" rule exists to prevent.

     `Asset` is structurally a `LedgerAsset`, which is the point of that
     interface: the trade maths takes what `useAssets()` already produces and
     never imports it. */
  const led = tradeLedger(
    viewA.rows.map(h => h.asset), viewB.rows.map(h => h.asset), indexer);
  const warA = sumWar(viewA.rows), warB = sumWar(viewB.rows);

  const nameA = teams?.find(t => t.roster_id === st.a)?.team ?? null;
  const nameB = teams?.find(t => t.roster_id === st.b)?.team ?? null;
  /** the panel's name when no franchise is: the old machine's bare sides */
  const sideA = nameA ?? "Side A", sideB = nameB ?? "Side B";
  /** a total containing an estimated index IS an estimate, and says so with the
   *  same mark the asset carries */
  const apA = led.a.estimated ? "≈ " : "", apB = led.b.estimated ? "≈ " : "";
  const any = viewA.rows.length + viewB.rows.length > 0;
  const showBuilder = desktop || !allView;
  // one offer is not a comparison; on desktop the band appears the moment there
  // is a second thing to compare it to
  const showAll = allView || (desktop && st.offers.length > 1);

  if (teamsQ.error) return <DataError what="Rosters didn't load" />;
  if (!teams || !assets) return <div className="empty">Loading…</div>;

  return (
    <div className="trx-build">
      {/* THE CHIP ROW IS THE WHOLE NAVIGATION. Chips rather than a segmented
          control, because the set GROWS: a control that gains a segment every
          time you press one stops reading as a fixed set of choices. */}
      <div className="trx-chips" role="group" aria-label="Offers">
        {!desktop && (
          <button type="button" className={`trx-chip${allView ? " on" : ""}`}
            aria-pressed={allView} onClick={() => setAllView(true)}>All offers</button>
        )}
        {st.offers.map((o, i) => {
          const on = o.id === st.active && showBuilder;
          return (
            <button key={o.id} type="button" className={`trx-chip${on ? " on" : ""}`}
              aria-pressed={on} onClick={() => loadOffer(o.id)}>
              Offer {i + 1}
              {st.offers.length > 1 && (
                <span className="x" role="button" tabIndex={-1}
                  aria-label={`Remove offer ${i + 1}`}
                  onClick={e => { e.stopPropagation(); dropOffer(o.id); }}>×</span>
              )}
            </button>
          );
        })}
        <button type="button" className="trx-chip add" onClick={addOffer}>+ Offer</button>
      </div>

      {showBuilder && (
        <>
          <div className="v3-sides">
            <Panel gets={sideA} named={!!nameA} from={nameB} rows={viewA.rows}
              lost={viewA.lost} priced={led.a.rows} onTeam={() => setChoosing("a")}
              onAdd={() => setPicking("a")} onRemove={id => drop("a", id)} />
            <Panel gets={sideB} named={!!nameB} from={nameA} rows={viewB.rows}
              lost={viewB.lost} priced={led.b.rows} onTeam={() => setChoosing("b")}
              onAdd={() => setPicking("b")} onRemove={id => drop("b", id)} />
          </div>

          {any ? (
            /* ONE COLUMN PER FRANCHISE, ONE ROW PER CURRENCY, AND THE THIRD
               COLUMN IS THE FIRST TWO SUBTRACTED.
               Every cell under Difference is literally the cell to its left
               minus the cell before that — `tradeLedger` defines `net` as
               `a.raw − b.raw` and `adjNet` as `a.effective − b.effective`, and
               the WAR row does its own subtraction inline. Nothing is authored
               per asset or per offer, so no figure here can outlive the assets
               it describes.

               Three columns rather than four currencies across, because the
               figure face is monospaced and four columns leave ~49px of text at
               375px — not enough for a signed five-figure total. This shape is
               the design system's two-basket comparison in the ledger's own
               grammar: one currency per row, its correction under it.

               No winner column, no verdict, no colour on any figure — DVI and
               CVI answer different questions and routinely point at different
               sides, so a single number would be inventing agreement and a
               green total would be declaring a winner in CSS. */
            <Ledger title="What each side gets"
              columns={[nameA ?? "Side A", nameB ?? "Side B", "Difference"]}
              caption={
                <>
                  {LEDGER_GUARDRAIL} Difference is the two columns beside it
                  subtracted — {nameA ?? "side A"} minus {nameB ?? "side B"} —
                  computed at render, never authored. Consolidated weights each
                  asset by the share of weeks a thing of that value starts; a
                  3-year WAR sum is not priced through that curve, so it has no
                  consolidated line.
                  {led.a.estimated + led.b.estimated > 0 &&
                    " Figures marked ≈ carry a pick's estimated index, from its market price and when it lands; a difference between them inherits it."}
                </>
              }>
              <LedgerRow label="KTC" tone="net" values={[
                mkt(led.a.raw.market), mkt(led.b.raw.market), sgnMkt(led.net.market),
              ]} />
              <LedgerRow label="Consolidated" tone="adj" values={[
                mkt(led.a.effective.market), mkt(led.b.effective.market),
                sgnMkt(led.adjNet.market),
              ]} />
              <LedgerRow label="DVI" tone="net" values={[
                `${apA}${idx(led.a.raw.dvi)}`, `${apB}${idx(led.b.raw.dvi)}`,
                sgnIdx(led.net.dvi),
              ]} />
              <LedgerRow label="Consolidated" tone="adj" values={[
                `${apA}${idx(led.a.effective.dvi)}`, `${apB}${idx(led.b.effective.dvi)}`,
                sgnIdx(led.adjNet.dvi),
              ]} />
              <LedgerRow label="CVI" tone="net" values={[
                `${apA}${idx(led.a.raw.cvi)}`, `${apB}${idx(led.b.raw.cvi)}`,
                sgnIdx(led.net.cvi),
              ]} />
              <LedgerRow label="Consolidated" tone="adj" values={[
                `${apA}${idx(led.a.effective.cvi)}`, `${apB}${idx(led.b.effective.cvi)}`,
                sgnIdx(led.adjNet.cvi),
              ]} />
              <LedgerRow label="3yr WAR" tone="net" values={[
                fmtWar(warA), fmtWar(warB), sgnWar(warA - warB),
              ]} />
            </Ledger>
          ) : (
            <div className="tnote screen">
              {nameA && nameB
                ? "Add to either panel. A side can only be given what the other franchise actually holds today — players off its roster, and the picks it owns."
                : "Add any player or pick to either side and the ledger prices the package. Naming a franchise on a side is optional: it limits the other side to what that franchise actually holds today."}
            </div>
          )}
        </>
      )}

      {showAll && (
        <Compare offers={st.offers} active={st.active} loaded={showBuilder}
          nameA={sideA} nameB={sideB} ridA={st.a} ridB={st.b}
          indexer={indexer} resolve={resolve} onLoad={loadOffer} />
      )}

      {choosing && (
        <TeamSheet teams={teams} side={choosing}
          current={choosing === "a" ? st.a : st.b}
          other={choosing === "a" ? st.b : st.a}
          onPick={rid => { chooseTeam(choosing, rid); setChoosing(null); }}
          onClose={() => setChoosing(null)} />
      )}

      {picking && (
        <AssetSheet
          from={picking === "a" ? nameB : nameA}
          rows={(() => {
            const rid = picking === "a" ? st.b : st.a;
            return rid == null ? pool ?? [] : holdings?.get(rid) ?? [];
          })()}
          taken={new Set(picking === "a" ? offer.a : offer.b)}
          onPick={id => add(picking, id)}
          onClose={() => setPicking(null)} />
      )}
    </div>
  );
}

/* ---- one panel ----------------------------------------------------------- */

/**
 * "<Franchise> gets" — and the franchise is itself the control.
 *
 * Both panels are typographically identical and neither is the reader's. The
 * add button is dead until the OTHER franchise is named, because this panel
 * lists what this side receives and it receives from over there.
 */
function Panel({ gets, named, from, rows, lost, priced, onTeam, onAdd, onRemove }: {
  /** who receives — the franchise, or "Side A" / "Side B" when none is named */
  gets: string;
  /** whether a franchise is named (the header's quiet ink says "still open") */
  named: boolean;
  /** the franchise the assets come off, or null for the open pool */
  from: string | null;
  rows: Holding[]; lost: number;
  /** the ledger's priced rows, in the order they went in, so each asset can
   *  show its own estimate flag */
  priced: PricedAsset[];
  onTeam: () => void; onAdd: () => void; onRemove: (id: string) => void;
}) {
  return (
    <div className="v3-side">
      <button type="button" className="trx-sidehd" aria-haspopup="dialog" onClick={onTeam}>
        <span className={`k${named ? "" : " none"}`}>
          {gets} gets<span className="caret"> ▾</span>
        </span>
        <span className="n">{rows.length || ""}</span>
      </button>
      {rows.map((h, i) => (
        <div className="asset" key={h.id}>
          <PosSpine color={POS_COLOR[h.asset.pos]} />
          {/* THE ESTIMATE MARK. A pick's DVI and CVI are estimated from its
              market price and its stream's timing, not computed from a
              projection the way a player's are, and the totals below include
              them. Marking it on the asset it qualifies keeps the ledger's
              caption to the one sentence the design system asks for. */}
          <IdLines name={h.label} sub={h.sub}
            tags={priced[i]?.estimated ? ["≈ est"] : undefined} />
          <button className="x" type="button" aria-label={`Remove ${h.label}`}
            onClick={() => onRemove(h.id)}>×</button>
        </div>
      ))}
      {!rows.length && <div className="empty2">Nothing yet.</div>}
      {lost > 0 && (
        /* Said out loud rather than absorbed. A saved basket outlives a nightly
           refresh, and a package that quietly shrank is a package the reader is
           still reading the old total of. */
        <div className="trx-dropped">
          {lost} saved asset{lost === 1 ? "" : "s"} dropped — no longer on that roster.
        </div>
      )}
      <button className="addbtn" type="button" onClick={onAdd}>
        {from ? `+ Add from ${from}` : "+ Add"}
      </button>
    </div>
  );
}

/* ---- the franchise picker ------------------------------------------------ */

function TeamSheet({ teams, side, current, other, onPick, onClose }: {
  teams: Team[]; side: Side; current: number | null; other: number | null;
  onPick: (rid: number | null) => void; onClose: () => void;
}) {
  return (
    <Sheet label={`Franchise for side ${side.toUpperCase()}`} title="Franchises"
      onClose={onClose}>
      {/* THE OPEN POOL is a real choice, not the absence of one, so it is a
          row: naming a franchise is optional and has to be reversible from
          the same sheet that did it. */}
      <SheetRow on={current == null} mark={current == null ? "Here" : undefined}
        name={`Side ${side.toUpperCase()} — no franchise`}
        meta="the other side may be given any player or pick"
        onClick={() => onPick(null)} />
      {teams.slice().sort((a, b) => a.team.localeCompare(b.team)).map(t => {
        const on = t.roster_id === current;
        return (
          <SheetRow key={t.roster_id} on={on} mark={on ? "Here" : undefined}
            name={t.team} meta={t.manager}
            // a franchise cannot be both sides of its own trade
            disabled={t.roster_id === other}
            onClick={() => onPick(t.roster_id)} />
        );
      })}
    </Sheet>
  );
}

/* ---- the asset picker ---------------------------------------------------- */

/**
 * One franchise's roster and the picks it owns — nothing else.
 *
 * A sheet rather than the old full-screen takeover: that was built for a
 * ~900-player field, this is ~35 rows, and the sheet brings Escape, a real
 * scrim and a body-scroll lock the takeover never had.
 */
function AssetSheet({ from, rows, taken, onPick, onClose }: {
  from: string | null; rows: Holding[]; taken: Set<string>;
  onPick: (id: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = rows.filter(h => !taken.has(h.id));
    return needle ? pool.filter(h => h.label.toLowerCase().includes(needle)) : pool;
  }, [rows, taken, q]);
  return (
    <Sheet label={`Add from ${from ?? "any roster"}`}
      title={from ? `From ${from}` : "Any player or pick"} onClose={onClose}>
      <div className="trx-psearch">
        <input type="search" autoFocus value={q} placeholder="Player or pick"
          aria-label={from ? "Search this roster" : "Search every player and pick"}
          onChange={e => setQ(e.target.value)} />
      </div>
      {/* The open pool is ~900 rows; a sheet that renders all of them on every
          keystroke is a jank generator on a phone. The list is price-ordered,
          so the first 60 are the ones a search is most often for anyway. */}
      {hits.slice(0, from ? hits.length : 60).map(h => (
        <button type="button" className="trx-prow" key={h.id}
          onClick={() => { onPick(h.id); setQ(""); }}>
          <PosSpine color={POS_COLOR[h.asset.pos]} />
          <IdLines name={h.label} sub={h.sub} />
          <span className="v">{h.asset.ktc == null ? NUL : h.asset.ktc.toLocaleString()}</span>
        </button>
      ))}
      {!hits.length && (
        <div className="trx-pempty">
          {q ? <>Nothing {from ? "on this roster" : "in the pool"} matches “{q}”.</>
            : from ? "Everything this franchise holds is already in the offer."
              : "Nothing left to add."}
        </div>
      )}
      {!from && hits.length > 60 && (
        <div className="trx-pempty">Top 60 by price shown — search for the rest.</div>
      )}
    </Sheet>
  );
}

/* ---- every offer, side by side ------------------------------------------- */

/**
 * The comparison band: each offer's two totals, in two neutral columns named
 * after their franchises.
 *
 * TOTALS, NOT DELTAS. A column of differences would need an owner in its
 * header, and the comparison that matters across offers is between the packages
 * themselves. No "best per column" mark either: that is a claim about which
 * offer wins, asserted four times by four currencies that routinely disagree.
 */
function Compare({ offers, active, loaded, nameA, nameB, ridA, ridB, indexer, resolve, onLoad }: {
  offers: Offer[]; active: number;
  /** whether the builder is also on screen — desktop shows both */
  loaded: boolean;
  nameA: string; nameB: string;
  ridA: number | null; ridB: number | null;
  indexer: PickIndexer | null;
  resolve: (from: number | null, ids: string[]) => { rows: Holding[]; lost: number };
  onLoad: (id: number) => void;
}) {
  const scored = useMemo(() => offers.map(o => {
    const A = resolve(ridB, o.a).rows, B = resolve(ridA, o.b).rows;
    const l = tradeLedger(A.map(h => h.asset), B.map(h => h.asset), indexer);
    return { id: o.id, A, B, l, warA: sumWar(A), warB: sumWar(B) };
  }), [offers, ridA, ridB, indexer, resolve]);

  return (
    <>
      <Band label={`All offers · ${offers.length}`}
        note="Each package totalled on its own · both sides in the same ink" />
      <div className="trx-cmp">
        {scored.map((s, i) => {
          const on = loaded && s.id === active;
          return (
            <button type="button" key={s.id} onClick={() => onLoad(s.id)}
              className={`trx-cmpcard${on ? " on" : ""}`}>
              <div className="trx-cmphd">
                <span>Offer {i + 1}</span>
                <span className="go">{on ? "Loaded" : "Load →"}</span>
              </div>
              {s.A.length + s.B.length === 0 ? (
                <div className="trx-cmpnil">Nothing in this offer yet.</div>
              ) : (
                <div className="trx-cmpsides">
                  <Column name={nameA} rows={s.A} led={s.l.a} war={s.warA} />
                  <Column name={nameB} rows={s.B} led={s.l.b} war={s.warB} />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

function Column({ name, rows, led, war }: {
  name: string; rows: Holding[]; led: SideLedger; war: number;
}) {
  const ap = led.estimated ? "≈ " : "";
  return (
    <div className="trx-cmpside">
      <div className="who">{name} gets</div>
      <div className={`its${rows.length ? "" : " none"}`}>
        {rows.length ? rows.map(h => h.label).join(" · ") : "empty"}
      </div>
      {/* EVERY FIGURE NAMED: there is no header row above a two-column block
          for a bare number to inherit a name from. */}
      <dl className="trx-figs">
        {([
          ["KTC", mkt(led.raw.market)],
          ["DVI", `${ap}${idx(led.raw.dvi)}`],
          ["CVI", `${ap}${idx(led.raw.cvi)}`],
          ["WAR", fmtWar(war)],
        ] as const).map(([k, v]) => (
          <div className="fg" key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}

/* ========================================================================
   HISTORY — the league ledger
   ======================================================================== */

/**
 * Every trade the league has made, newest first, with no sort control anywhere.
 *
 * TWO FILTERS AND NO SORT (this is `views/Ledger.tsx`, absorbed). A ledger is a
 * chronology: a column that reorders it by size stops it being one, and "the
 * biggest trade of 2024" is a question the Value column already answers by eye.
 * Season and team are both sheets in the band (Max, 2026-09-02: History is
 * ALL history, and a year is a filter on it) — a list to pick from, not
 * something to cycle through. The season filter rides the URL's `season`
 * param so a filtered ledger is a link; the team filter is local.
 */
function History({ trades, season, seasons, setSeason, open, setOpen }: {
  trades: TradeT[];
  /** a season id, or ALL_SEASONS */
  season: string;
  seasons: ScopeSeason[];
  setSeason: (id: string) => void;
  open: string | null; setOpen: (k: string | null) => void;
}) {
  const { meta, league } = useLeague();
  const atTrade = useAtTrade();
  // the current market, for the drawer's change-since read
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  /** franchises in force — empty is every team. MULTI-SELECT like the season
   *  filter: a trade shows if ANY picked franchise was a side of it. */
  const [teamsOn, setTeamsOn] = useState<Set<number>>(() => new Set());
  const toggleTeam = (rid: number) => setTeamsOn(prev => {
    const next = new Set(prev);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    return next;
  });
  const [filtering, setFiltering] = useState<"team" | "season" | null>(null);
  /** the seasons in force — empty is every season. MULTI-SELECT (Max,
   *  2026-09-02): a set, joined into the URL's `season` param. */
  const picked = useMemo(() => seasonSet(season), [season]);
  const allSeasons = picked.size === 0;
  const seasonLabel = allSeasons ? "All seasons"
    : picked.size <= 3 ? [...picked].join(" · ") : `${picked.size} seasons`;
  const toggleSeason = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    // keep the list's order (newest first) rather than tap order
    setSeason(next.size ? seasons.map(s => s.id).filter(x => next.has(x)).join(",") : ALL_SEASONS);
  };

  /** the card a `?load=` link named, scrolled to once it renders */
  const scrollTo = useCallback((el: HTMLElement | null) => {
    el?.scrollIntoView({ block: "center" });
  }, []);

  /** WHETHER ANY FOOTBALL HAS BEEN PLAYED SINCE. A trade made in the roster
   *  season has no realized WAR yet, and 0.000 in that column would read as
   *  "returned nothing" rather than as "has not happened". */
  const latest = latestSeasonOf(meta);

  const rows = useMemo(() => trades
    .filter(t => (allSeasons || picked.has(t.season)) && t.sides.length >= 2)
    .slice()
    .sort((a, b) => b.ts - a.ts), [trades, picked, allSeasons]);
  const allTeams = teamsOn.size === 0;
  const shown = useMemo(
    () => (allTeams ? rows : rows.filter(t => t.sides.some(s => teamsOn.has(s.rid)))),
    [rows, teamsOn, allTeams]);
  const nameOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  const teamName = allTeams ? null
    : teamsOn.size <= 2 ? [...teamsOn].map(nameOf).join(" · ") : `${teamsOn.size} teams`;

  return (
    <div className="trx-hist">
      <Band
        label={allTeams
          ? `${rows.length} trade${rows.length === 1 ? "" : "s"}`
          : `${shown.length} of ${rows.length}`}
        right={
          /* TWO FILTERS, SEASON THEN TEAM, and no sort: a ledger is a
             chronology. Season lives in the URL (the scope's `season` param)
             so a filtered ledger is a shareable link; team is local. */
          <span className="trx-fils">
            <button type="button" className={`trx-fil${allSeasons ? "" : " on"}`}
              aria-haspopup="dialog" onClick={() => setFiltering("season")}>
              {seasonLabel}<span className="caret">▾</span>
            </button>
            <button type="button" className={`trx-fil${allTeams ? "" : " on"}`}
              aria-haspopup="dialog" onClick={() => setFiltering("team")}>
              {teamName ?? "All teams"}<span className="caret">▾</span>
            </button>
          </span>
        } />
      {/* THE LEDGER IS A FEED OF CARDS, NOT A TABLE (Max, 2026-09-02). Every
          trade is open: one card, one column per side, each column carrying
          what the franchise got, its KTC then → now, and its realized WAR.
          The row-and-drawer version put the whole point of the ledger — how
          each side has done since — behind a tap, and a five-column phone row
          truncated every franchise name to reach it. What the row carried that
          the card does not is the largest-side at-trade KTC, which the columns
          now state per side, and the WAR edge, which moves to the card's
          header line where it can name its owner in full. */}
      <div className="trx-feed">
        {shown.map(t => {
          const k = snapKey(t);
          const at = atTrade(t);
          const sides = ordered(t);
          const edge = warEdge(sides, Number(t.season) <= Number(latest));
          return (
            <article className={`trx-card${open === k ? " on" : ""}`} key={k}
              ref={open === k ? scrollTo : undefined}>
              <div className="trx-cardhd">
                <span className="when">
                  {whenShort(t.ts)}
                  <b> · {t.season} · wk {t.week}{sides.length > 2 ? " · 3-team" : ""}</b>
                </span>
                {/* THE MARGIN NAMES ITS OWNER, on the same line. A signed WAR
                    figure with nobody's name on it is the one thing this
                    ledger must never print. A record, not a verdict: neither
                    the figure nor the name is inked. */}
                <span className="edge">
                  <span className="k">WAR edge</span>
                  {edge.v == null
                    ? <span className="n">{edge.note}</span>
                    : <>
                      <span className="v">{edge.v === 0 ? fmtWar(0) : `+${fmtWar(edge.v)}`}</span>
                      <span className="n">{edge.owner}</span>
                    </>}
                </span>
              </div>
              <Sides t={t} at={at} vals={vals} nameOf={nameOf} />
            </article>
          );
        })}
        {!shown.length && (
          <div className="empty">
            {allTeams
              ? (allSeasons ? "No trades on record." : "No trades in those seasons.")
              : `No ${allSeasons ? "" : `${seasonLabel} `}trades involving ${teamName}.`}
          </div>
        )}
      </div>

      <div className="tnote screen">
        KTC since trade is each side's market on the day of the deal — frozen by the first nightly
        run that saw it — against today's. A pick prices at its tier: then, where it looked like
        landing on the day (the original owner's standing at the time, or the slot if already
        drafted); now, where it lands today. A side holding FAAB carries no market sum, and a trade
        older than the committed value history reads —. Realized WAR is
        what each side's assets produced while starting for the team that acquired them; WAR edge
        is the gap and names the franchise ahead. All of it is a record, not a verdict: no side is
        inked.
      </div>

      {filtering === "season" && (
        /* MULTI-SELECT: rows toggle and the sheet stays open, so two or three
           seasons can be ticked in one visit; Close (or the scrim, or Escape)
           is the way out. "All seasons" clears the set and closes, because
           there is nothing left to pick after it. */
        <Sheet label="Filter by season" title="Seasons · pick any" onClose={() => setFiltering(null)}>
          <SheetRow on={allSeasons} mark={allSeasons ? "On" : undefined}
            name="All seasons"
            meta={`${trades.filter(t => t.sides.length >= 2).length} trades on record`}
            onClick={() => { setSeason(ALL_SEASONS); setFiltering(null); }} />
          {seasons.map(sn => {
            const on = picked.has(sn.id);
            return (
              <SheetRow key={sn.id} on={on} mark={on ? "On" : undefined}
                name={sn.id} meta={sn.note}
                onClick={() => toggleSeason(sn.id)} />
            );
          })}
        </Sheet>
      )}
      {filtering === "team" && teams && (
        /* MULTI-SELECT, same grammar as the season sheet: rows toggle, the
           sheet stays open, "All teams" clears and closes. A trade shows if
           any ticked franchise was a side of it. */
        <Sheet label="Filter by franchise" title="Franchises · pick any" onClose={() => setFiltering(null)}>
          <SheetRow on={allTeams} mark={allTeams ? "On" : undefined}
            name="All teams"
            meta={`${rows.length} trade${rows.length === 1 ? "" : "s"}${allSeasons ? "" : ` in ${seasonLabel}`}`}
            onClick={() => { setTeamsOn(new Set()); setFiltering(null); }} />
          {teams.slice().sort((a, b) => a.team.localeCompare(b.team)).map(t => {
            const n = rows.filter(x => x.sides.some(s => s.rid === t.roster_id)).length;
            const on = teamsOn.has(t.roster_id);
            return (
              <SheetRow key={t.roster_id} on={on} mark={on ? "On" : undefined}
                name={t.team} meta={`${n} trade${n === 1 ? "" : "s"} · ${t.manager}`}
                onClick={() => toggleTeam(t.roster_id)} />
            );
          })}
        </Sheet>
      )}
    </div>
  );
}

/* ---- a trade's sides ------------------------------------------------------ */

/**
 * One column per side, each naming its franchise and carrying what it got,
 * then k / value / delta lines. This was the row drawer; it is the whole card
 * now.
 *
 * THE AT-TRADE KTC HERE IS THE FIGURE THE SNAPSHOT FROZE. It comes off the
 * `AtTrade` record the card built; this is handed it rather than deriving its
 * own.
 */
function Sides({ t, at, vals, nameOf }: {
  t: TradeT; at: AtTrade; vals: Values | null;
  /** a franchise's current name, for "whose pick" */
  nameOf: (rid: number) => string;
}) {
  const betaPath = useBetaPath();
  return (
        <div className="trx-drin">
          {ordered(t).map(s => {
            const then = at.side(s.rid).mkt;
            const now = marketNow(s, vals);
            const real = sideRealized(s);
            return (
              <div className="trx-drside" key={s.rid}>
                <div className="trx-drteam">{s.team} gets</div>
                <div className="trx-drgot">
                  {s.got.map((a, i) => {
                    const [head, tail] = a.label.split(" → ");
                    // AN UNDRAFTED PICK SAYS WHOSE IT IS AND WHERE IT PROJECTS
                    // (Max, 2026-09-02): "2027 1st · Point Drake's · proj. mid"
                    // rather than the writer's "(not yet drafted)", which said
                    // only what the reader could already see. The writer's
                    // suffix is dropped here; an "(unused)" slot keeps its word,
                    // since that is a fact about the draft, not the pick.
                    const undrafted = a.kind === "pick" && !a.pid && / \(not yet drafted\)$/.test(head);
                    const name = undrafted ? head.replace(/ \(not yet drafted\)$/, "") : head;
                    const whose = undrafted && a.orig != null ? `${nameOf(a.orig)}’s` : null;
                    // THE TIER, THEN AND NOW. A pick prices where it looked
                    // like landing on the day of the deal and where it lands
                    // today; when those differ the line says so, because
                    // that drift is part of the KTC delta beneath it.
                    const tier = a.kind === "pick" && a.tier
                      ? (a.tierThen && a.tierThen !== a.tier
                        ? `${a.tierThen.toLowerCase()} → ${a.tier.toLowerCase()}`
                        : a.tier.toLowerCase())
                      : null;
                    return (
                      <div className={`it${a.kind !== "player" ? " pick" : ""}`} key={i}>
                        {a.kind !== "player" && tail ? `${name} → ` : null}
                        {a.pid
                          ? <a href={`#${betaPath(`/player/${a.pid}`)}`}>{tail ?? name}</a>
                          : (tail ?? name)}
                        {whose && <span className="whose"> · {whose}</span>}
                        {tier && <span className="tier"> · {undrafted ? "proj. " : ""}{tier}</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="trx-drrow">
                  <span className="k">KTC since trade</span>
                  <span className="v">
                    {then == null ? NUL : then.toLocaleString()}
                    {" → "}
                    {now == null ? NUL : now.toLocaleString()}
                  </span>
                  {/* NEVER INKED. The same row renders for both sides of one
                      trade, so a green figure here and a red one across the
                      divider declares a winner in CSS. The sign is the claim. */}
                  <span className="d">
                    {then != null && now != null ? sgnMkt(now - then) : NUL}
                  </span>
                </div>
                <div className="trx-drrow">
                  <span className="k">Realized WAR</span>
                  <span className="v">{real == null ? NUL : fmtWar(real)}</span>
                </div>
                {/* its own line, its own label: "+1.85 to come" tacked onto the
                    realized figure read as a delta of it, which it is not — it
                    is the side's remaining projected stream (Max, 2026-09-02) */}
                <div className="trx-drrow">
                  <span className="k">Proj WAR</span>
                  <span className="v">{s.future == null ? NUL : sgnWar(s.future)}</span>
                </div>
              </div>
            );
          })}
        </div>
  );
}

/**
 * A side's market TODAY, on the same basis the snapshot froze.
 *
 * THIS IS A PORT OF `scripts/trade_analysis.py: mkt_side`, asset for asset, and
 * it has to stay one: it supplies the right-hand end of `then → now`, and a
 * delta between two different measurements is not a delta.
 *
 *  - PICKS ARE PRICED (settled with Max, 2026-08-21: a pick IS a market asset
 *    until draft night), AT THEIR TIER (Max, 2026-09-02). The writer keys
 *    them `"<ps> <tier> <ord>"` off `values.json`'s pick ladder, where the
 *    tier is a drafted pick's actual slot or an undrafted one's projected
 *    slot off its original owner's projected finish; the asset carries it as
 *    `tier`, and rows written before that date carry none and read Mid. A
 *    CONVERTED pick keeps the pick key too, even though it carries the
 *    drafted player's id: the writer branches on `kind == "pick"`, not on
 *    whether a pid is present.
 *  - FAAB IS SKIPPED, not declined — same as the writer's `continue`.
 *  - THE BASE KTC LADDER, not `lib/values.ktcOf`. This is the one deliberate
 *    exception to the site-wide TE-premium rule. The writer's `price_now` reads
 *    `row.get("ktc")` and the frozen history rows are the same base column, so
 *    pricing today's end on the premium ladder would credit a scoring rule to
 *    the market and show every tight end gaining value he never gained. Like
 *    for like, and the like is what was written down on the day.
 *  - ONE UNPRICEABLE ASSET VOIDS THE SIDE, which is the writer's rule too: it
 *    sets the running total to None the moment a source can't price an asset.
 */
function marketNow(s: TradeSide, vals: Values | null): number | null {
  if (!vals) return null;
  const pickKtc = new Map(vals.picks?.ktc ?? []);
  let sum = 0;
  for (const a of s.got) {
    if (a.kind === "faab") continue;
    let v: number | undefined;
    if (a.kind === "pick" && a.ps != null && a.rnd != null) {
      // the writer's `pick_key`, glyph for glyph: the pick AT ITS TIER, the
      // same tier the frozen "then" priced it at, so the delta is a delta
      v = pickKtc.get(`${a.ps} ${a.tier ?? "Mid"} ${ROUND_ORD[a.rnd - 1] ?? `${a.rnd}th`}`);
    } else if (a.pid) {
      v = vals.players[a.pid]?.ktc;
    }
    if (!v) return null;
    sum += v;
  }
  return sum || null;
}
