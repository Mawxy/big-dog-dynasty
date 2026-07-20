import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { BridgeKnots, PicksOwned, PickValues, ProjectionsFile, Team, ValueBridge, Values } from "../lib/types";
import { j, jDaily } from "../lib/data";
import { fmt, sgn, clsOf } from "../lib/stats";
import { optimalLineup } from "../lib/league";
import { computePostures, NEUTRAL as NEUTRAL_W, pickLabel, pickStream, type Posture } from "../lib/tradeModel";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

/** One tradeable thing, valued through every lens we have:
 *  stream = model WAR by year (players: 3-yr composite; picks: Bridge A),
 *  iWar   = market-implied 3-yr WAR (Bridge B at the asset's market value),
 *  ktc/fc = raw market value. lag = years until a future pick's stream starts. */
interface Asset {
  key: string; label: string; kind: "player" | "pick";
  pid?: string; pos?: string;
  /** players: current fantasy roster (team mode only offers what you own) */
  team?: string;
  stream: number[]; lag: number;
  iWar: number | null; ktc: number | null; fc: number | null;
}
const sum3 = (a: Asset) => a.stream.reduce((x, y) => x + y, 0);
/** value an asset through a team's per-year window weights; years beyond the
 *  3-yr horizon decay 0.9/yr off the last weight (future picks reach there) */
const wAt = (w: number[], n: number) => n < w.length ? w[n] : w[w.length - 1] * 0.9 ** (n - w.length + 1);
const disc = (a: Asset, w: number[]) =>
  a.stream.reduce((acc, v, k) => acc + v * wAt(w, a.lag + k), 0);
const wsum = (col: Asset[], w: number[]) => col.reduce((a, x) => a + disc(x, w), 0);
const NEUTRAL = NEUTRAL_W;   // no team context: pure uncertainty decay

function interp(k: BridgeKnots, x: number): number {
  if (x <= k[0][0]) return k[0][1];
  if (x >= k[k.length - 1][0]) return k[k.length - 1][1];
  for (let i = 1; i < k.length; i++)
    if (x <= k[i][0]) {
      const [x0, y0] = k[i - 1], [x1, y1] = k[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  return k[k.length - 1][1];
}

const ORD = ["1st", "2nd", "3rd", "4th"];
const TIERS = ["Early", "Mid", "Late"];
const selStyle: CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", color: "var(--txt)", padding: "4px 8px", borderRadius: 8, fontSize: 13 };

/** Per-franchise trade posture, computed — never typed in.
 *  Strength per year y = optimal-lineup WAR on that year's composite PLUS the
 *  WAR streams of every future pick the team holds (tiered by the original
 *  owner's projected finish — a bad team's pick is an Early one). A win only
 *  matters in a year you're strong, so each year is weighted by that year's
 *  ABSOLUTE strength (+1 WAR liquidity floor: present production is always
 *  tradeable), times a flat 0.9/yr uncertainty decay, then normalized so
 *  every team spends the same total budget — only the now-vs-later TILT
 *  differs. An aging contender tilts to now even while staying #1; a deep
 *  rebuilder weights year 3 above year 1. */
type TeamPosture = Posture;

export default function TradeCalc({ teamMode }: { teamMode: boolean }) {
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [vals, setVals] = useState<Values | null>(null);
  const [bridge, setBridge] = useState<ValueBridge | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [owned, setOwned] = useState<PicksOwned | null>(null);
  const [sides, setSides] = useState<[Asset[], Asset[]]>([[], []]);
  const [who, setWho] = useState<[string, string]>(["", ""]);

  useEffect(() => {
    j<ProjectionsFile>("data/projections.json").then(p => {
      setProj(p);
      j<Team[]>(`data/${p.meta.roster_season}/teams.json`).then(setTeams).catch(() => {});
    }).catch(() => {});
    jDaily<Values>("data/values.json").then(setVals).catch(() => {});
    jDaily<ValueBridge>("data/value_bridge.json").then(setBridge).catch(() => {});
    j<PickValues>("data/pick_values.json").then(setPv).catch(() => {});
    j<PicksOwned>("data/picks_owned.json").then(setOwned).catch(() => {});
  }, []);

  const postures = useMemo<TeamPosture[]>(() => {
    if (!proj || !teams || !pv) return [];
    return computePostures(proj.players, teams, pv, owned, +proj.meta.roster_season);
  }, [proj, teams, pv, owned]);
  const postureOf = (name: string) => postures.find(p => p.name === name) ?? null;
  const weights: [number[], number[]] = [
    postureOf(who[0])?.w ?? NEUTRAL,
    postureOf(who[1])?.w ?? NEUTRAL,
  ];

  const options = useMemo<Asset[]>(() => {
    if (!proj) return [];
    const out: Asset[] = [];
    const impliedAt = (src: "ktc" | "fc", val: number | null): number | null => {
      const knots = bridge?.fits?.[src]?.proj?.total;
      return knots?.length && val != null ? interp(knots, val) : null;
    };
    for (const p of proj.players) {
      const v = vals?.players[p.pid];
      const imps = [v?.impWar?.ktc, v?.impWar?.fc].filter((x): x is number => x != null);
      out.push({
        key: `p${p.pid}`, label: p.name, kind: "player", pid: p.pid, pos: p.pos,
        team: p.team.trim(), stream: p.composite, lag: 0,
        iWar: imps.length ? imps.reduce((a, b) => a + b, 0) / imps.length : null,
        ktc: v?.ktc ?? null, fc: v?.fc ?? null,
      });
    }
    if (pv) {
      const cur = pv.meta.generated_for_season + 1;   // current rookie class
      const ktcMap = new Map(vals?.picks?.ktc ?? []);
      const fcMap = new Map(vals?.picks?.fc ?? []);
      // net option value, same as tradeModel.pickStream: outcomes clamp at 0
      // (busts get cut) and the free waiver dart (Late 4th band) is netted out
      const base = pickStream(pv, "Late", 4).map((x, i) => {
        const b4 = pv.bands.find(b => b.label === "Late 4th");
        const d = b4?.dist?.[String(i + 1)];
        return d?.length ? d.reduce((a, v) => a + Math.max(0, v), 0) / d.length : 0;
      });
      const stream = (b?: { raw: Record<string, number>; dist?: Record<string, number[]> }) =>
        b ? [1, 2, 3].map(y => {
          const d = b.dist?.[String(y)];
          const opt = d?.length ? d.reduce((a, x) => a + Math.max(0, x), 0) / d.length
            : Math.max(0, b.raw[String(y)] ?? 0);
          return Math.max(0, opt - (base[y - 1] ?? 0));
        }) : [0, 0, 0];
      const mk = (label: string, str: number[], lag: number,
        ktc: number | null, fc: number | null): Asset => {
        const imps = [impliedAt("ktc", ktc), impliedAt("fc", fc)]
          .filter((x): x is number => x != null);
        return {
          key: `k${label}`, label, kind: "pick", stream: str, lag,
          iWar: imps.length ? imps.reduce((a, b) => a + b, 0) / imps.length : null,
          ktc, fc,
        };
      };
      // current-year picks: every exact slot (Bridge A knows each one)
      for (let r = 0; r < 4; r++)
        for (let s = 1; s <= 12; s++) {
          const bucket = `${r + 1}.${String(s).padStart(2, "0")}`;
          const tier = TIERS[Math.min(2, Math.floor((s - 1) / 4))];
          out.push(mk(`${cur} Pick ${bucket}`, stream(pv.picks.find(p => p.bucket === bucket)), 0,
            ktcMap.get(`${cur} ${tier} ${ORD[r]}`) ?? null,
            fcMap.get(`${cur} Pick ${bucket}`) ?? null));
        }
      // future years: Early/Mid/Late tiers (market prices these directly)
      for (let y = cur + 1; y <= cur + 2; y++)
        for (let r = 0; r < 4; r++)
          for (const tier of TIERS)
            out.push(mk(`${y} ${tier} ${ORD[r]}`, pickStream(pv, tier, r + 1), y - cur,
              ktcMap.get(`${y} ${tier} ${ORD[r]}`) ?? null,
              tier === "Mid" ? fcMap.get(`${y} ${ORD[r]}`) ?? null : null));
    }
    return out;
  }, [proj, vals, bridge, pv]);

  /** the pick labels a franchise can actually trade (its real stash, tiered
   *  by each pick's original owner's projected finish) */
  const pickLabelsOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of postures) {
      const set = new Set<string>();
      for (const pk of owned?.owned?.[String(p.rid)] ?? [])
        set.add(pickLabel(postures, pk));
      m.set(p.name, set);
    }
    return m;
  }, [postures, owned]);
  const ownsIt = (name: string, a: Asset) =>
    a.kind === "player" ? a.team === name : (pickLabelsOf.get(name)?.has(a.label) ?? false);

  // prefill from a franchise page's "Try it out" — sides are asset keys
  useEffect(() => {
    if (!options.length || !postures.length) return;
    const raw = sessionStorage.getItem("bdd-trade-prefill");
    if (!raw) return;
    sessionStorage.removeItem("bdd-trade-prefill");
    try {
      const pf = JSON.parse(raw) as { whoA: string; whoB: string; a: string[]; b: string[] };
      const find = (k: string) => options.find(o => o.key === k);
      setWho([pf.whoA ?? "", pf.whoB ?? ""]);
      setSides([
        (pf.a ?? []).map(find).filter((x): x is Asset => !!x),
        (pf.b ?? []).map(find).filter((x): x is Asset => !!x),
      ]);
    } catch { /* stale prefill — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, postures]);

  const add = (side: 0 | 1, a: Asset) => setSides(prev => {
    if (prev[0].some(x => x.key === a.key) || prev[1].some(x => x.key === a.key)) return prev;
    const next: [Asset[], Asset[]] = [[...prev[0]], [...prev[1]]];
    next[side] = [...next[side], a];
    return next;
  });
  const remove = (side: 0 | 1, key: string) => setSides(prev => {
    const next: [Asset[], Asset[]] = [[...prev[0]], [...prev[1]]];
    next[side] = next[side].filter(x => x.key !== key);
    return next;
  });

  const rawTot = (s: Asset[]) => ({
    war: s.reduce((a, x) => a + sum3(x), 0),
    iWar: s.reduce((a, x) => a + (x.iWar ?? 0), 0),
    ktc: s.reduce((a, x) => a + (x.ktc ?? 0), 0),
    fc: s.reduce((a, x) => a + (x.fc ?? 0), 0),
  });
  const tA = rawTot(sides[0]), tB = rawTot(sides[1]);
  const nameOf = (i: 0 | 1) => (teamMode && who[i]) || `Side ${i ? "B" : "A"}`;
  // team mode: each team's net = what it takes in minus what it ships out,
  // both valued through ITS OWN year weights. A good trade is +/+ — each side
  // converts the years it can't use into the years it can.
  const nets: [number, number] = [
    wsum(sides[1], weights[0]) - wsum(sides[0], weights[0]),
    wsum(sides[0], weights[1]) - wsum(sides[1], weights[1]),
  ];
  const rawDiff = tA.war - tB.war;   // generic verdict: which package is bigger

  // balancing suggestions: when one side is short, offer assets that close the
  // gap — in team mode only things the short side actually owns, valued
  // through the RECEIVER's weights (that's whose deficit we're fixing)
  const suggestions = useMemo<{ col: 0 | 1; items: { a: Asset; v: number }[] } | null>(() => {
    if (sides[0].length + sides[1].length === 0) return null;
    const taken = new Set([...sides[0], ...sides[1]].map(a => a.key));
    let col: 0 | 1, target: number, val: (a: Asset) => number, pool = options;
    if (teamMode) {
      const worse = nets[0] < nets[1] ? 0 : 1;
      if (nets[worse] >= -0.25) return null;   // works for both already
      col = (1 - worse) as 0 | 1;              // the other side must send more
      target = -nets[worse];
      val = a => disc(a, weights[worse]);
      if (who[col]) pool = options.filter(o => ownsIt(who[col], o));
    } else {
      if (Math.abs(rawDiff) <= 0.25) return null;
      col = rawDiff > 0 ? 1 : 0;               // lighter package adds
      target = Math.abs(rawDiff);
      val = sum3;
    }
    const items = pool
      .filter(a => !taken.has(a.key))
      .map(a => ({ a, v: val(a) }))
      .filter(x => x.v > 0.05)
      .sort((x, y) => Math.abs(x.v - target) - Math.abs(y.v - target))
      .slice(0, 5);
    return items.length ? { col, items } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, sides, teamMode, who, nets[0], nets[1], rawDiff]);

  if (!proj) return <div className="empty">Loading…</div>;

  return (
    <>
      <div style={{ color: "var(--dim)", fontSize: 12.5, margin: "4px 0 14px" }}>
        Each side = what that team <b style={{ color: "var(--txt)" }}>sends away</b>.
        {teamMode && <> Pick the two franchises — each can only offer what it owns, and
          everything it receives is valued through its own year weights (computed from
          its competitive window, picks included; a deep rebuilder weights year 3 above
          year 1).</>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18, alignItems: "start" }}>
        {([0, 1] as const).map(i => {
          const t = i ? tB : tA;
          const recv = (1 - i) as 0 | 1;
          return (
            <div key={i} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <b style={{ color: "var(--txt)" }}>{nameOf(i)} sends</b>
                {teamMode && <>
                  <select value={who[i]} style={selStyle}
                    onChange={e => setWho(prev => i ? [prev[0], e.target.value] : [e.target.value, prev[1]])}>
                    <option value="">pick a franchise…</option>
                    {postures.map(p => <option key={p.rid} value={p.name}>{p.name}</option>)}
                  </select>
                  {postureOf(who[i]) && (() => {
                    const p = postureOf(who[i])!;
                    return <span style={{ color: "var(--dim)", fontSize: 12.5 }}
                      title={`strength by year (lineup + owned picks): ${p.s.map(x => sgn(x, 2)).join(" / ")} — a year you can contend in is a year whose WAR you value`}>
                      {p.status} · #{p.rankNow} now
                      {p.age != null && <> · <span title="WAR-weighted average age of the current optimal lineup">avg starter age {fmt(p.age, 1)}</span></>}
                      {" "}· yr weights{" "}
                      <b style={{ color: "var(--txt)" }}>{p.w.map(x => fmt(x, 2)).join(" / ")}</b>
                    </span>;
                  })()}
                </>}
              </div>
              <AssetSearch options={options}
                restrict={teamMode && who[i] ? (a => ownsIt(who[i], a)) : undefined}
                taken={new Set([...sides[0], ...sides[1]].map(a => a.key))}
                onPick={a => add(i, a)}
                placeholder={teamMode && who[i]
                  ? `Add from ${who[i]}…`
                  : "Add player or pick (e.g. 2027 Early 1st)…"} />
              <AssetBrowser key={who[i] || "generic"}
                list={(teamMode && who[i] ? options.filter(a => ownsIt(who[i], a)) : options)
                  .slice().sort((a, b) => sum3(b) - sum3(a))}
                taken={new Set([...sides[0], ...sides[1]].map(a => a.key))}
                defaultOpen={teamMode && !!who[i]}
                onAdd={a => add(i, a)} />
              {sides[i].length === 0
                ? <div style={{ color: "var(--dim)", fontSize: 13, padding: "14px 2px" }}>Add players or picks…</div>
                : <table className="wktbl" style={{ marginTop: 8, width: "100%" }}>
                  <thead><tr>
                    <th style={{ textAlign: "left" }}>Asset</th>
                    <th title="model: 3-yr composite WAR (picks: Bridge A slot value)">WAR/3yr</th>
                    {teamMode && <th title={`value to ${nameOf(recv)} through their year weights`}>to {nameOf(recv) === "Side A" || nameOf(recv) === "Side B" ? nameOf(recv) : "them"}</th>}
                    <th title="market-implied 3-yr WAR (Bridge B)">mkt WAR</th>
                    <th>KTC</th><th>FC</th><th /></tr></thead>
                  <tbody>
                    {sides[i].map(a => (
                      <tr key={a.key}>
                        <td style={{ textAlign: "left", whiteSpace: "nowrap" }}>
                          {a.kind === "player"
                            ? <><PlayerLink pid={a.pid!} name={a.label} /> <PosBadge pos={a.pos!} /></>
                            : a.label}
                        </td>
                        <td className={clsOf(sum3(a))}>{sgn(sum3(a), 2)}</td>
                        {teamMode && <td className={clsOf(disc(a, weights[recv]))}>{sgn(disc(a, weights[recv]), 2)}</td>}
                        <td style={{ color: "var(--dim)" }}>{a.iWar == null ? "—" : sgn(a.iWar, 2)}</td>
                        <td style={{ color: "var(--dim)" }}>{a.ktc == null ? "—" : a.ktc.toLocaleString()}</td>
                        <td style={{ color: "var(--dim)" }}>{a.fc == null ? "—" : a.fc.toLocaleString()}</td>
                        <td><span style={{ color: "var(--dim)", cursor: "pointer" }} title="remove"
                          onClick={() => remove(i, a.key)}>✕</span></td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ textAlign: "left", color: "var(--txt)" }}><b>Total</b></td>
                      <td className={clsOf(t.war)}><b>{sgn(t.war, 2)}</b></td>
                      {teamMode && <td className={clsOf(wsum(sides[i], weights[recv]))}><b>{sgn(wsum(sides[i], weights[recv]), 2)}</b></td>}
                      <td style={{ color: "var(--dim)" }}>{sgn(t.iWar, 2)}</td>
                      <td style={{ color: "var(--dim)" }}>{t.ktc.toLocaleString()}</td>
                      <td style={{ color: "var(--dim)" }}>{t.fc.toLocaleString()}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>}
            </div>
          );
        })}
      </div>

      {(sides[0].length > 0 || sides[1].length > 0) && (
        <div style={{ margin: "16px 0", padding: "10px 14px", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, fontSize: 13.5 }}>
          {teamMode
            ? <>
              {([0, 1] as const).map(i => (
                <span key={i} style={{ marginRight: 18 }}>
                  <b style={{ color: "var(--txt)" }}>{nameOf(i)}</b>{" "}
                  <span className={clsOf(nets[i])}>{sgn(nets[i], 2)}</span>
                  <span style={{ color: "var(--dim)" }}> net weighted WAR</span>
                </span>
              ))}
              <span style={{ color: "var(--dim)" }}>
                {nets[0] > 0.25 && nets[1] > 0.25 ? "— works for both sides"
                  : nets[0] < -0.25 || nets[1] < -0.25 ? `— bad deal for ${nameOf(nets[0] < nets[1] ? 0 : 1)}`
                    : "— roughly even"}
              </span>
            </>
            : Math.abs(rawDiff) <= 0.25
              ? <span style={{ color: "var(--dim)" }}>Even trade ({sgn(rawDiff, 2)} WAR)</span>
              : <><b style={{ color: "var(--txt)" }}>{rawDiff > 0 ? nameOf(0) : nameOf(1)}</b> sends the
                more valuable package:{" "}
                <span className="num good">{sgn(Math.abs(rawDiff), 2)}</span>
                <span style={{ color: "var(--dim)" }}> WAR over 3 years</span></>}
          <span style={{ color: "var(--dim)" }}>
            {" · market: "}
            {tA.ktc !== tB.ktc && <>KTC says {tA.ktc > tB.ktc ? nameOf(0) : nameOf(1)} gives {Math.abs(tA.ktc - tB.ktc).toLocaleString()} more</>}
            {tA.fc !== tB.fc && <> · FC says {tA.fc > tB.fc ? nameOf(0) : nameOf(1)} gives {Math.abs(tA.fc - tB.fc).toLocaleString()} more</>}
          </span>
          {suggestions && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ color: "var(--dim)", fontSize: 12.5 }}>
                even it up — {nameOf(suggestions.col)} also sends:
              </span>
              {suggestions.items.map(({ a, v }) => (
                <span key={a.key} className="chip" onClick={() => add(suggestions.col, a)}
                  title={`worth ${sgn(v, 2)} ${teamMode ? "weighted " : ""}WAR to the receiving side`}>
                  {a.kind === "player" && a.pos ? `${a.label} (${a.pos})` : a.label}
                  {" "}<span style={{ color: "var(--dim)" }}>{sgn(v, 2)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 8 }}>
        Players are valued by their 3-year composite WAR projection; picks by Bridge A's
        empirical slot/tier WAR (future picks start their stream when they resolve).
        mkt WAR = Bridge B's value→WAR curve at each asset's market price.
        {teamMode && <> Year weights per franchise: each of the next 3 years is weighted
          by that year's absolute strength (lineup + owned picks, floored so present WAR
          keeps its trade liquidity), times 0.9/yr uncertainty decay, normalized to a
          common budget — aging contenders and fading rosters tilt to now, ascending
          rebuilders to later.</>}
      </div>
    </>
  );
}

/** browsable asset list with +-to-add — the roster in team mode, everything in
 *  generic mode. Typing in the search box above works exactly the same. */
function AssetBrowser({ list, taken, onAdd, defaultOpen }: {
  list: Asset[]; taken: Set<string>; onAdd: (a: Asset) => void; defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [cats, setCats] = useState<Set<string>>(new Set());
  const toggleCat = (c: string) => setCats(prev => {
    const next = new Set(prev);
    if (!next.delete(c)) next.add(c);
    return next;
  });
  const avail = list.filter(a => !taken.has(a.key));
  if (!avail.length) return null;
  const groups: [string, Asset[]][] = [
    ...["QB", "RB", "WR", "TE"].map(p =>
      [p, avail.filter(a => a.kind === "player" && a.pos === p)] as [string, Asset[]]),
    ["Picks", avail.filter(a => a.kind === "pick")],
  ];
  return (
    <div style={{ marginTop: 8 }}>
      <span onClick={() => setOpen(o => !o)}
        style={{ color: "var(--dim)", fontSize: 12.5, cursor: "pointer", userSelect: "none" }}>
        {open ? "▾" : "▸"} browse assets ({avail.length})
      </span>
      {open && (
        <div style={{ maxHeight: 260, overflowY: "auto", marginTop: 6, border: "1px solid var(--line)", borderRadius: 8 }}>
          {groups.filter(([, g]) => g.length).map(([cat, g]) => (
            <div key={cat}>
              <div onClick={() => toggleCat(cat)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
                  fontSize: 11.5, color: "var(--dim)", textTransform: "uppercase",
                  letterSpacing: .5, cursor: "pointer", userSelect: "none",
                  borderBottom: "1px solid var(--line)",
                }}>
                {cats.has(cat) ? "▾" : "▸"} {cat} <span style={{ opacity: .7 }}>({g.length})</span>
              </div>
              {cats.has(cat) && g.map(a => (
                <div key={a.key}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px 4px 22px", fontSize: 13, whiteSpace: "nowrap" }}>
                  <span onClick={() => onAdd(a)} title="add to this side"
                    style={{ color: "var(--acc)", cursor: "pointer", fontWeight: 700, width: 14 }}>+</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{a.label}</span>
                  <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 12 }}>{sgn(sum3(a), 2)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** typeahead over players + picks, QuickJump-style */
function AssetSearch({ options, taken, onPick, restrict, placeholder }: {
  options: Asset[]; taken: Set<string>; onPick: (a: Asset) => void;
  restrict?: (a: Asset) => boolean; placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const score = (label: string): number => {
      const n = label.toLowerCase();
      return n.startsWith(s) ? 0
        : n.split(/\s+/).some(w => w.startsWith(s)) ? 1
          : n.includes(s) ? 2 : -1;
    };
    return options
      .map(o => [score(o.label), o] as const)
      .filter(([sc, o]) => sc >= 0 && !taken.has(o.key) && (!restrict || restrict(o)))
      .sort((a, b) => a[0] - b[0])
      .slice(0, 8).map(([, o]) => o);
  }, [q, options, taken, restrict]);
  const pick = (a: Asset) => { onPick(a); setQ(""); setOpen(false); };
  return (
    <div style={{ position: "relative" }}>
      <input type="search" placeholder={placeholder} value={q}
        style={{ width: "100%", boxSizing: "border-box" }}
        onChange={e => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => Math.min(i + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && hits.length > 0 && (
        <div style={{
          position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 30,
          background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10,
          overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,.35)",
        }}>
          {hits.map((o, i) => (
            <div key={o.key} onMouseDown={e => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setSel(i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
                background: i === sel ? "var(--line)" : "transparent",
              }}>
              <span style={{ color: "var(--dim)", fontSize: 10.5, letterSpacing: .5, width: 30, flexShrink: 0 }}>
                {o.kind === "player" ? o.pos : "PICK"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
              <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 12 }}>{sgn(sum3(o), 2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
