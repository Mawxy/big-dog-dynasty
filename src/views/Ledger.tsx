import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TradeSide, TradesPayload, Values } from "../lib/types";
import { useJson } from "../lib/useJson";
import { readTrades, tradeWhen } from "../lib/trades";
import { fmtWar, sgn, sgnWar } from "../lib/stats";
import { useLeague, useLeaguePath } from "../lib/context";
import { ktcOf } from "../lib/values";
import TradeCard, { sideRealized } from "../components/TradeCard";

/**
 * Trade ledger — every trade, each side scored on the WAR its return actually
 * produced. The other half of the Trade tab's machine/ledger lens: the
 * calculator (views/Trades.tsx) is the tab's default face and this is one
 * segment flip away. Still its own route so the League dashboard's activity
 * module and any old link land here directly.
 */
export default function Ledger() {
  const { meta, players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  // current market, for the drawer's change-since-trade read
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const file = useJson<TradesPayload>("trades.json");
  const err = file.error;
  // readTrades, not an inline Array.isArray: a TradesFile written without its
  // `trades` key left state undefined here and the page stuck on "Loading".
  const trades = useMemo(
    () => (file.data ? readTrades(file.data).trades : null), [file.data]);

  const cards = useMemo(() => {
    if (!trades) return [];
    return trades
      .filter(t => t.sides.length >= 2)
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((t, i) => {
        const [A, B] = t.sides;
        const aw = sideRealized(A), bw = sideRealized(B);
        let verdict = "Even so far", cls = "", vcolor = "var(--dim)";
        if (aw != null && bw != null && Math.abs(aw - bw) > 0.15) {
          verdict = `${aw > bw ? A.team : B.team} ahead by ${fmtWar(Math.abs(aw - bw))} WAR`;
          cls = "win"; vcolor = "var(--good)";
        } else if (aw != null && bw == null) {
          verdict = `${A.team} banked ${fmtWar(aw)} WAR · ${B.team} took picks`; cls = "pick"; vcolor = "var(--acc)";
        } else if (bw != null && aw == null) {
          verdict = `${B.team} banked ${fmtWar(bw)} WAR · ${A.team} took picks`; cls = "pick"; vcolor = "var(--acc)";
        }
        // ts is a Sleeper transaction timestamp and two trades processed in the
        // same batch share it — a bare ts as the React key collided and the two
        // cards traded contents on any re-render. Composite with the index, the
        // way the franchise page's trade list already does it.
        return { key: `${t.ts}-${i}`, trade: t, when: tradeWhen(t.ts), verdict, cls, vcolor };
      });
  }, [trades]);

  /**
   * Team filter — MULTI-select, so "show me every deal between these two
   * rivals" is one screen. Keyed by roster_id (the franchise), labeled by the
   * newest name that franchise has traded under; an empty selection means
   * everyone, so the default view is unchanged.
   */
  const [teamSel, setTeamSel] = useState<Set<number>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  /** which trade's drawer is open — one at a time keeps the detail beside
   *  the card that opened it */
  const [openKey, setOpenKey] = useState<string | null>(null);

  /** current mid-tier pick prices by "YYYY Mid Nth", from values.json —
   *  mirrors the canonical keying the pipeline snapshots use */
  const ORDW = ["", "1st", "2nd", "3rd", "4th", "5th"];
  const pickNow = useMemo(() => {
    const m = new Map<string, { ktc?: number; fc?: number }>();
    for (const [label, v] of vals?.picks?.ktc ?? []) {
      const g = /^(20\d\d) Mid (\d\w\w)$/.exec(label);
      if (g) m.set(`${g[1]} Mid ${g[2]}`, { ...m.get(`${g[1]} Mid ${g[2]}`), ktc: v });
    }
    for (const [label, v] of vals?.picks?.fc ?? []) {
      const g = /^(20\d\d) (\d\w\w)( \(Mid\))?$/.exec(label);
      if (!g) continue;
      const key = `${g[1]} Mid ${g[2]}`;
      const cur = m.get(key) ?? {};
      if (g[3] || cur.fc == null) m.set(key, { ...cur, fc: v });
    }
    return m;
  }, [vals]);

  /** a side's CURRENT market sums. A converted pick prices as the player it
   *  became (the draft-day splice); an unconverted one as the mid-tier pick
   *  it still is. Each source goes null when it can't price every asset. */
  const marketNow = (s: TradeSide): { ktc: number | null; fc: number | null } => {
    if (!vals) return { ktc: null, fc: null };
    let ktc: number | null = 0, fc: number | null = 0;
    for (const a of s.got) {
      if (a.kind === "faab") continue;
      let k: number | null | undefined, f: number | null | undefined;
      if (a.pid) {
        const row = vals.players[a.pid];
        k = ktcOf(row, meta.tep); f = row?.fc;
      } else if (a.kind === "pick" && a.ps && a.rnd) {
        const p = pickNow.get(`${a.ps} Mid ${ORDW[a.rnd] ?? `${a.rnd}th`}`);
        k = p?.ktc; f = p?.fc;
      } else {
        return { ktc: null, fc: null };
      }
      ktc = ktc == null || k == null ? null : ktc + k;
      fc = fc == null || f == null ? null : fc + f;
    }
    return { ktc: ktc || null, fc: fc || null };
  };

  /** one drawer row: "KTC · 5,120 → 6,340 · +1,220" */
  const marketRow = (label: string, then: number | null | undefined, now: number | null) => {
    const known = then != null && now != null;
    return (
      <div className="drawer-row" key={label}>
        <span className="k">{label}</span>
        <span className="v" style={{ color: known ? "var(--txt2)" : "var(--dim3)" }}>
          {then != null ? then.toLocaleString("en-US") : "—"}
          {" → "}
          {now != null ? now.toLocaleString("en-US") : "—"}
        </span>
        <span className="d" style={{
          color: !known ? "var(--dim3)" : now - then > 0 ? "var(--good)" : now - then < 0 ? "var(--bad)" : "var(--dim)",
        }}>
          {known ? sgn(now - then, 0) : "—"}
        </span>
      </div>
    );
  };
  const teams = useMemo(() => {
    const seen = new Map<number, string>();       // newest-first cards: first name wins
    for (const c of cards)
      for (const s of c.trade.sides)
        if (!seen.has(s.rid)) seen.set(s.rid, s.team);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [cards]);
  const shown = useMemo(
    () => teamSel.size
      ? cards.filter(c => c.trade.sides.some(s => teamSel.has(s.rid)))
      : cards,
    [cards, teamSel]);
  const toggle = (rid: number) => setTeamSel(prev => {
    const next = new Set(prev);
    if (next.has(rid)) next.delete(rid); else next.add(rid);
    return next;
  });

  if (err) return <div className="empty">No trade data yet.</div>;
  if (!trades) return <div className="empty">Loading trades…</div>;
  if (!cards.length) return <div className="empty">No trades recorded.</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Trade ledger</span>
        <span className="screen-note"><b>{cards.length}</b> trades</span>
      </div>
      <div className="lens" role="tablist" aria-label="Trade machine or ledger">
        <button type="button" className="seg" role="tab" aria-selected="false"
          onClick={() => nav(lp("/trades"))}>
          Trade machine
        </button>
        <button type="button" className="seg on" role="tab" aria-selected="true">
          Ledger
        </button>
      </div>
      {/* team filter: one dropdown, twelve checkable rows. Multi-select, so
          deliberately NOT the lens pattern (single selection) and not a
          native <select multiple> (unstylable). None checked = everyone. */}
      <div className="tdrop">
        <button type="button" className="tdrop-btn" aria-haspopup="listbox"
          aria-expanded={filterOpen} onClick={() => setFilterOpen(o => !o)}>
          Teams
          <span className="n">{teamSel.size ? `${teamSel.size} selected` : "all"}</span>
          <span aria-hidden="true" style={{ fontSize: 10, opacity: .75 }}>▾</span>
        </button>
        {filterOpen && <>
          <div className="tdrop-backdrop" onClick={() => setFilterOpen(false)} />
          <div className="tdrop-menu" role="listbox" aria-multiselectable="true"
            aria-label="Filter trades by team">
            <button type="button" className="tdrop-row" role="option"
              aria-selected={!teamSel.size}
              onClick={() => { setTeamSel(new Set()); setFilterOpen(false); }}>
              All teams
              <span className="ck">{teamSel.size ? "" : "✓"}</span>
            </button>
            {teams.map(([rid, name]) => (
              <button key={rid} type="button" className="tdrop-row" role="option"
                aria-selected={teamSel.has(rid)} onClick={() => toggle(rid)}>
                {name}
                <span className="ck">{teamSel.has(rid) ? "✓" : ""}</span>
              </button>
            ))}
          </div>
        </>}
      </div>
      <div className="band">
        <span className="band-label">
          {teamSel.size ? `${shown.length} of ${cards.length} trades` : "Every trade"} · newest first
        </span>
        <span className="band-note">
          Each side priced as the market and the model saw it at trade time · Details opens the
          change since · both sides in the same neutral ink
        </span>
      </div>
      <div className="ledger" style={{ paddingTop: 14 }}>
        {shown.map(c => (
          <TradeCard key={c.key} trade={c.trade} players={players} cls={c.cls}
            when={c.when} verdict={c.verdict} verdictColor={c.vcolor}
            sideFig="market"
            open={openKey === c.key}
            onToggle={() => setOpenKey(k => k === c.key ? null : c.key)}
            drawer={
              <div className="trade-drawer">
                {c.trade.sides.map(s => {
                  const now = marketNow(s);
                  return (
                    <div key={s.rid} className="drawer-side">
                      <div className="drawer-team">{s.team}</div>
                      {marketRow("KTC since trade", s.mktThen, now.ktc)}
                      {marketRow("FC since trade", s.fcThen, now.fc)}
                      <div className="drawer-row">
                        <span className="k">Realized WAR</span>
                        <span className="v">{sideRealized(s) == null ? "—" : fmtWar(s.war)}</span>
                        <span className="d" style={{ color: "var(--dim)" }}>
                          {sgnWar(s.future ?? 0)} to come
                        </span>
                      </div>
                      {/* the draft-day splice, per converted pick: what the
                          slot cost as a pick vs what the player it became is
                          worth now (KTC) */}
                      {s.got.filter(a => a.kind === "pick" && a.pid && a.mktDraft != null).map((a, i) => {
                        const nowV = a.pid ? ktcOf(vals?.players[a.pid], meta.tep) : null;
                        const known = a.mktDraft != null && nowV != null;
                        return (
                          <div className="drawer-row" key={`pk${i}`}>
                            <span className="k">{a.label.split(" → ")[0]} at draft</span>
                            <span className="v" style={{ color: known ? "var(--txt2)" : "var(--dim3)" }}>
                              {a.mktDraft!.toLocaleString("en-US")}
                              {" → "}
                              {nowV != null ? nowV.toLocaleString("en-US") : "—"}
                            </span>
                            <span className="d" style={{
                              color: !known ? "var(--dim3)"
                                : nowV! - a.mktDraft! > 0 ? "var(--good)"
                                  : nowV! - a.mktDraft! < 0 ? "var(--bad)" : "var(--dim)",
                            }}>
                              {known ? sgn(nowV! - a.mktDraft!, 0) : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            } />
        ))}
        {!shown.length && <div className="empty">No trades between the selected teams.</div>}
      </div>
      <div className="tnote screen">
        FC/KTC then and Proj WAR are frozen within a day of the trade (older trades: market backfilled
        where the value history reaches, em dash before that; sides holding picks carry no market sum).
        In Details, since-trade deltas compare the same players-only basket at both ends, and realized
        WAR counts what each asset produced while starting for the team that acquired it.
      </div>
    </>
  );
}
