import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { PickValues, Trade as TradeT, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { fmt, sgn } from "../../lib/stats";
import { POS_COLOR } from "../../lib/league";
import { useAssets, type Asset } from "../model";
import { Band, IdLines, Ledger, LedgerRow, LEDGER_GUARDRAIL, NUL, PosSpine } from "../ui";
import {
  makePickIndexer, parsePick, tradeLedger,
  type PickIndexer, type PricedAsset, type ValueBridge,
} from "../../lib/tradeModel";

/**
 * TRADE — is this fair.
 *
 * TEAM-AGNOSTIC, AND THAT IS THE DESIGN (decision #13). Two bare baskets,
 * "Side A gets / Side B gets", no team pickers anywhere. The real use is
 * league-wide evaluation — you are weighing a package, not negotiating with a
 * roster — and a team picker turns a scale into a negotiation, then invites the
 * question of whose posture to tilt by.
 *
 * THE LEDGER STATES; IT DOES NOT JUDGE (decision #14). Three rows across three
 * currencies: the raw net to Side A, the consolidation adjustment, and the
 * adjusted net. No winner column, no verdict sentence, no combined score, and
 * no colour on any figure — DVI and CVI answer different questions and
 * routinely point at different sides, so a single number would be inventing
 * agreement and a green total would be declaring a winner in CSS.
 *
 * ALL THE MATHS IS IN `lib/tradeModel`. This file decides layout and formatting
 * and nothing else: which figure carries a thousands separator, which carries a
 * decimal, which row is the headline. The consolidation curve, the pick index
 * estimate and the arithmetic that ties `net + adj = adjusted net` are over
 * there, dependency-free, under `tests/tradeModel.test.ts`.
 *
 * This deliberately supersedes the classic Trade Calculator's shape (one pinned
 * basket shopped against many offers, deltas coloured on both sides). That
 * screen answers "which of these returns is best for me"; this one answers "is
 * this deal fair", and the second question has no me in it.
 */

type Side = "a" | "b";

/** A signed market figure with the thousands separator the unsigned totals
 *  above it already carry — `sgn` is a WAR/index formatter and drops it, which
 *  put "6,388" and "−4351" in the same column. */
const sgnMarket = (v: number) =>
  `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.round(Math.abs(v)).toLocaleString()}`;

/** an unsigned market figure — the in/out qualifier under the net row */
const mkt = (v: number) => Math.round(v).toLocaleString();

/** an index figure in the ledger. One decimal: DVI and CVI are 0–100 scales
 *  where a whole point is a real difference and a hundredth is noise. */
const idx = (v: number) => sgn(v, 1);

export default function Trade() {
  const assets = useAssets();
  const tradesFile = useJson<TradesPayload>("trades.json").data;
  // Bridge B, market-implied: per-band, per-year WAR streams keyed by exactly
  // the labels `useAssets()` gives picks. Committed and deployed; this is the
  // first reader on the front end.
  const bridge = useJson<ValueBridge>("value_bridge.json", "leagueDaily").data;
  // only for the calendar — which rookie class drafts now, i.e. which year is
  // lag 0. Same expression `model.ts` uses to LABEL the current class, so the
  // two cannot drift apart.
  const pv = useJson<PickValues>("pick_values.json", "leagueDaily").data;
  const [params, setParams] = useSearchParams();

  const [a, setA] = useState<string[]>([]);
  const [b, setB] = useState<string[]>([]);
  const [picking, setPicking] = useState<Side | null>(null);
  const [loadedNote, setLoadedNote] = useState<string | null>(null);

  const byKey = useMemo(
    () => new Map((assets ?? []).map(x => [x.key, x])), [assets]);

  /* ---- the pick index estimator ------------------------------------------ */
  /**
   * Fit once per data load, not once per render: `makePickIndexer` runs a
   * monotone fit over the whole priced field (~370 players) to build the
   * KTC→DVI and KTC→CVI ladders it evaluates picks on.
   *
   * Null until the field and the bridge are both in hand, and null forever if
   * either is missing — at which point the ledger falls back to what it did
   * before, which is to leave picks out of the index columns. The estimate is
   * marked wherever it appears (see `Basket`); an estimated index rendered
   * identically to a computed one is a lie of typography.
   */
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

  /* ---- tap-load a historical trade, re-priced at today's values ---------- */
  const trades = useMemo(
    () => tradesFile ? (Array.isArray(tradesFile) ? tradesFile : tradesFile.trades) : null,
    [tradesFile]);

  const load = useCallback((ts: number) => {
    const t = trades?.find(x => x.ts === ts);
    if (!t || !assets) return;
    const known = new Set(assets.map(x => x.key));
    // Three cases, and each is a different fact:
    //  - a player, or a pick that has since CONVERTED, is re-priced as the
    //    player he is today. That is what "who actually won that deal" means.
    //  - a pick still outstanding has no player, so it maps to the generic tier
    //    asset. Mid, uniformly — the slot depends on a finish nobody knows yet,
    //    the same assumption the Team screen's draft-capital band states.
    //  - FAAB has nothing to price at all and is dropped, which the note says.
    const FUTURE = /(\d{4})\s+(1st|2nd|3rd|4th)/;
    const map = (side: typeof t.sides[number]) => {
      let dropped = 0;
      const out: string[] = [];
      for (const g of side.got) {
        let k: string | null = g.pid ? `p${g.pid}` : null;
        if (!k && g.kind === "pick") {
          const m = FUTURE.exec(g.label);
          if (m) k = `k${m[1]} Mid ${m[2]}`;
        }
        if (k && known.has(k)) out.push(k); else dropped++;
      }
      return { out, dropped };
    };
    const A = map(t.sides[0]), B = map(t.sides[1] ?? t.sides[0]);
    setA(A.out); setB(B.out);
    const extra = t.sides.length > 2 ? ` · ${t.sides.length}-team deal, first two sides shown` : "";
    const lost = A.dropped + B.dropped;
    setLoadedNote(
      `${t.sides[0].team} / ${t.sides[1]?.team ?? "—"} · ${t.season} wk ${t.week}` +
      (lost ? ` · ${lost} asset${lost > 1 ? "s" : ""} dropped (FAAB has no price)` : "") +
      extra);
    window.scrollTo(0, 0);
  }, [trades, assets]);

  // the League screen's activity cards link in with ?load=<ts>. The param is
  // consumed and dropped, so a refresh doesn't re-load a basket the reader has
  // since edited.
  const wantTs = params.get("load");
  useEffect(() => {
    if (!wantTs || !trades || !assets) return;
    load(Number(wantTs));
    setParams(p => { const n = new URLSearchParams(p); n.delete("load"); return n; },
      { replace: true });
  }, [wantTs, trades, assets, load, setParams]);

  const list = (s: Side) => (s === "a" ? a : b);
  const setList = (s: Side, v: string[]) => (s === "a" ? setA(v) : setB(v));
  const add = (s: Side, key: string) => {
    const cur = list(s);
    if (!cur.includes(key)) setList(s, [...cur, key]);
    setLoadedNote(null);
  };
  const remove = (s: Side, key: string) => {
    setList(s, list(s).filter(k => k !== key));
    setLoadedNote(null);
  };

  const rowsA = useMemo(
    () => a.map(k => byKey.get(k)).filter((x): x is Asset => !!x), [a, byKey]);
  const rowsB = useMemo(
    () => b.map(k => byKey.get(k)).filter((x): x is Asset => !!x), [b, byKey]);

  /**
   * THE WHOLE LEDGER, in one call. `Asset` is structurally a `LedgerAsset`,
   * which is the point of that interface: the trade maths takes what
   * `useAssets()` already produces and never imports it.
   */
  const led = useMemo(
    () => tradeLedger(rowsA, rowsB, indexer), [rowsA, rowsB, indexer]);

  // the priced rows come back in the order they went in, so the baskets can
  // show each asset beside its own estimate flag
  const viewA = rowsA.map((x, i) => ({ a: x, p: led.a.rows[i] }));
  const viewB = rowsB.map((x, i) => ({ a: x, p: led.b.rows[i] }));
  const any = rowsA.length + rowsB.length > 0;

  return (
    <>
      <div className="v3-head">
        <h1>Trade</h1>
        <span className="sub">a scale, not a negotiation</span>
      </div>

      <div className="v3-sides">
        <Basket side="a" rows={viewA} onAdd={() => setPicking("a")}
          onRemove={k => remove("a", k)} />
        <Basket side="b" rows={viewB} onAdd={() => setPicking("b")}
          onRemove={k => remove("b", k)} />
      </div>

      {any ? (
        /* Three rows, and the middle one is the whole of `TRADE_MACHINE_MODEL.md`
           §1: the consolidation adjustment is SHOWN, on its own line, and never
           smuggled into the total below it. `net + adj = adjusted net` reads off
           the page, which is what lets a reader disagree with the correction and
           still use the board. Figures only — no prose, no fourth currency in a
           caption, no winner. */
        <Ledger columns={["Market", "DVI", "CVI"]} caption={LEDGER_GUARDRAIL}>
          <LedgerRow label="Net to Side A"
            sub={`in ${mkt(led.a.raw.market)} · out ${mkt(led.b.raw.market)}`}
            values={[sgnMarket(led.net.market), idx(led.net.dvi), idx(led.net.cvi)]} />
          <LedgerRow label="Consolidation adj" tone="adj"
            values={[sgnMarket(led.adj.market), idx(led.adj.dvi), idx(led.adj.cvi)]} />
          <LedgerRow label="Adjusted net" tone="net"
            values={[sgnMarket(led.adjNet.market), idx(led.adjNet.dvi), idx(led.adjNet.cvi)]} />
        </Ledger>
      ) : (
        <div className="tnote screen">
          Put anything on either side — any player the model prices, plus every pick slot and
          future tier. There are no team pickers: this weighs a package, it does not negotiate
          with a roster.
        </div>
      )}

      {loadedNote && (
        /* Context, not a conclusion. This was `.verdict` — the classic board's
           accent-slab block, built to frame a verdict — on the one screen whose
           governing decision is that there is no verdict. */
        <div className="v3-note">
          <div className="k">Loaded from the ledger</div>
          <div className="meta">{loadedNote}</div>
          <div className="body">
            Re-priced at today's values, not at the values on the day. Team names survive as
            this caption only — once it is in the machine it is two baskets like any other.
          </div>
        </div>
      )}

      <RecentTrades trades={trades} onLoad={load} />

      {picking && assets && (
        <Picker assets={assets} side={picking} indexer={indexer}
          onPick={k => add(picking, k)} onClose={() => setPicking(null)} />
      )}
    </>
  );
}

/* ---- a basket ------------------------------------------------------------ */

/** the sub-line under an asset's name, in a basket or in the picker */
function assetSub(x: Asset): string {
  const parts = x.kind === "pick"
    ? ["Pick"]
    : [x.nfl || null, x.pos].filter(Boolean) as string[];
  if (x.ktc != null) parts.push(x.ktc.toLocaleString());
  return parts.join(" · ");
}

interface BasketRow { a: Asset; p: PricedAsset | undefined }

function Basket({ side, rows, onAdd, onRemove }: {
  side: Side; rows: BasketRow[]; onAdd: () => void; onRemove: (key: string) => void;
}) {
  return (
    <div className="v3-side">
      <div className="sh">
        <span className="k">Side {side.toUpperCase()} gets</span>
        <span className="n">{rows.length || ""}</span>
      </div>
      {rows.map(({ a: x, p }) => (
        <div className="asset" key={x.key}>
          <PosSpine color={POS_COLOR[x.pos]} />
          {/* THE ESTIMATE MARK. A pick's DVI and CVI are estimated from its
              market price and its stream's timing, not computed from a
              projection the way a player's are, and the ledger's index columns
              now include them. Marking it here rather than in the caption keeps
              the guardrail note to the one sentence the design system requires,
              and puts the qualifier on the asset it qualifies. */}
          <IdLines name={x.label} sub={assetSub(x)}
            tags={p?.estimated ? ["≈ est"] : undefined} />
          <button className="x" aria-label={`Remove ${x.label}`}
            onClick={() => onRemove(x.key)}>×</button>
        </div>
      ))}
      {!rows.length && <div className="empty2">Nothing yet.</div>}
      <button className="addbtn" onClick={onAdd}>+ Add</button>
    </div>
  );
}

/* ---- the asset picker ---------------------------------------------------- */

/** the picker's population filter. `all` keeps the old cold behaviour. */
const SCOPES = [
  { id: "all", label: "All" },
  { id: "players", label: "Players" },
  { id: "picks", label: "Picks" },
] as const;
type Scope = typeof SCOPES[number]["id"];

const TIER_ORD: Record<string, number> = { Early: 0, Mid: 1, Late: 2 };

/**
 * Full-screen on a phone, because a list of ~900 players is not a dropdown.
 *
 * This is also the answer to the open question the redesign left on
 * "add-from-anywhere": a per-row `+` costs width on every table on the site and
 * a long-press is invisible. The Add button lives here, where the reader is
 * already thinking about a trade, and the picker searches the same population
 * every board ranks.
 *
 * THE SCOPE SEGMENT EXISTS BECAUSE PICKS WERE UNREACHABLE. Decision #6 says the
 * add flow searches "full pool + generic pick bands", and it did — but the cold
 * list is KTC-descending and capped, and every pick prices below the top 120
 * players, so with an empty query not one pick was visible and a reader had to
 * already know the label ("2027 Mid 1st") to type it. A band nobody can find is
 * a band that is not in the machine.
 */
function Picker({ assets, side, indexer, onPick, onClose }: {
  assets: Asset[]; side: Side; indexer: PickIndexer | null;
  onPick: (key: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let pool = assets;
    if (scope !== "all")
      pool = pool.filter(x => (scope === "picks") === (x.kind === "pick"));
    if (needle) pool = pool.filter(x => x.label.toLowerCase().includes(needle));

    // Picks sort by the CALENDAR, not by price. A pick board is read in draft
    // order — year, then round, then Early/Mid/Late — and KTC-descending
    // interleaves three draft classes into a list nobody can scan. Players keep
    // price-descending, which is what makes that list useful cold.
    if (scope === "picks") {
      const key = (x: Asset): [number, number, number, string] => {
        const r = parsePick(x.label);
        return r ? [r.year, r.round, TIER_ORD[r.tier] ?? 3, x.label] : [9999, 9, 9, x.label];
      };
      return pool.slice().sort((x, y) => {
        const kx = key(x), ky = key(y);
        for (let i = 0; i < 3; i++)
          if (kx[i] !== ky[i]) return (kx[i] as number) - (ky[i] as number);
        return x.label.localeCompare(y.label);
      // the whole pick board is ~70 rows (one class by slot, plus two future
      // years by band), so this cap never bites — it is a guard against a
      // league that owns picks a decade out, not a truncation
      }).slice(0, 400);
    }
    // no query: the most valuable things first, so the list is useful cold
    return pool.slice().sort((x, y) => (y.ktc ?? -1) - (x.ktc ?? -1)).slice(0, 120);
  }, [assets, q, scope]);

  return (
    <div className="v3-pick" role="dialog" aria-label={`Add to side ${side.toUpperCase()}`}>
      <div className="ph">
        <input type="search" autoFocus value={q} placeholder="Player or pick"
          onChange={e => setQ(e.target.value)} />
        <button className="x" onClick={onClose}>Done</button>
      </div>
      <div className="pfil">
        <div className="sidebtns" role="group" aria-label="Population">
          {SCOPES.map(s => (
            <button key={s.id} className={scope === s.id ? "on" : ""}
              aria-pressed={scope === s.id} onClick={() => setScope(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      <div className="plist">
        {rows.map(x => {
          // a pick's index is the estimate, and it says so
          const e = x.kind === "pick" && indexer ? indexer(x.label, x.ktc) : null;
          const dvi = x.dvi != null ? `DVI ${fmt(x.dvi, 1)}`
            : e ? `DVI ≈ ${fmt(e.dvi, 1)}` : null;
          const sub = [
            x.kind === "pick" ? "Pick" : [x.nfl || null, x.pos].filter(Boolean).join(" · "),
            dvi,
          ].filter(Boolean).join(" · ");
          return (
            <button className="prow" key={x.key} onClick={() => { onPick(x.key); setQ(""); }}>
              <PosSpine color={POS_COLOR[x.pos]} />
              <IdLines name={x.label} sub={sub} />
              <span className="v">{x.ktc == null ? NUL : x.ktc.toLocaleString()}</span>
            </button>
          );
        })}
        {!rows.length && (
          <div className="empty">
            {q ? <>Nothing matches “{q}”.</> : "Nothing in this scope."}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- recent league trades, tap-loadable ---------------------------------- */

function RecentTrades({ trades, onLoad }: {
  trades: TradeT[] | null; onLoad: (ts: number) => void;
}) {
  const list = useMemo(
    () => trades ? trades.slice().sort((a, b) => b.ts - a.ts).slice(0, 8) : null,
    [trades]);
  return (
    <>
      <Band label="From the ledger" note="Tap to load, re-priced at today's values" />
      <div className="v3-feed">
        {!list && <div className="empty">Loading…</div>}
        {(list ?? []).map(t => (
          <button className="v3-act tap" key={t.ts} onClick={() => onLoad(t.ts)}>
            <div className="when">
              <span>{t.season} · wk {t.week}</span>
              <span className="go">Load →</span>
            </div>
            <div className="v3-baskets">
              {t.sides.map((s, i) => (
                <div className="bk" key={i}>
                  <div className="who">{s.team} gets</div>
                  {s.got.map((g, j) => (
                    <div className={`it${g.kind !== "player" ? " pick" : ""}`} key={j}>{g.label}</div>
                  ))}
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
