import { useMemo, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Franchises, Ownership, Team, Trade, TradeSide, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeagueCaps } from "../../lib/caps";
import { useLeague } from "../../lib/context";
import { pInfo, POS_COLOR, rosterSeasonOf } from "../../lib/league";
import { ROUND_ORD } from "../../lib/rosterModel";
import { readTrades, tradeWhen } from "../../lib/trades";
import { buildLineage, tradeId, type End, type Lineage, type Step } from "../../lib/tradeLineage";
import { Band, DataError, PosSpine, useBetaPath } from "../ui";
import { GRID_NOTE, TradeGrid, useGridCtx, useWho } from "./tradeGrid";
import "./trade.css";

/**
 * ONE TRADE, AND WHERE EVERYTHING IN IT WENT (Max, 2026-10-27).
 *
 * Two parts, in the order a reader asks the questions:
 *
 *  1. THE DEAL — the same grid the ledger card carries: what each side got,
 *     the WAR it has returned, what is still projected, the market then → now.
 *  2. WHERE IT WENT — per side, one entry per asset. The ANSWER comes first:
 *     the entry's header names who holds it today (or that it was cut, or is
 *     an unmade pick), so the page reads top to bottom without opening
 *     anything. Under it, the path: how the sender came to hold it, this
 *     trade, then every move since — trades (with what the giving side got
 *     back, and a tap to that trade's page), the draft, drops, claims.
 *
 * THE MATH IS IN `lib/tradeLineage`, dependency-free and under
 * `tests/tradeLineage.test.ts`. This file names people and lays things out.
 *
 * BOTH SIDES STAY NEUTRAL (SKILL §5): sections in roster-id order, one ink.
 * The one accent on the page marks this trade's own step in each path — the
 * "you are here" a reader needs in a chain that runs both ways from it.
 */
export default function TradeDetail() {
  const id = useParams().id ?? "";
  const nav = useNavigate();
  const betaPath = useBetaPath();
  const { league, players } = useLeague();
  const caps = useLeagueCaps();
  const file = useJson<TradesPayload>(caps.trades ? "trades.json" : null);
  const own = useJson<Ownership>(caps.trades ? "ownership.json" : null);
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const fr = useJson<Franchises>("franchises.json").data;
  const ctx = useGridCtx();
  const who = useWho();

  const index = useMemo(() => {
    if (!file.data || !own.data || !teams) return null;
    const rostered = new Map<string, number>();
    for (const t of teams)
      for (const p of [...t.players, ...(t.taxi ?? []), ...(t.reserve ?? [])]) rostered.set(p, t.roster_id);
    return buildLineage(readTrades(file.data).trades, own.data, rostered);
  }, [file.data, own.data, teams]);

  /* NAMES. Managers are the constant across renames, so they lead; the
     franchise name rides beneath as it stood at the time. An ownership event
     names its team as it was THEN, so its manager is found by that name. */
  const managerByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of Object.values(fr ?? {})) for (const s of f.seasons) m.set(s.name.trim(), s.manager);
    return m;
  }, [fr]);
  const nowTeam = (rid: number) => teams?.find(t => t.roster_id === rid);
  const ownerOf = (rid: number) => nowTeam(rid)?.manager ?? `Team ${rid}`;
  const sideOf = (t: Trade, rid: number | null) => (rid == null ? null : t.sides.find(s => s.rid === rid) ?? null);
  /** a side of some trade as "manager", falling back to the franchise name */
  const mgrIn = (t: Trade, rid: number | null): string => {
    if (rid == null) return "another team";
    const s = sideOf(t, rid);
    return who(rid, t.season, s?.team ?? "").manager ?? s?.team.trim() ?? ownerOf(rid);
  };
  const playerTo = (pid: string) => betaPath(`/player/${pid}`);
  const back = () => nav(betaPath("/trade?scope=history"));

  const trade = index?.byId.get(id) ?? null;

  if (!caps.trades) return (
    <>
      <Head back={back} />
      <div className="tnote screen">The trade ledger is not published for {league.name}.</div>
    </>
  );
  if (file.error || own.error) return <><Head back={back} /><DataError what="Trades didn't load" /></>;
  if (!index) return <><Head back={back} /><div className="empty">Loading…</div></>;
  if (!trade) return (
    <>
      <Head back={back} />
      <div className="tnote screen">No trade on record matches this link.</div>
    </>
  );

  const reversed = index.reversed.has(id);
  const sides = trade.sides.slice().sort((a, b) => a.rid - b.rid);

  const whenOf = (s: Step): string =>
    s.kind === "trade" ? `${s.trade.season} · wk ${s.trade.week}`
      : s.kind === "drafted" ? `${s.season} · draft`
        : `${s.season} · wk ${s.week}`;

  /** a step as [what happened, who / for what, where a tap goes] */
  const describe = (s: Step): [string, string | null, string | null] => {
    if (s.kind === "trade") {
      const ret = s.got.map(a => {
        const [h, t] = a.label.split(" → ");
        return t ?? h.replace(/ \(not yet drafted\)$/, "");
      }).join(", ");
      const hop = tradeId(s.trade);
      return [
        `Traded to ${mgrIn(s.trade, s.to)}`,
        [ret ? `${mgrIn(s.trade, s.from)} got ${ret}` : null,
          s.reversed ? "reversed by commissioner" : null].filter(Boolean).join(" · ") || null,
        hop === id ? null : betaPath(`/trade/${hop}`),
      ];
    }
    const mgr = (team: string | null) => (team ? managerByName.get(team) ?? team : null);
    if (s.kind === "drafted")
      return [`Drafted${s.slot ? ` ${s.slot}` : ""}${s.team ? ` by ${mgr(s.team)}` : ""}`,
        s.team && managerByName.has(s.team) ? s.team : null, playerTo(s.pid)];
    if (s.kind === "dropped") return [`Dropped by ${mgr(s.team)}`, null, null];
    if (s.kind === "claimed")
      return [`${s.how === "waiver" ? "Waiver claim" : "Signed"} by ${mgr(s.team)}`, null, null];
    return [`Commissioner moved him to ${mgr(s.team)}`, null, null];
  };

  /** where it is today, as [headline, detail] */
  const status = (e: End, rid: number): [string, string] => {
    switch (e.kind) {
      case "rostered": {
        const t = nowTeam(e.rid);
        return [t?.manager ?? `Team ${e.rid}`, e.rid === rid ? "still theirs" : t?.team.trim() ?? ""];
      }
      case "free agent": return ["Free agent", `cut ${e.season} · wk ${e.week}`];
      case "pick": return [ownerOf(e.rid), `${e.ps} ${ROUND_ORD[e.rnd - 1] ?? `${e.rnd}th`} · to be made`];
      case "unused": return ["Unused", "slot went unused"];
      case "faab": return ["Spent", "FAAB"];
      default: return ["Off rosters", "no drop on record"];
    }
  };

  const entry = (sd: TradeSide, l: Lineage, i: number) => {
    const a = l.asset;
    const [head, tail] = a.label.split(" → ");
    const pick = head.replace(/ \((not yet drafted|unused)\)$/, "");
    const name = tail ?? pick;
    const pos = a.pid ? pInfo(players, a.pid)[1] : "";
    const moves = l.steps.filter(s => s.kind !== "drafted").length;
    const sub = [
      tail ? pick : null,
      l.from != null ? `from ${mgrIn(trade, l.from)}` : null,
      a.kind === "pick" && a.orig != null && a.orig === l.from ? "their own pick" : null,
      moves ? `${moves} move${moves === 1 ? "" : "s"} since` : null,
    ].filter(Boolean).join(" · ");
    const [now, nowSub] = status(l.end, sd.rid);
    const path: { key: string; when: string; what: string; sub: string | null; to: string | null; cls: string }[] = [];
    if (l.origin) {
      const [w, s, to] = describe(l.origin);
      path.push({ key: "o", when: whenOf(l.origin), what: w, sub: s, to, cls: "pre" });
    }
    path.push({
      key: "h", when: `${trade.season} · wk ${trade.week}`,
      what: `This trade · to ${mgrIn(trade, sd.rid)}`, sub: null, to: null, cls: "here",
    });
    l.steps.forEach((s, j) => {
      const [w, sb, to] = describe(s);
      path.push({ key: `s${j}`, when: whenOf(s), what: w, sub: sb, to, cls: s.kind === "trade" ? "hop" : "" });
    });
    return (
      <article className="trl-item" key={i}>
        <div className="trl-hd">
          <PosSpine color={POS_COLOR[pos]} />
          <div className="trl-id">
            <span className="nm">{a.pid ? <a href={`#${playerTo(a.pid)}`}>{name}</a> : name}</span>
            {sub && <span className="sb">{sub}</span>}
          </div>
          <div className="trl-now">
            <span className="k">Now</span>
            <span className="v">{now}</span>
            <span className="s">{nowSub}</span>
          </div>
        </div>
        <ol className="trl-path">
          {path.map(p => (
            <PathStep key={p.key} to={p.to} cls={p.cls} when={p.when} what={p.what} sub={p.sub} />
          ))}
        </ol>
      </article>
    );
  };

  const managers = sides.map(s => mgrIn(trade, s.rid)).join(" ⇄ ");
  return (
    <>
      <Head back={back}
        sub={`${tradeWhen(trade.ts)} · ${trade.season} wk ${trade.week}${sides.length > 2 ? " · 3-team" : ""}`}
        who={managers} />
      {reversed && (
        <div className="tnote screen trl-rev">
          A commissioner reversed this trade the same week. It stays on the record because it
          happened on Sleeper; the paths below show the assets going back.
        </div>
      )}
      <Band label="The deal" note="Today's read" />
      <TradeGrid t={trade} ctx={ctx} who={who} owner={ownerOf} playerTo={playerTo} />
      <div className="trl-sides">
      {sides.map(sd => {
        const lines = index.trace(trade, sd.rid);
        return (
          <section key={sd.rid}>
            <Band label={`Where ${mgrIn(trade, sd.rid)}’s haul went`}
              note={`${lines.length} asset${lines.length === 1 ? "" : "s"}`} />
            <div className="trl-list">{lines.map((l, i) => entry(sd, l, i))}</div>
          </section>
        );
      })}
      </div>
      <div className="tnote screen">
        {GRID_NOTE} Below the deal, every asset is followed from this trade to where it sits
        today: a pick through later trades of that pick and into the player it became. A trade
        step names what the giving side got back; tap it for that trade's own page.
      </div>
    </>
  );
}

function Head({ back, sub, who }: { back: () => void; sub?: string; who?: string }) {
  return (
    <div className="v3-head trl-head">
      <button type="button" className="rail-back trl-back" onClick={back}>← Ledger</button>
      <h1>{who ?? "Trade"}</h1>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/** one step of a path. A step with somewhere to go is a link with a row's
 *  keyboard contract; one without is plain. */
function PathStep({ to, cls, when, what, sub }: {
  to: string | null; cls: string; when: string; what: string; sub: string | null;
}) {
  const nav = useNavigate();
  const body: ReactNode = (
    <>
      <span className="w">{when}</span>
      <span className="mk" aria-hidden="true" />
      <span className="e">
        <span className="t">{what}</span>
        {sub && <span className="sb">{sub}</span>}
      </span>
      {to && <span className="go" aria-hidden="true">›</span>}
    </>
  );
  return to
    ? <li className={`trl-st ${cls} tap`} role="link" tabIndex={0}
      onClick={() => nav(to)} onKeyDown={e => { if (e.key === "Enter") nav(to); }}>{body}</li>
    : <li className={`trl-st ${cls}`}>{body}</li>;
}
