import { useEffect, useMemo, useState } from "react";
import type { Absences, Meta, Ownership, PlayerShard, PlayersMin, Projection as ProjRec, SummaryRow, Team, Values, Weekly, WeeklyRow } from "../lib/types";
import { jDaily, jl, jlDaily } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean } from "../lib/stats";
import { pInfo } from "../lib/league";
import QuickJump from "./QuickJump";

interface SeasonBlock {
  season: string; team: string | null; manager: string | null;
  sum: SummaryRow | null; weeks: WeeklyRow[];
  abs: Record<string, string>;
  /** positional finish by WAR that season */
  posRank: number | null;
}
const ABS_LABEL: Record<string, string> = { BYE: "Bye week", DNP: "Did not play", NR: "Not rostered" };
const POS: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
const num = (n: number) => n.toLocaleString("en-US");
const WINDOWS = ["7", "14", "30"] as const;

interface Props { pid: string; players: PlayersMin; meta: Meta; back: () => void }

export default function PlayerPage({ pid, players, meta, back }: Props) {
  const [blocks, setBlocks] = useState<SeasonBlock[] | null>(null);
  const [own, setOwn] = useState<Ownership>({});
  const [vals, setVals] = useState<Values | null>(null);
  const [warRank, setWarRank] = useState<{ season: string; rank: number } | null>(null);
  const [dvi, setDvi] = useState<{ dvi: number; rank: number; pos: string; pos_rank: number } | null>(null);
  const [proj, setProj] = useState<ProjRec | null>(null);
  const [projYears, setProjYears] = useState<number[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const seasons = meta.seasons;
      const [sums, weeks, teams, absences, ownership] = await Promise.all([
        Promise.all(seasons.map(s => jl<SummaryRow[]>(`${s}/summary.json`).catch(() => [] as SummaryRow[]))),
        Promise.all(seasons.map(s => jl<Weekly>(`${s}/weekly.json`).catch(() => ({} as Weekly)))),
        Promise.all(seasons.map(s => jl<Team[]>(`${s}/teams.json`).catch(() => [] as Team[]))),
        Promise.all(seasons.map(s => jl<Absences>(`${s}/absence.json`).catch(() => ({} as Absences)))),
        jl<Ownership>("ownership.json").catch(() => ({} as Ownership)),
      ]);
      jDaily<Values>("data/values.json").then(v => { if (live) setVals(v); }).catch(() => {});
      jlDaily<{ players: Record<string, { dvi: number; rank: number; pos: string; pos_rank: number }> }>("dvi.json")
        .then(d => { if (live) setDvi(d.players[pid] ?? null); }).catch(() => {});
      // one ~2 KB shard instead of all of projections.json; a 404 just means
      // this player has no projection and the panel is skipped
      jl<PlayerShard>(`player/${pid}.json`).then(sh => {
        if (!live) return;
        setProj(sh.proj);
        setProjYears(sh.years);
      }).catch(() => {});
      if (!live) return;
      const bl = seasons.map((s, i): SeasonBlock => {
        const t = teams[i].find(x => x.players.includes(pid));
        const r = sums[i].find(x => x[0] === pid) ?? null;
        return {
          season: s, team: t?.team ?? null, manager: t?.manager ?? null,
          sum: r,
          weeks: (weeks[i][pid] || []).slice().sort((a, b) => a[0] - b[0]),
          abs: absences[i][pid] || {},
          posRank: r ? 1 + sums[i].filter(x => x[1] === r[1] && x[6] > r[6]).length : null,
        };
      }).filter(b => b.sum || b.weeks.length || b.team);
      setBlocks(bl.reverse());   // newest season first
      let wr: { season: string; rank: number } | null = null;
      for (let i = seasons.length - 1; i >= 0; i--) {
        const r = sums[i].find(x => x[0] === pid);
        if (r) {
          wr = { season: seasons[i], rank: 1 + sums[i].filter(x => x[1] === r[1] && x[6] > r[6]).length };
          break;
        }
      }
      setWarRank(wr);
      setOwn(ownership);
    })();
    return () => { live = false; };
  }, [pid, meta]);

  const [nm, pos, nfl] = pInfo(players, pid);
  const v = vals?.players[pid];

  const market = useMemo(() => {
    if (!v) return [];
    const closest = (list: [string, number][] | undefined, val: number) => {
      if (!list?.length) return null;
      let best = list[0];
      for (const pk of list) if (Math.abs(pk[1] - val) < Math.abs(best[1] - val)) best = pk;
      return best;
    };
    const src = [
      { src: "KeepTradeCut", value: v.ktc, ovr: v.ktcRank, posRank: v.ktcPosRank, t: v.ktcT, imp: v.impWar?.ktc ?? null, picks: vals?.picks?.ktc },
      { src: "FantasyCalc", value: v.fc, ovr: v.fcRank, posRank: v.fcPosRank, t: v.fcT, imp: v.impWar?.fc ?? null, picks: vals?.picks?.fc },
    ];
    return src.filter(m => m.value != null).map(m => ({
      ...m, value: m.value as number, pick: closest(m.picks, m.value as number),
    }));
  }, [v, vals]);

  if (!blocks) return <div className="empty">Loading player…</div>;

  const played = blocks.filter(b => b.sum || b.weeks.length);
  const allPts = blocks.flatMap(b => b.weeks.map(w => w[1]));
  const gp = blocks.reduce((s, b) => s + (b.sum?.[2] || 0), 0);
  const pts = blocks.reduce((s, b) => s + (b.sum?.[3] || 0), 0);
  const waa = blocks.reduce((s, b) => s + (b.sum?.[5] || 0), 0);
  const war = blocks.reduce((s, b) => s + (b.sum?.[6] || 0), 0);
  // current owner = the LATEST season's roster only (blocks are newest-first)
  const owner = blocks[0]?.team, manager = blocks[0]?.manager;
  const latest = played[0];

  const modelWar = v?.modelWar ?? proj?.total_comp ?? null;
  const imps = market.map(m => m.imp).filter((x): x is number => x != null);
  const mktWar = imps.length ? mean(imps) : null;
  const gap = modelWar != null && mktWar != null ? modelWar - mktWar : null;
  let verdict = "not enough market data", vColor = "var(--dim)", vBg = "var(--band)", vLabel = "var(--dim2)";
  if (gap != null) {
    if (Math.abs(gap) <= 0.25) { verdict = `in line · ${sgn(gap, 2)} WAR`; vColor = "var(--txt2)"; }
    else if (gap > 0) { verdict = `buy · model ${sgn(gap, 2)} WAR above market`; vColor = "#05070a"; vBg = "var(--good)"; vLabel = "rgba(5,7,10,.6)"; }
    else { verdict = `sell · model ${sgn(gap, 2)} WAR below market`; vColor = "#fff"; vBg = "#8f2f2f"; vLabel = "rgba(255,255,255,.6)"; }
  }

  const selSeason = sel && played.some(b => b.season === sel) ? sel : played[0]?.season ?? null;
  const selBlock = played.find(b => b.season === selSeason);
  const wMax = Math.max(0.001, ...played.map(b => b.sum?.[6] ?? 0));
  const sdOf = (b: SeasonBlock) => sd(b.weeks.map(w => w[1]));
  const sdVals = played.map(sdOf).filter(x => x > 0);
  const sdHi = Math.max(0.001, ...sdVals), sdLo = Math.min(sdHi, ...sdVals);

  const events = own[pid] || [];

  return (
    <>
      <div className="php">
        <div className="php-top">
          <span className="php-back" onClick={back}>← Leaderboard</span>
          <span style={{ marginLeft: "auto" }}><QuickJump /></span>
        </div>
        <div className="php-id">
          <div>
            <div className="php-name">
              <span className="pos" style={{ background: POS[pos] || "#2b3642" }}>{pos}{warRank?.rank ?? ""}</span>
              <h1>{nm}</h1>
              {nfl && <span className="php-nfl">{nfl}</span>}
            </div>
            <div className="php-sub">
              {owner ? `Owned by ${owner}${manager ? " · " + manager : ""}` : "Free agent"} · {gp} league games
            </div>
          </div>
          <div className="php-stats">
            <Stat k="Dynasty index" v={dvi ? fmt(dvi.dvi, 1) : "—"}
              sub={dvi ? `#${dvi.rank} overall · ${dvi.pos}${dvi.pos_rank}` : "no dvi"} color="var(--acc)" />
            <Stat k="Model WAR / 3yr" v={modelWar == null ? "—" : fmt(modelWar, 2)} sub="our projection" />
            <Stat k="Market WAR / 3yr" v={mktWar == null ? "—" : fmt(mktWar, 2)} sub="implied by price" color="var(--txt2)" />
            <Stat k={latest ? `${latest.season} WAR` : "Last WAR"}
              v={latest?.sum ? fmt(latest.sum[6], 3) : "—"}
              sub={latest?.posRank ? `${pos}${latest.posRank} that season` : ""}
              color={latest?.sum && latest.sum[6] > 0 ? "var(--good)" : "var(--bad)"} />
          </div>
        </div>
        <div className="php-verdict" style={{ background: vBg }}>
          <span className="k" style={{ color: vLabel }}>Model vs market</span>
          <span className="v" style={{ color: vColor }}>{verdict}</span>
        </div>
      </div>

      {market.length > 0 && (
        <div className="psec">
          <div className="chart-label">Market value · as of {vals?.fetched ?? "—"}</div>
          <table className="mkt">
            <colgroup>
              <col style={{ width: 190 }} /><col style={{ width: 150 }} />
              <col style={{ width: 92 }} /><col style={{ width: 92 }} /><col style={{ width: 92 }} />
              <col style={{ width: 86 }} /><col style={{ width: 86 }} /><col /><col style={{ width: 150 }} />
            </colgroup>
            <thead>
              <tr className="grp">
                <th colSpan={2}></th>
                <th className="edge" colSpan={3}>Movement</th>
                <th className="edge" colSpan={3}>Standing</th>
                <th className="edge value" colSpan={1}>Implied</th>
              </tr>
              <tr>
                <th className="t">Source</th>
                <th className="n">Value</th>
                <th className="n edge">7 day</th><th className="n">14 day</th><th className="n">30 day</th>
                <th className="n edge">Overall</th><th className="n">Position</th>
                <th className="t">Priced like</th>
                <th className="n key edge">WAR / 3yr</th>
              </tr>
            </thead>
            <tbody>
              {market.map(m => (
                <tr key={m.src}>
                  <td className="src t">{m.src}</td>
                  <td className="val n">{num(m.value)}</td>
                  {WINDOWS.map((d, i) => {
                    // always render the window — a dash means the daily snapshot
                    // history doesn't reach back that far yet
                    const t = m.t?.[d];
                    return (
                      <td key={d} className={`mv n${i === 0 ? " edge" : ""}`}
                        style={{ color: t == null ? "var(--dim3)" : t > 0 ? "var(--good)" : t < 0 ? "var(--bad)" : "var(--dim)" }}>
                        {t == null ? "—" : t === 0 ? "0" : `${t > 0 ? "▲" : "▼"} ${num(Math.abs(t))}`}
                      </td>
                    );
                  })}
                  <td className="n edge" style={{ color: "var(--txt2)" }}>{m.ovr == null ? "—" : `#${m.ovr}`}</td>
                  <td className="n" style={{ color: "var(--txt2)" }}>{m.posRank == null ? "—" : `${pos}${m.posRank}`}</td>
                  <td className="t sub">{m.pick ? `${m.pick[0]}  (${num(m.pick[1])})` : "—"}</td>
                  <td className="imp n edge">{m.imp == null ? "—" : fmt(m.imp, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pnote">
            Priced like = the rookie pick currently worth the same as this player · implied WAR runs that
            price through the league's value→WAR curve · a dash means the daily snapshot history doesn't reach back that far yet
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="psec">
          <div className="chart-label">Ownership history</div>
          <div className="own-cards">
            {events.slice().reverse().map((e, i) => (
              <div key={i} className="own-card">
                <div className="when">{e[0]}{e[1] ? ` · W${e[1]}` : ""}</div>
                <div className="what">{e[2]}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ppanels">
        {proj && projYears.length > 0 && <ProjPanel p={proj} years={projYears} pos={pos} />}
        <div className="ppanel career">
          <div className="chart-label">League career</div>
          <div className="career-grid">
            <div><div className="k">Games</div><div className="v">{gp}</div></div>
            <div><div className="k">PPG</div><div className="v">{gp ? fmt(pts / gp, 1) : "—"}</div></div>
            <div><div className="k">Volatility</div><div className="v" style={{ color: "var(--txt2)" }}>{fmt(sd(allPts), 1)}</div></div>
            <div><div className="k">Points</div><div className="v" style={{ color: "var(--txt2)" }}>{fmt(pts, 0)}</div></div>
            <div><div className="k">Career WAR</div><div className="v" style={{ color: "var(--acc)" }}>{fmt(war, 3)}</div></div>
            <div><div className="k">Career WAA</div><div className={`v ${clsOf(waa)}`}>{sgn(waa, 3)}</div></div>
          </div>
        </div>
      </div>

      <div className="psec">
        <div className="screen-title" style={{ marginBottom: 10, display: "block" }}>Season by season</div>
        <table className="pseason">
          <colgroup>
            <col style={{ width: 96 }} /><col /><col style={{ width: 56 }} /><col style={{ width: 84 }} />
            <col style={{ width: 76 }} /><col style={{ width: 120 }} /><col style={{ width: 150 }} /><col style={{ width: 110 }} />
          </colgroup>
          <thead>
            <tr className="grp">
              <th colSpan={2}></th>
              <th className="edge" colSpan={4}>Production</th>
              <th className="edge value" colSpan={2}>Wins added</th>
            </tr>
            <tr>
              <th className="t">Season</th><th className="t">Fantasy team</th>
              <th className="n edge">GP</th><th className="n">Pts</th><th className="n">PPG</th>
              <th className="n">Consistency</th>
              <th className="n key edge">WAR</th><th className="n">Pos finish</th>
            </tr>
          </thead>
          <tbody>
            {played.map(b => {
              const s = b.sum, sdv = sdOf(b);
              return (
                <tr key={b.season} className={`click ${b.season === selSeason ? "open" : ""}`}
                  onClick={() => setSel(b.season)}>
                  <td className="yr t">{b.season}</td>
                  <td className="team t">{b.team || "unrostered"}
                    {b.manager && <span style={{ color: "var(--dim)" }}> · {b.manager}</span>}</td>
                  <td className="n edge fig quiet">{s?.[2] ?? 0}</td>
                  <td className="n fig">{fmt(s?.[3] ?? 0, 1)}</td>
                  <td className="n fig strong">{fmt(s?.[4] ?? 0)}</td>
                  <td className="n">
                    <div className="meter">
                      <div className="track cons" style={{ width: 52 }}>
                        <div className="fill" style={{ width: Math.round(Math.max(6, (1 - (sdv - sdLo) / ((sdHi - sdLo) || 1)) * 100)) + "%" }} />
                      </div>
                      <span className="val sm">{fmt(sdv, 1)}</span>
                    </div>
                  </td>
                  <td className="n edge">
                    <div className="meter">
                      <div className="track" style={{ width: 60, height: 9 }}>
                        <div className="fill" style={{ width: Math.round(Math.max(0, (s?.[6] ?? 0) / wMax) * 100) + "%" }} />
                      </div>
                      <span className="val head-fig md">{fmt(s?.[6] ?? 0, 3)}</span>
                    </div>
                  </td>
                  <td className="n last">
                    <span className="pos wide" style={{ background: POS[pos] || "#2b3642" }}>
                      {b.posRank ? `${pos}${b.posRank}` : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selBlock && (
        <div className="psec">
          <div className="chart-label">
            {selBlock.season} week by week{selBlock.team ? ` · ${selBlock.team}` : ""}
          </div>
          <table className="pweeks">
            <colgroup>
              <col style={{ width: 74 }} /><col style={{ width: 86 }} /><col style={{ width: 96 }} />
              <col style={{ width: 104 }} /><col style={{ width: 96 }} /><col />
            </colgroup>
            <thead>
              <tr>
                <th className="t">Week</th><th className="n">Pts</th><th className="n">Vs avg</th>
                <th className="n">Vs repl</th><th className="n">WAA</th><th className="n key">WAR</th>
              </tr>
            </thead>
            <tbody>
              {[...new Set([...selBlock.weeks.map(w => w[0]), ...Object.keys(selBlock.abs).map(Number)])]
                .sort((a, b) => a - b)
                .map(wk => {
                  const w = selBlock.weeks.find(x => x[0] === wk);
                  if (!w) return (
                    <tr key={wk}>
                      <td className="wk t">W{wk}</td>
                      <td className="out">{ABS_LABEL[selBlock.abs[wk]] ?? selBlock.abs[wk]}</td>
                      <td className="n" style={{ color: "var(--dim3)" }}>—</td>
                      <td className="n" style={{ color: "var(--dim3)" }}>—</td>
                      <td className="n" style={{ color: "var(--dim3)" }}>—</td>
                      <td className="war n" style={{ color: "var(--dim3)" }}>—</td>
                    </tr>
                  );
                  return (
                    <tr key={wk}>
                      <td className="wk t">W{wk}</td>
                      <td className="n fig">{fmt(w[1], 1)}</td>
                      <td className={`n ${clsOf(w[2])}`}>{sgn(w[2], 1)}</td>
                      <td className={`n ${clsOf(w[3])}`}>{sgn(w[3], 1)}</td>
                      <td className={`n ${clsOf(w[4])}`}>{sgn(w[4])}</td>
                      <td className={`war n ${clsOf(w[5])}`}>{sgn(w[5])}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      <div className="footnote" style={{ marginTop: 20 }}>
        WAA belongs here and only here — against the average <i>startable</i> player, roughly half the pool
        is negative by definition · vs repl is the margin over the best man left out of the 108-slot pool
      </div>
    </>
  );
}

function Stat({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div className="php-stat">
      <div className="k">{k}</div>
      <div className="v" style={{ color }}>{v}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

/** Projected WAR by year: the p20–p80 band as a bar, the composite as a rule. */
function ProjPanel({ p, years, pos }: { p: ProjRec; years: number[]; pos: string }) {
  const W = 420;
  const max = Math.max(0.001, ...p.comp_high) * 1.08;
  const px = (v: number) => Math.max(0, Math.min(W, (v / max) * W));
  const step = max > 3 ? 1 : max > 1.6 ? 0.5 : 0.25;
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(+t.toFixed(2));
  return (
    <div className="ppanel">
      <div className="chart-label">Projected WAR · composite, bar is the likely range</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {years.map((y, i) => (
          <div key={y} className="prow">
            <div className="yr">{y}</div>
            <svg viewBox={`0 0 ${W} 26`} preserveAspectRatio="none">
              {ticks.map(t => (
                <line key={t} x1={px(t)} y1={0} x2={px(t)} y2={26}
                  stroke={t === 0 ? "#4e5d6c" : "var(--rule)"} strokeWidth={1} />
              ))}
              <rect x={px(p.comp_low[i])} y={8} width={Math.max(2, px(p.comp_high[i]) - px(p.comp_low[i]))}
                height={10} fill="#3a3620" />
              <line x1={px(p.composite[i])} y1={4} x2={px(p.composite[i])} y2={22} stroke="var(--acc)" strokeWidth={3} />
            </svg>
            <div className="mid">{fmt(p.composite[i], 2)}</div>
            <div className="rng">
              {fmt(p.comp_low[i], 2)} – {fmt(p.comp_high[i], 2)}
              {p.posFin?.[i] ? `  ·  ${pos}${p.posFin[i]}` : ""}
            </div>
          </div>
        ))}
      </div>
      <div className="paxis">
        <div className="pad" />
        <div className="scale">
          {ticks.map(t => <span key={t} style={{ left: (px(t) / W * 100).toFixed(2) + "%" }}>{fmt(t, 2)}</span>)}
        </div>
        <div className="tail" />
      </div>
      <div className="pnote" style={{ marginTop: 10 }}>
        3-year total {fmt(p.total_comp, 2)} · age {p.age} · {p.exp ?? "—"} seasons · bye week {p.bye ?? "—"}
      </div>
    </div>
  );
}
