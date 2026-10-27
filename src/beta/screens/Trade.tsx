import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { PicksOwned, Team, Trade as TradeT, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useCurrentPickClass, useLeagueCaps } from "../../lib/caps";
import { useLeague } from "../../lib/context";
import { fmt } from "../../lib/stats";
import { POS_COLOR, rosterSeasonOf } from "../../lib/league";
import { ROUND_ORD } from "../../lib/rosterModel";
import { readTrades } from "../../lib/trades";
import { tradeId } from "../../lib/tradeLineage";
import { useMobile } from "../../lib/useWidth";
import {
  makePickIndexer, tradeLedger,
  type PickIndexer, type SideLedger, type ValueBridge,
} from "../../lib/tradeModel";
import { tierOf, useAssets, usePickTiers, useSeasonPhase, type Asset } from "../model";
import ScopeControl, { ALL_SEASONS, seasonSet, useScope, type ScopeSeason } from "../Scope";
import {
  Band, DataError, fmtWar, IdLines, NUL,
  PosSpine, Sheet, SheetRow, useBetaPath,
} from "../ui";
import {
  GRID_NOTE, snapKey, TradeGrid, useGridCtx, useWho, warEdge,
} from "./tradeGrid";
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
 * is inked by who is ahead. Coloring one basket green and the other amber
 * implies a winner when the color is really just whose column it is, and the
 * sign already carries the direction.
 *
 * DELTAS ARE DERIVED, NEVER AUTHORED. Every difference here is computed from
 * two totals at render time. Nothing is stored per asset and nothing is stored
 * per offer, because a stored delta drifts the instant an asset moves and there
 * is no way to notice that it has.
 *
 * THE MATH IS IN `lib/tradeModel`. The consolidation curve, the pick index
 * estimate and the arithmetic that ties the ledger together live there,
 * dependency-free, under `tests/tradeModel.test.ts`. This file decides layout
 * and formatting and nothing else.
 */

/* ========================================================================
   FORMATTERS
   ======================================================================== */

/** an unsigned market figure — thousands separated, no decimals */
const mkt = (v: number) => Math.round(v).toLocaleString();

/** an index figure. One decimal: DVI and CVI are 0–100 scales where a whole
 *  point is a real difference and a hundredth is noise. */
const idx = (v: number) => fmt(v, 1);

/** the date without its year — the season column beside it carries that */
const whenShort = (ts: number) => ts
  ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  : "—";

/* ========================================================================
   THE SCREEN
   ======================================================================== */

export default function Trade() {
  const { league } = useLeague();
  /* BOTH TENSES ARE PIPELINE OUTPUT. History reads trades.json, which
     `trade_analysis.py` writes for the default league only; Build prices a
     package in DVI, CVI and KTC, none of which exist for a league the index
     runs skip. In Pineapple Pizza the fetch 404d and "Trades didn't load"
     replaced the entire screen — a dropped-connection message over a file that
     was never going to exist. Both branches say which it is now. */
  const caps = useLeagueCaps();
  const file = useJson<TradesPayload>(caps.trades ? "trades.json" : null);
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

      {!caps.trades && !caps.indices ? (
        /* A LEAGUE THE MACHINE HAS NO CURRENCIES FOR. Said once, for both
           tenses: there is no ledger because nothing scores this league's
           trades, and there is no builder because a package is priced in DVI,
           CVI and a dynasty market this league does not play in. */
        <div className="tnote screen">
          The trade machine and the ledger are not published for {league.name}. Both price a
          package in this board's own currencies — DVI, CVI and projected WAR from the
          nightly model runs, plus the dynasty market — and those runs cover the home league
          only. The trades this league has made are in its transaction log, on each
          franchise's own page under the last seven days.
        </div>
      ) : file.error
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
 * KEPT FOR THE VISIT, NOT FOREVER (Max, 2026-09-10). The build used to live
 * in localStorage, and a trade sketched on Tuesday was still sitting in the
 * panels the next weekend, on every visit, until the storage was cleared by
 * hand. Now it lives in module memory: it survives leaving the screen for a
 * player page and coming back, which is the one thing worth surviving, and a
 * refresh starts clean. The old key is removed on first load so nothing
 * stale is ever read again.
 */
const STORE = "warboard.v3.trade";
const emptyBuild = (): BuildState =>
  ({ a: null, b: null, offers: [{ id: 1, a: [], b: [] }], active: 1 });

let store: Record<string, BuildState> = {};
try { window.localStorage.removeItem(STORE); } catch { /* private mode */ }

function readStore(): Record<string, BuildState> { return store; }

function writeStore(all: Record<string, BuildState>) { store = all; }

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
/** the asset line's WAR — "WAR 1.24" — on the asset itself, since the favor
 *  board sums it and nothing adjusts it, so the tally has no line for it */
const warTag = (a: Asset) => (a.war == null ? null : `WAR ${fmtWar(a.war)}`);
const sumFc = (rows: Holding[]) => rows.reduce((a, h) => a + (h.asset.fc ?? 0), 0);

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
  /* ONLY FOR THE CALENDAR — which rookie class drafts now, i.e. which year is
     lag 0. The same helper `useAssets` LABELS the current class with, so the
     two cannot drift apart, and off drafts.json rather than off
     `pick_values.meta.generated_for_season + 1`: that expression says when the
     pick-value script last ran, and on the data as shipped it made 2026 — a
     class drafted in May — the class the indexer priced at lag 0, so every
     future pick was discounted one year too few. */
  const currentClass = useCurrentPickClass();
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
    return makePickIndexer({ players, bridge, currentClass });
  }, [assets, bridge, currentClass]);

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
          sub: [a.nfl || null, a.pos, a.ktc?.toLocaleString() ?? null, warTag(a)]
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
            a.ktc?.toLocaleString() ?? null, warTag(a)].filter(Boolean).join(" · "),
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
        ? [a.nfl || null, a.pos, a.ktc?.toLocaleString() ?? null, warTag(a)]
        : ["Pick", a.ktc?.toLocaleString() ?? null, warTag(a)]).filter(Boolean).join(" · "),
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
  /* MEMOIZED, and it has to be. These two feed `fixes` below, whose whole
     point is a memo — and `resolve` returns a fresh object every call, so the
     dependency compared unequal on every render and the memo never once hit.
     ~450 candidates × 4 measures × one `tradeLedger` each ran on every
     keystroke, every hover, every re-render of the Build screen. The inputs
     are the resolver, the two named franchises and the offer's own arrays. */
  const viewA = useMemo(                     // what A gets comes off B's roster
    () => resolve(st.b, offer.a), [resolve, st.b, offer.a]);
  const viewB = useMemo(
    () => resolve(st.a, offer.b), [resolve, st.a, offer.b]);

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
     A basket is a handful of assets, so this is cheap on its own; it is
     memoized because it is a DEPENDENCY of the even-up search, which is not.
     Its inputs are the two resolved baskets and the estimator — exactly the
     three things that can change the answer — so "deltas are derived, never
     authored" still holds: nothing here is stored, it is recomputed whenever
     an input moves and at no other time.

     `Asset` is structurally a `LedgerAsset`, which is the point of that
     interface: the trade math takes what `useAssets()` already produces and
     never imports it. */
  const led = useMemo(
    () => tradeLedger(
      viewA.rows.map(h => h.asset), viewB.rows.map(h => h.asset), indexer),
    [viewA, viewB, indexer]);
  const warA = useMemo(() => sumWar(viewA.rows), [viewA]);
  const warB = useMemo(() => sumWar(viewB.rows), [viewB]);

  /* ---- evening up -------------------------------------------------------
     (Max, 2026-09-08.) One candidate per measure: the CHEAPEST single asset
     that, added to the trailing side, lands that measure inside the even
     window AFTER the star adjustment. Found by re-running the ledger with
     each candidate in the basket — utilization makes additions non-linear
     (a second RB at CVI 60 adds less than the first), so nothing short of
     recomputing is honest. ~400 candidates × 4 measures × one ledger each is
     a few milliseconds.

     The pool is what the trailing side could actually be given: the leading
     franchise's roster and picks when one is named, the open pool when not —
     the same source the "+ Add" sheet draws from. */
  const fixes = useMemo<Fix[]>(() => {
    if (!viewA.rows.length && !viewB.rows.length) return [];
    const A = viewA.rows.map(h => h.asset), B = viewB.rows.map(h => h.asset);
    const taken = new Set([...offer.a, ...offer.b]);
    const src = (to: Side) => {
      // basket B receives off A's roster, and vice versa
      const from = to === "a" ? st.b : st.a;
      return (from == null ? pool ?? [] : holdings?.get(from) ?? []).filter(h => !taken.has(h.id));
    };
    const out: Fix[] = [];
    for (const m of MEASURES) {
      const { a, b } = measure(m, led, warA, warB);
      const now = favor(a, b);
      if (now.side === "even") { out.push({ m, side: "even", was: now, picks: [] }); continue; }
      const to: Side = now.side === "a" ? "b" : "a";
      const hits: Fix["picks"] = [];
      for (const h of src(to)) {
        const l = to === "a"
          ? tradeLedger([...A, h.asset], B, indexer) : tradeLedger(A, [...B, h.asset], indexer);
        const w = (h.asset.war ?? 0);
        const r = measure(m, l, warA + (to === "a" ? w : 0), warB + (to === "b" ? w : 0));
        const after = favor(r.a, r.b);
        if (after.side !== "even") continue;
        hits.push({ h, cost: h.asset.ktc ?? Infinity, after });
      }
      // cheapest first, and one line per label: a franchise holding two of
      // the same band would otherwise list the same pick twice
      hits.sort((x, y) => x.cost - y.cost);
      const seen = new Set<string>();
      const picks = hits.filter(x => !seen.has(x.h.label) && seen.add(x.h.label)).slice(0, FIX_N);
      out.push({ m, side: to, was: now, picks });
    }
    return out;
  }, [viewA, viewB, offer, st.a, st.b, pool, holdings, led, warA, warB, indexer]);

  const nameA = teams?.find(t => t.roster_id === st.a)?.team ?? null;
  const nameB = teams?.find(t => t.roster_id === st.b)?.team ?? null;
  /** the panel's name when no franchise is: the old machine's bare sides */
  const sideA = nameA ?? "Side A", sideB = nameB ?? "Side B";
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
              lost={viewA.lost} led={led.a}
              onTeam={() => setChoosing("a")}
              onAdd={() => setPicking("a")} onRemove={id => drop("a", id)} />
            <Panel gets={sideB} named={!!nameB} from={nameA} rows={viewB.rows}
              lost={viewB.lost} led={led.b}
              onTeam={() => setChoosing("b")}
              onAdd={() => setPicking("b")} onRemove={id => drop("b", id)} />
          </div>

          {any ? (
            /* ONE ROW PER CURRENCY, STAR ADJUSTED, WITH A FAVOR BAR.
               (Max, 2026-09-08, superseding the no-verdict ledger.) The raw
               totals moved up into each panel's tally strip — they are "what
               you get", and they read beside the assets that make them. Down
               here every figure is the star-adjusted one, because that is the
               number the reader actually decides on, and a bar between the two
               says which side it favors and by how much. Inside ±10% the row
               says EVEN rather than crowning a side over noise.

               The bar is a margin, not a meter: the marker moves toward the
               favored side by the margin, so it never restates an index as a
               magnitude (SKILL §3). Every verdict is computed at render from
               the two figures beside it — nothing authored per asset or per
               offer. */
            <FavorBoard nameA={sideA} nameB={sideB} fixes={fixes}
              onAdd={(side, id) => add(side, id)} rows={[
              { m: "market", k: "Adjusted KTC", a: led.a.effective.market, b: led.b.effective.market, f: mkt },
              { m: "dvi", k: "Adjusted DVI", a: led.a.effective.dvi, b: led.b.effective.dvi, f: idx },
              { m: "cvi", k: "Adjusted CVI", a: led.a.effective.cvi, b: led.b.effective.cvi, f: idx },
              { m: "war", k: "3yr WAR", a: warA, b: warB, f: fmtWar },
            ]} />
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
function Panel({ gets, named, from, rows, lost, led, onTeam, onAdd, onRemove }: {
  /** who receives — the franchise, or "Side A" / "Side B" when none is named */
  gets: string;
  /** whether a franchise is named (the header's quiet ink says "still open") */
  named: boolean;
  /** the franchise the assets come off, or null for the open pool */
  from: string | null;
  rows: Holding[]; lost: number;
  /** this side's ledger — the RAW totals tally under the assets */
  led: SideLedger;
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
      {rows.map(h => (
        <div className="asset" key={h.id}>
          <PosSpine color={POS_COLOR[h.asset.pos]} />
          {/* No estimate mark (Max, 2026-09-08): a pick's DVI and CVI are
              estimated from its price and timing rather than projected, but
              the board reads them as figures like any other. */}
          <IdLines name={h.label} sub={h.sub} />
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
      {rows.length > 0 && (
        /* THE RAW TALLY. What this side gets, summed and unadjusted — the same
           four figures the offer cards carry, so a package reads the same in
           both places. The star-adjusted figures live in the favor board
           below, never here. */
        <dl className="trx-figs trx-tally" aria-label={`${gets} — raw totals`}>
          {/* a 2×2 read DOWN the columns: DVI over CVI, then FantasyCalc over
              KTC. No WAR line — it is on each asset, and the favor board sums
              it — and no FantasyCalc anywhere else: it is a second market
              quote, shown for the reader, not priced by the model. */}
          {([
            ["DVI", idx(led.raw.dvi)],
            ["FC", mkt(sumFc(rows))],
            ["CVI", idx(led.raw.cvi)],
            ["KTC", mkt(led.raw.market)],
          ] as const).map(([k, v]) => (
            <div className="fg" key={k}><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* ---- the favor board ----------------------------------------------------- */

/** Inside this band a row says EVEN. Measured as |A − B| ÷ max(|A|, |B|), so a
 *  4,603-vs-4,335 KTC gap (5.8%) is even and 56.6-vs-0.7 CVI (99%) is not. */
const EVEN = 0.10;

export interface Favor {
  /** A minus B over the larger MAGNITUDE. Positive favors A. Bounded by ±2,
   *  and only a pair straddling zero can exceed ±1. */
  pct: number;
  side: Side | "even";
  /** whether that margin can honestly be READ as a percentage — true when
   *  neither figure is negative, so the denominator is a quantity somebody
   *  actually has. See below. */
  asPct: boolean;
}

/**
 * WHICH SIDE A PAIR FAVORS, AND BY HOW MUCH. The one definition the board, the
 * verdicts and the even-up search all read, so they cannot disagree.
 *
 * THE DENOMINATOR IS A MAGNITUDE (2026-09-21). It was `Math.max(a, b)`, guarded
 * by `> 0` and otherwise zero, which is right for the three currencies that
 * cannot go negative and wrong for the fourth. 255 of the 365 projected players
 * carry a NEGATIVE three-year WAR total — that is what a replacement baseline
 * means, not a data fault — so the 3yr WAR row hit the broken branch constantly:
 *
 *   −0.5 vs −3.0   max is negative, so pct was 0 and the row read EVEN over a
 *                  two-and-a-half-win gap, which is the largest gap this board
 *                  can print.
 *   +1.0 vs −0.5   max is 0.5 short of the true scale, so pct was 1.5 — and the
 *                  marker `0.5 − pct/2` landed at −0.25, drawing itself and its
 *                  fill outside the track.
 *
 * `max(|a|, |b|)` is the scale in both cases; the epsilon is only there so two
 * empty baskets divide by something. The marker is clamped at the call site,
 * because a margin past ±100% is real and has to be SAID rather than drawn.
 *
 * AND A PERCENTAGE IS NOT ALWAYS THE HONEST WORD FOR IT. "+83%" means "83% of
 * the bigger one", which a reader can hold when both sides are quantities. When
 * one of them is negative the bigger one is a hole, and the verdict says the
 * gap in the row's own units instead — "+2.50" wins, not "+83%". Same
 * arithmetic, same even window; only the sentence changes. This is the
 * presentation rule PROJECT_NOTES #10 already sets for the deltas: signed, per
 * currency, never rolled into one verdict.
 */
function favor(a: number, b: number): Favor {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  const pct = (a - b) / scale;
  return {
    pct,
    side: Math.abs(pct) <= EVEN ? "even" : pct > 0 ? "a" : "b",
    asPct: a >= 0 && b >= 0,
  };
}

type Measure = "market" | "dvi" | "cvi" | "war";
const MEASURES: readonly Measure[] = ["market", "dvi", "cvi", "war"];
const MEASURE_LABEL: Record<Measure, string> = {
  market: "Adjusted KTC", dvi: "Adjusted DVI", cvi: "Adjusted CVI", war: "3yr WAR",
};
/** the figure the favor board shows for a measure — star adjusted, or the
 *  plain WAR sum */
function measure(m: Measure, led: ReturnType<typeof tradeLedger>, warA: number, warB: number) {
  return m === "war"
    ? { a: warA, b: warB }
    : { a: led.a.effective[m], b: led.b.effective[m] };
}

/** how many candidates a measure lists */
const FIX_N = 3;

interface Fix {
  m: Measure;
  /** the side an asset would be added to — the trailing one — or "even" */
  side: Side | "even";
  was: Favor;
  /** cheapest first; empty when no single asset gets there */
  picks: { h: Holding; cost: number; after: Favor }[];
}

interface FavorRow {
  m: Measure;
  k: string;
  /** the STAR-ADJUSTED figure per side (WAR: the plain sum — it is not priced
   *  through the utilization curve, so it has no adjusted form) */
  a: number; b: number;
  f: (v: number) => string;
}

/**
 * One row per currency: A's figure, a favor bar, B's figure, a verdict.
 *
 * The bar is a DIVERGING bar, center = even. The marker starts at the middle
 * and moves TOWARD the favored side's figure by the margin — A ahead by 99%
 * puts it against A's column, not B's — and gold fills from the center out to
 * it. The lit band across the middle is the even zone: a marker inside it is
 * an EVEN row. It never states a magnitude, only the margin between two
 * figures, so it does not restate an index as a meter (SKILL §3 on DVI/CVI).
 *
 * The verdict is the one place on the board that names a winner, and it is
 * per currency on purpose: DVI and CVI routinely disagree, and four rows that
 * disagree are the honest picture. There is no roll-up line.
 */
function FavorBoard({ nameA, nameB, rows, fixes, onAdd }: {
  nameA: string; nameB: string; rows: FavorRow[];
  fixes: Fix[]; onAdd: (side: Side, id: string) => void;
}) {
  /* THE VERDICT IS THE CONTROL. A row that is not even carries "Side A +73%"
     as a button; pressing it opens a drawer under the row (inline, in the
     same flow — SKILL: rows navigate, drawers are inline) listing the
     cheapest single adds that would land that measure even, each with its
     own + Add. EVEN has nothing to open and stays a label. */
  const [open, setOpen] = useState<Measure | null>(null);
  const name = (sd: Side) => (sd === "a" ? nameA : nameB);
  // the even zone: margin ±EVEN maps to center ± EVEN/2 of the bar's width
  const lo = 0.5 - EVEN / 2, hi = 0.5 + EVEN / 2;
  return (
    <div className="trx-favor">
      <div className="band">
        <span className="lk">Who's favored</span>
        <span className="r">Star adjusted · even inside ±{Math.round(EVEN * 100)}%</span>
      </div>
      {/* A GRID, NOT A TABLE, so a phone can reflow each row to two lines —
          label and verdict, then A · bar · B — without a second markup tree.
          The header row is desktop-only; on a phone every figure is beside the
          bar that explains it and the verdict names the side outright. */}
      <div className="grid" role="table" aria-label="Who's favored, star adjusted">
        <div className="hd" role="row">
          <span className="t" role="columnheader">Measure</span>
          <span className="a" role="columnheader">{nameA}</span>
          <span className="bar" role="columnheader">Favor</span>
          <span className="b" role="columnheader">{nameB}</span>
          <span className="v" role="columnheader">Verdict</span>
        </div>
        {rows.map((r, i) => {
          const { pct, side, asPct } = favor(r.a, r.b);
          /* THE MARGIN IN A UNIT THE READER CAN CHECK. A percentage is a share
             of the larger figure, which only means something when both figures
             are quantities; where one side's basket projects NEGATIVE WAR the
             larger figure is a hole, so the verdict states the gap in the row's
             own units and the two figures either side of the bar are what it is
             a gap between. */
          const verdict = side === "even" ? "Even"
            : `${side === "a" ? nameA : nameB} +${asPct
              ? `${Math.round(Math.abs(pct) * 100)}%`
              : r.f(Math.abs(r.a - r.b))}`;
          /* marker position: center, pushed toward the favored side by the
             margin — and CLAMPED to the track. A pair straddling zero has a
             margin past ±100% (mixed signs put `pct` as high as 2), which is a
             true statement about the gap and an impossible position on a bar
             running 0 to 1. The verdict carries the magnitude; the marker
             saturates at the end of the track, which is what "off the scale"
             looks like. */
          const at = Math.min(1, Math.max(0, 0.5 - pct / 2));
          const fill = at < 0.5
            ? { left: `${at * 100}%`, width: `${(0.5 - at) * 100}%` }
            : { left: "50%", width: `${(at - 0.5) * 100}%` };
          const fix = fixes.find(f => f.m === r.m) ?? null;
          return [
            <div key={r.k} className={`row ${side}${i % 2 ? " alt" : ""}`} role="row">
              <span className="t" role="cell">{r.k}</span>
              <span className={`f a${side === "a" ? " win" : ""}`} role="cell">
                {r.f(r.a)}
              </span>
              <span className="bar" role="cell">
                <span className={`fb ${side}`} role="img" aria-label={verdict}>
                  <span className="win" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
                  {side !== "even" && <span className="fill" style={fill} />}
                  <span className="mid" />
                  <span className="split" style={{ left: `${at * 100}%` }} />
                </span>
              </span>
              <span className={`f b${side === "b" ? " win" : ""}`} role="cell">
                {r.f(r.b)}
              </span>
              <span className={`v ${side}`} role="cell">
                {side === "even" ? verdict : (
                  <button type="button" className={`vb${open === r.m ? " on" : ""}`}
                    aria-expanded={open === r.m}
                    onClick={() => setOpen(open === r.m ? null : r.m)}>
                    {verdict}<span className="caret">{open === r.m ? " ▴" : " ▾"}</span>
                  </button>
                )}
              </span>
            </div>,
            open === r.m && fix && fix.side !== "even" && (
              <div key={`${r.k}-fix`} className="drawer" role="row">
                <div className="dh">
                  <span className="lk">To even up</span>
                  <span className="r">Cheapest single adds to {name(fix.side)} · star adjusted</span>
                </div>
                {fix.picks.length ? (
                  <ul className="opts">
                    {fix.picks.map(p => (
                      <li key={p.h.id}>
                        <span className="who">
                          <span className="nm">{p.h.label}</span>
                          <span className="sb">{p.h.sub}</span>
                        </span>
                        <span className="to">{Math.round(Math.abs(p.after.pct) * 100)}% from center</span>
                        <button type="button" className="go"
                          onClick={() => { onAdd(fix.side as Side, p.h.id); setOpen(null); }}>+ Add</button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="none">No single add gets {name(fix.side)} inside ±{Math.round(EVEN * 100)}%.</div>
                )}
              </div>
            ),
          ];
        })}
      </div>
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
          ["DVI", idx(led.raw.dvi)],
          ["CVI", idx(led.raw.cvi)],
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
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const nav = useNavigate();
  /* THE PICK LADDER AS A MAP, ONCE PER FEED. `marketNow` built `new Map(
     vals.picks.ktc)` on every call — once per SIDE per CARD, so a 150-trade
     ledger allocated ~300 copies of an 84-entry map on every render of the
     screen. `useGridCtx` builds it, the market feed and the at-trade read
     once, here, and every card's grid prices against that. */
  const ctx = useGridCtx();
  const who = useWho();
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  /** franchises in force — empty is every team. MULTI-SELECT like the season
   *  filter: a trade shows if ANY picked franchise was a side of it.
   *
   *  SEEDED FROM `?team=<rid>[,<rid>]` (Max, 2026-09-08): the Team screen's
   *  "All →" lands here already filtered to that franchise. Read once, at
   *  mount — the filter stays local after that, as it always was, so toggling
   *  a franchise does not rewrite the URL under the reader. */
  const [params] = useSearchParams();
  const [teamsOn, setTeamsOn] = useState<Set<number>>(() => new Set(
    (params.get("team") ?? "").split(",").map(Number).filter(n => Number.isInteger(n) && n > 0)));
  const toggleTeam = (rid: number) => setTeamsOn(prev => {
    const next = new Set(prev);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    return next;
  });
  /** ANY OR ALL of the ticked franchises (Max, 2026-10-27). Any is a trade
   *  with any ticked franchise on a side; all is a trade every ticked
   *  franchise was a side of — tick two and it is the deals between those
   *  two. Seeded from `?match=all`, local after that like the set itself. */
  const [teamMatch, setTeamMatch] = useState<"any" | "all">(
    () => (params.get("match") === "all" ? "all" : "any"));
  /** ONE PLAYER (Max, 2026-10-27): every deal he moved in, as a player or as
   *  the pick he became — a pick asset carries its drafted player's id, so
   *  "2024 1st → Brock Bowers" is a Bowers trade. Seeded from `?player=`. */
  const [playerOn, setPlayerOn] = useState<string | null>(() => params.get("player"));
  const [filtering, setFiltering] = useState<"team" | "season" | "player" | null>(null);
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

  /**
   * WHETHER ANY FOOTBALL HAS BEEN PLAYED SINCE — AT THE WEEK, NOT THE SEASON.
   *
   * A trade with no scored week behind it has no realized WAR, and 0.00 in
   * that column reads as "returned nothing" rather than as "has not happened".
   * The test was `Number(t.season) <= Number(latest)`, which is true of every
   * trade made this season including one made this morning: a deal struck in
   * week 2 with week 1 the last scored week printed "WAR edge 0.00", the one
   * thing the comment above `warEdge` says this column must never do.
   *
   * `useSeasonPhase` reads the roster season's matchups file — the same file
   * the League screen and More already hold — and states which week is in
   * progress. The last SCORED week is the one before it; in the playoffs every
   * regular week is scored, and in the offseason none of the roster season's
   * are. A season older than the newest one with results is played outright,
   * and a season newer than it is not; only the current one needs the week.
   */
  const phase = useSeasonPhase();
  const lastScored = phase.offseason ? 0
    : phase.playoffs ? phase.playoffStart - 1
      : (phase.week ?? 1) - 1;
  const played = (t: TradeT) => {
    const s = Number(t.season), newest = Number(phase.latest);
    if (s !== newest) return s < newest;
    // the week test only speaks for the season the phase was read from; while
    // the file is in flight, or if the two disagree, the season answer stands
    if (phase.loading || phase.rosterSeason !== phase.latest) return true;
    return Number(t.week) <= lastScored;
  };

  const rows = useMemo(() => trades
    .filter(t => (allSeasons || picked.has(t.season)) && t.sides.length >= 2)
    .slice()
    .sort((a, b) => b.ts - a.ts), [trades, picked, allSeasons]);
  const allTeams = teamsOn.size === 0;
  const both = teamMatch === "all" && teamsOn.size >= 2;
  const shown = useMemo(() => rows.filter(t =>
    (allTeams || (both
      ? [...teamsOn].every(r => t.sides.some(s => s.rid === r))
      : t.sides.some(s => teamsOn.has(s.rid))))
    && (!playerOn || t.sides.some(s => s.got.some(a => a.pid === playerOn)))),
  [rows, teamsOn, allTeams, both, playerOn]);
  /** every player who has moved in a deal, by name, for the player sheet —
   *  off the whole ledger, so the name of a filtered-in player resolves even
   *  under a season filter that leaves none of his trades */
  const traded = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const t of trades) {
      const seen = new Set<string>();
      for (const s of t.sides) for (const a of s.got) {
        if (!a.pid || seen.has(a.pid)) continue;
        seen.add(a.pid);
        const name = a.kind === "player" ? a.label : (a.label.split(" → ")[1] ?? a.label);
        const e = m.get(a.pid);
        if (e) e.n++; else m.set(a.pid, { name, n: 1 });
      }
    }
    return m;
  }, [trades]);
  const playerName = playerOn ? traded.get(playerOn)?.name ?? "Player" : null;
  const filtered = !allTeams || playerOn != null;
  const nameOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  const ownerOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.manager ?? nameOf(rid);
  const teamName = allTeams ? null
    // "between" names the two MANAGERS: two franchise names and a "vs" do
    // not fit a filter button on a phone, and the manager is the handle a
    // reader asking "what have these two done" is thinking in
    : both && teamsOn.size === 2
      ? [...teamsOn].map(r => teams?.find(t => t.roster_id === r)?.manager ?? nameOf(r)).join(" vs ")
      : teamsOn.size <= 2 ? [...teamsOn].map(nameOf).join(" · ")
      : `${teamsOn.size} teams${both ? " · all" : ""}`;

  return (
    <div className="trx-hist">
      <Band
        label={!filtered
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
            <button type="button" className={`trx-fil${playerOn ? " on" : ""}`}
              aria-haspopup="dialog" onClick={() => setFiltering("player")}>
              {playerName ?? "All players"}<span className="caret">▾</span>
            </button>
          </span>
        } />
      {/* THE LEDGER IS A FEED OF CARDS (Max, 2026-09-02), EACH ONE A GRID
          (2026-10-27). Every trade is open: sides across, measures down —
          what each side got, its realized WAR, its projected WAR, its KTC
          then → now — with each label printed once rather than once per side.
          The whole card is the way into the trade's own page, where every
          asset is followed to where it sits today; the WAR edge stays on the
          header line, naming its owner by manager. */}
      <div className="trx-feed">
        {shown.map(t => {
          const k = snapKey(t);
          const sides = t.sides.slice().sort((a, b) => a.rid - b.rid);
          const edge = warEdge(sides, played(t));
          const to = betaPath(`/trade/${tradeId(t)}`);
          const owner = edge.rid != null
            ? who(edge.rid, t.season, edge.owner ?? "").manager ?? edge.owner
            : edge.owner;
          return (
            /* THE CARD IS THE LINK. Not an <a>: the grid inside is a table,
               and a card-sized anchor around one reads as one giant link to a
               screen reader. A row's contract instead — role, tab stop,
               Enter — the same one TapRow keeps. */
            <article className={`trx-card${open === k ? " on" : ""}`} key={k}
              ref={open === k ? scrollTo : undefined}
              role="link" tabIndex={0} aria-label={`Trade of ${whenShort(t.ts)} ${t.season}: where it all went`}
              onClick={e => {
                if (e.metaKey || e.ctrlKey) { window.open(`#${to}`, "_blank"); return; }
                nav(to);
              }}
              onKeyDown={e => { if (e.key === "Enter") nav(to); }}>
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
                      <span className="n">{owner}</span>
                    </>}
                </span>
              </div>
              <TradeGrid t={t} ctx={ctx} who={who} owner={ownerOf} />
              <div className="trx-go">Where it went ›</div>
            </article>
          );
        })}
        {!shown.length && (
          <div className="empty">
            {playerOn || both
              ? "No trades match these filters."
              : allTeams
                ? (allSeasons ? "No trades on record." : "No trades in those seasons.")
                : `No ${allSeasons ? "" : `${seasonLabel} `}trades involving ${teamName}.`}
          </div>
        )}
      </div>

      <div className="tnote screen">{GRID_NOTE} Tap a trade for where everything in it went.</div>

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
          {/* HOW THE TICKED SET MATCHES. Two rows, always shown, so "between
              these two only" is findable before the second team is ticked. */}
          <SheetRow on={teamMatch === "any"} mark={teamMatch === "any" ? "On" : undefined}
            name="Any ticked team" meta="A trade any of them was in"
            onClick={() => setTeamMatch("any")} />
          <SheetRow on={teamMatch === "all"} mark={teamMatch === "all" ? "On" : undefined}
            name="Between ticked teams only" meta="Tick two: the deals between those two"
            onClick={() => setTeamMatch("all")} />
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
      {filtering === "player" && (
        <PlayerSheet traded={traded} on={playerOn}
          onPick={pid => { setPlayerOn(pid); setFiltering(null); }}
          onClose={() => setFiltering(null)} />
      )}
    </div>
  );
}

/**
 * Pick ONE player. A search over everyone who has moved in a deal, most-traded
 * first; the list is cut at 60 like the builder's asset sheet, because a
 * sheet re-rendering several hundred rows per keystroke janks a phone.
 */
function PlayerSheet({ traded, on, onPick, onClose }: {
  traded: Map<string, { name: string; n: number }>;
  on: string | null;
  onPick: (pid: string | null) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...traded.entries()]
      .filter(([, p]) => !needle || p.name.toLowerCase().includes(needle))
      .sort((a, b) => b[1].n - a[1].n || a[1].name.localeCompare(b[1].name));
  }, [traded, q]);
  return (
    <Sheet label="Filter by player" title="Player · pick one" onClose={onClose}>
      <div className="trx-psearch">
        <input type="search" autoFocus value={q} placeholder="Player"
          aria-label="Search players who have been traded"
          onChange={e => setQ(e.target.value)} />
      </div>
      <SheetRow on={on == null} mark={on == null ? "On" : undefined}
        name="All players" onClick={() => onPick(null)} />
      {hits.slice(0, 60).map(([pid, p]) => (
        <SheetRow key={pid} on={pid === on} mark={pid === on ? "On" : undefined}
          name={p.name} meta={`${p.n} trade${p.n === 1 ? "" : "s"}`}
          onClick={() => onPick(pid)} />
      ))}
      {!hits.length && <div className="trx-pempty">No traded player matches “{q}”.</div>}
    </Sheet>
  );
}
