import { useMemo, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Franchises, Ownership, Team, Trade, TradesPayload } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeagueCaps } from "../../lib/caps";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { readTrades, tradeWhen } from "../../lib/trades";
import { buildLineage, tradeId, type End, type Lineage, type Step } from "../../lib/tradeLineage";
import { Band, DataError, IdLines, TapRow, useBetaPath } from "../ui";
import "./trade.css";

/**
 * ONE TRADE, AND WHERE EVERYTHING IN IT WENT (Max, 2026-10-27).
 *
 * The ledger card says what each side got and how it has done. This page
 * answers the next question — what did they do with it — by following every
 * asset forward to wherever it sits today: flipped, drafted, dropped, claimed,
 * still held. A trade hop names what the giving side got back and opens that
 * trade's own page, so a reader walks the whole tree a deal at a time.
 *
 * THE MATH IS IN `lib/tradeLineage`, dependency-free and under
 * `tests/tradeLineage.test.ts`. This file names teams and lays rows out.
 *
 * BOTH SIDES STAY NEUTRAL (SKILL §5): two identical sections in roster-id
 * order, nothing inked by who came out ahead. The one accent is the "Now" row,
 * because where an asset ended up is the answer the page exists to give.
 */
export default function TradeDetail() {
  const id = useParams().id ?? "";
  const nav = useNavigate();
  const betaPath = useBetaPath();
  const { league } = useLeague();
  const caps = useLeagueCaps();
  const file = useJson<TradesPayload>(caps.trades ? "trades.json" : null);
  const own = useJson<Ownership>(caps.trades ? "ownership.json" : null);
  const fr = useJson<Franchises>("franchises.json").data;
  const teams = useJson<Team[]>(`${rosterSeasonOf(league)}/teams.json`).data;

  const index = useMemo(() => {
    if (!file.data || !own.data || !teams) return null;
    const rostered = new Map<string, number>();
    for (const t of teams)
      for (const p of [...t.players, ...(t.taxi ?? []), ...(t.reserve ?? [])]) rostered.set(p, t.roster_id);
    return buildLineage(readTrades(file.data).trades, own.data, rostered);
  }, [file.data, own.data, teams]);

  /* NAMES. A trade hop names the team as it was named in THAT trade (the
     writer stamps it on each side); an ownership event already carries the
     name of its day. The manager is the constant a reader recognizes across
     renames, so it rides along on the sub-line wherever it can be found. */
  const managerOf = (rid: number | null, season?: string): string | null => {
    if (rid == null || !fr) return null;
    const ss = fr[String(rid)]?.seasons ?? [];
    return (ss.find(s => s.season === season) ?? ss[ss.length - 1])?.manager ?? null;
  };
  const managerByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of Object.values(fr ?? {})) for (const s of f.seasons) m.set(s.name.trim(), s.manager);
    return m;
  }, [fr]);
  const nowName = (rid: number) => teams?.find(t => t.roster_id === rid)?.team.trim() ?? `Team ${rid}`;
  const sideName = (t: Trade, rid: number | null) =>
    rid == null ? "another team" : (t.sides.find(s => s.rid === rid)?.team.trim() ?? nowName(rid));

  const trade = index?.byId.get(id) ?? null;
  const reversed = trade ? index!.reversed.has(id) : false;
  const back = () => nav(betaPath("/trade?scope=history"));

  if (!caps.trades) return (
    <>
      <Head back={back} sub="" />
      <div className="tnote screen">The trade ledger is not published for {league.name}.</div>
    </>
  );
  if (file.error || own.error) return <><Head back={back} sub="" /><DataError what="Trades didn't load" /></>;
  if (!index) return <><Head back={back} sub="" /><div className="empty">Loading…</div></>;
  if (!trade) return (
    <>
      <Head back={back} sub="" />
      <div className="tnote screen">No trade on record matches this link.</div>
    </>
  );

  const sides = trade.sides.slice().sort((a, b) => a.rid - b.rid);
  const when = (s: Step): string =>
    s.kind === "trade" ? `${s.trade.season} · wk ${s.trade.week}`
      : s.kind === "drafted" ? `${s.season} · draft`
        : `${s.season} · wk ${s.week}`;
  const playerTo = (pid: string) => betaPath(`/player/${pid}`);

  /** one step as a row: what happened, then who and for what */
  const stepRow = (s: Step, key: string, zebra: boolean, pre = false) => {
    let name: string, sub: string | null, to: string | null = null;
    if (s.kind === "trade") {
      const gave = sideName(s.trade, s.from);
      name = `Traded to ${sideName(s.trade, s.to)}`;
      const ret = s.got.map(a => a.label.replace(/ \(not yet drafted\)$/, "")).join(", ");
      sub = [
        managerOf(s.to, s.trade.season),
        ret ? `${gave} got ${ret}` : null,
        s.reversed ? "reversed by commissioner" : null,
      ].filter(Boolean).join(" · ");
      // this trade's own page is the row's destination — unless it is THIS page
      const hop = tradeId(s.trade);
      to = hop === id ? null : betaPath(`/trade/${hop}`);
    } else if (s.kind === "drafted") {
      name = `Drafted${s.slot ? ` ${s.slot}` : ""}${s.team ? ` by ${s.team}` : ""}`;
      sub = s.team ? managerByName.get(s.team) ?? null : null;
      to = playerTo(s.pid);
    } else if (s.kind === "dropped") {
      name = `Dropped by ${s.team}`; sub = managerByName.get(s.team) ?? null;
    } else if (s.kind === "claimed") {
      name = `${s.how === "waiver" ? "Waiver claim" : "Signed"} by ${s.team}`;
      sub = managerByName.get(s.team) ?? null;
    } else {
      name = `Commissioner moved to ${s.team}`; sub = managerByName.get(s.team) ?? null;
    }
    return (
      <TapRow key={key} to={to} className={[zebra ? "zebra" : "", pre ? "trl-pre" : ""].filter(Boolean).join(" ")}>
        <td className="t trl-when">{pre ? "Before" : when(s)}</td>
        <td className="idc t"><IdLines name={name} sub={sub ?? " "} /></td>
      </TapRow>
    );
  };

  const endRow = (l: Lineage, e: End, key: string) => {
    let name: string, sub: string | null = null;
    switch (e.kind) {
      case "rostered": name = `On ${nowName(e.rid)}`; sub = managerOf(e.rid); break;
      case "free agent": name = "Free agent"; sub = `since ${e.season} · wk ${e.week}`; break;
      case "pick": name = `Held by ${nowName(e.rid)}`; sub = `${managerOf(e.rid) ?? ""} · ${e.ps} draft`.replace(/^ · /, ""); break;
      case "unused": name = "Slot went unused"; break;
      case "faab": name = "Spent"; sub = "FAAB has no afterlife"; break;
      default: name = "Off every roster"; sub = "no drop on record";
    }
    const pid = l.asset.pid;
    return (
      <TapRow key={key} to={e.kind === "rostered" && pid ? playerTo(pid) : null} className="trl-now">
        <td className="t trl-when">Now</td>
        <td className="idc t"><IdLines name={name} sub={sub ?? " "} /></td>
      </TapRow>
    );
  };

  return (
    <>
      <Head back={back}
        sub={`${tradeWhen(trade.ts)} · ${trade.season} · wk ${trade.week}${sides.length > 2 ? " · 3-team" : ""}${reversed ? " · reversed by commissioner" : ""}`} />
      {sides.map(sd => {
        const lines = index.trace(trade, sd.rid);
        return (
          <section key={sd.rid}>
            <Band label={`${sd.team.trim()} got`} note={managerOf(sd.rid, trade.season) ?? undefined} />
            <table className="v3tbl trl">
              <thead>
                <tr>
                  <th className="t trl-wc">When</th>
                  <th className="t trl-wd">What happened next</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const [head, tail] = l.asset.label.split(" → ");
                  const label = head.replace(/ \(not yet drafted\)$/, "");
                  const assetName = l.asset.pid
                    ? <a href={`#${playerTo(l.asset.pid)}`}>{tail ? `${label} → ${tail}` : label}</a>
                    : label;
                  const fromLine = l.from != null ? `from ${sideName(trade, l.from)}` : null;
                  const ownPick = l.asset.kind === "pick" && l.asset.orig != null && l.asset.orig === l.from;
                  const rows = [];
                  if (l.origin) rows.push(stepRow(l.origin, `o${i}`, false, true));
                  l.steps.forEach((s, j) => rows.push(stepRow(s, `s${i}-${j}`, j % 2 === 1)));
                  rows.push(endRow(l, l.end, `e${i}`));
                  return (
                    <AssetGroup key={i} name={assetName}
                      sub={[fromLine, ownPick ? "their own pick" : null].filter(Boolean).join(" · ")}>
                      {rows}
                    </AssetGroup>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
      <div className="tnote screen">
        Every asset is followed forward from this trade to where it sits today. A pick is followed
        through later trades of that pick, then into the player it became. A traded hop names
        what the giving side got back; tap it for that trade's own page. Before is how the
        sending side came to hold it. Teams are named as they were at the time, with the manager
        beside them.
      </div>
    </>
  );
}

function Head({ back, sub }: { back: () => void; sub: string }) {
  return (
    <div className="v3-head">
      <button type="button" className="rail-back trl-back" onClick={back}>← Ledger</button>
      <h1>Trade</h1>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

/** an asset's header row, then its path */
function AssetGroup({ name, sub, children }: { name: ReactNode; sub: string; children: ReactNode }) {
  return (
    <>
      <tr className="trl-asset">
        <td colSpan={2}><IdLines name={name} sub={sub || " "} /></td>
      </tr>
      {children}
    </>
  );
}
