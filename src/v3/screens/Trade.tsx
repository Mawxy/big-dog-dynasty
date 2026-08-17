import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Trade as TradeT, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { fmt, sgn, sgnWar } from "../../lib/stats";
import { POS_COLOR } from "../../lib/league";
import { useAssets, type Asset } from "../model";
import { Band, NUL } from "../ui";

/**
 * TRADE — is this fair.
 *
 * TEAM-AGNOSTIC, AND THAT IS THE DESIGN (decision #13). Two bare baskets,
 * "Side A gets / Side B gets", no team pickers anywhere. The real use is
 * league-wide evaluation — you are weighing a package, not negotiating with a
 * roster — and a team picker turns a scale into a negotiation, then invites the
 * question of whose posture to tilt by.
 *
 * THE LEDGER STATES; IT DOES NOT JUDGE (decision #14). One row, "Net to Side
 * A", across three currencies, with the in and out totals above it. There is no
 * winner column, no verdict sentence and no combined score. DVI and CVI answer
 * different questions and routinely point at different sides — collapsing that
 * into one number would be inventing agreement.
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

export default function Trade() {
  const assets = useAssets();
  const tradesFile = useJson<TradesPayload>("trades.json").data;
  const [params, setParams] = useSearchParams();

  const [a, setA] = useState<string[]>([]);
  const [b, setB] = useState<string[]>([]);
  const [picking, setPicking] = useState<Side | null>(null);
  const [loadedNote, setLoadedNote] = useState<string | null>(null);

  const byKey = useMemo(
    () => new Map((assets ?? []).map(x => [x.key, x])), [assets]);

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

  const rowsA = a.map(k => byKey.get(k)).filter((x): x is Asset => !!x);
  const rowsB = b.map(k => byKey.get(k)).filter((x): x is Asset => !!x);

  const tot = (rows: Asset[]) => ({
    market: rows.reduce((s, x) => s + (x.ktc ?? 0), 0),
    dvi: rows.reduce((s, x) => s + (x.dvi ?? 0), 0),
    cvi: rows.reduce((s, x) => s + (x.cvi ?? 0), 0),
    war: rows.reduce((s, x) => s + (x.war ?? 0), 0),
    picks: rows.filter(x => x.kind === "pick").length,
  });
  const tA = tot(rowsA), tB = tot(rowsB);
  const any = rowsA.length + rowsB.length > 0;
  const anyPicks = tA.picks + tB.picks > 0;

  return (
    <>
      <div className="v3-head">
        <h1>Trade</h1>
        <span className="sub">a scale, not a negotiation</span>
      </div>

      <div className="v3-sides">
        <Basket side="a" rows={rowsA} onAdd={() => setPicking("a")}
          onRemove={k => remove("a", k)} />
        <Basket side="b" rows={rowsB} onAdd={() => setPicking("b")}
          onRemove={k => remove("b", k)} />
      </div>

      {any ? (
        <div className="v3-ledger">
          <div className="lk">Ledger</div>
          <table>
            <thead>
              <tr>
                <th className="t" style={{ width: "28%" }} />
                <th>Market</th><th>DVI</th><th>CVI</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="t">A gets</td>
                <td><span className="sm">{Math.round(tA.market).toLocaleString()}</span></td>
                <td><span className="sm">{fmt(tA.dvi, 1)}</span></td>
                <td><span className="sm">{fmt(tA.cvi, 1)}</span></td>
              </tr>
              <tr>
                <td className="t">B gets</td>
                <td><span className="sm">{Math.round(tB.market).toLocaleString()}</span></td>
                <td><span className="sm">{fmt(tB.dvi, 1)}</span></td>
                <td><span className="sm">{fmt(tB.cvi, 1)}</span></td>
              </tr>
              <tr>
                <td className="t">Net to A</td>
                <td><span className="big">{sgnMarket(tA.market - tB.market)}</span></td>
                <td><span className="big">{sgn(tA.dvi - tB.dvi, 1)}</span></td>
                <td><span className="big">{sgn(tA.cvi - tB.cvi, 1)}</span></td>
              </tr>
            </tbody>
          </table>
          {/* The one guardrail caption the design system requires on this
              pattern. An index gap is not a price gap and must never be read
              as one. */}
          <div className="tnote">
            DVI and CVI are index points, not value.
            {anyPicks && " Picks carry a market price but no index — there is no player to " +
              "project until the pick converts, so the DVI and CVI columns above are the " +
              "players only."}
            {" "}Projected WAR: {sgnWar(tA.war - tB.war)} to A.
          </div>
        </div>
      ) : (
        <div className="tnote screen">
          Put anything on either side — any player the model prices, plus every pick slot and
          future tier. There are no team pickers: this weighs a package, it does not negotiate
          with a roster.
        </div>
      )}

      {loadedNote && (
        <div className="verdict">
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
        <Picker assets={assets} side={picking}
          onPick={k => add(picking, k)} onClose={() => setPicking(null)} />
      )}
    </>
  );
}

/* ---- a basket ------------------------------------------------------------ */

function Basket({ side, rows, onAdd, onRemove }: {
  side: Side; rows: Asset[]; onAdd: () => void; onRemove: (key: string) => void;
}) {
  return (
    <div className="v3-side">
      <div className="sh">
        <span className="k">Side {side.toUpperCase()} gets</span>
        <span className="n">{rows.length || ""}</span>
      </div>
      {rows.map(x => (
        <div className="asset" key={x.key}>
          <span className="spine" style={{
            flex: "0 0 3px", alignSelf: "stretch",
            background: POS_COLOR[x.pos] ?? "var(--rule-2)",
          }} />
          <div className="nm">
            <div className="n1">{x.label}</div>
            <div className="n2">
              {x.kind === "pick" ? "Pick" : [x.nfl || null, x.pos].filter(Boolean).join(" · ")}
              {x.ktc != null && ` · ${x.ktc.toLocaleString()}`}
            </div>
          </div>
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

/**
 * Full-screen on a phone, because a list of ~900 players is not a dropdown.
 *
 * This is also the answer to the open question the redesign left on
 * "add-from-anywhere": a per-row `+` costs width on every table on the site and
 * a long-press is invisible. The Add button lives here, where the reader is
 * already thinking about a trade, and the picker searches the same population
 * every board ranks.
 */
function Picker({ assets, side, onPick, onClose }: {
  assets: Asset[]; side: Side; onPick: (key: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = needle
      ? assets.filter(x => x.label.toLowerCase().includes(needle))
      : assets;
    // no query: the most valuable things first, so the list is useful cold
    return pool.slice().sort((x, y) => (y.ktc ?? -1) - (x.ktc ?? -1)).slice(0, 120);
  }, [assets, q]);
  return (
    <div className="v3-pick" role="dialog" aria-label={`Add to side ${side.toUpperCase()}`}>
      <div className="ph">
        <input type="search" autoFocus value={q} placeholder="Player or pick"
          onChange={e => setQ(e.target.value)} />
        <button className="x" onClick={onClose}>Done</button>
      </div>
      <div className="plist">
        {rows.map(x => (
          <button className="prow" key={x.key} onClick={() => { onPick(x.key); setQ(""); }}>
            <span className="spine" style={{
              flex: "0 0 3px", alignSelf: "stretch",
              background: POS_COLOR[x.pos] ?? "var(--rule-2)",
            }} />
            <span className="nm">
              <span className="n1">{x.label}</span>
              <span className="n2">
                {x.kind === "pick" ? "Pick" : [x.nfl || null, x.pos].filter(Boolean).join(" · ")}
                {x.dvi != null && ` · DVI ${fmt(x.dvi, 1)}`}
              </span>
            </span>
            <span className="v">{x.ktc == null ? NUL : x.ktc.toLocaleString()}</span>
          </button>
        ))}
        {!rows.length && <div className="empty">Nothing matches “{q}”.</div>}
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
          <button className="v3-act" key={t.ts} onClick={() => onLoad(t.ts)}
            style={{ display: "block", width: "100%", textAlign: "left",
              background: "none", border: 0, borderBottom: "1px solid var(--hair)",
              color: "inherit", cursor: "pointer" }}>
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
