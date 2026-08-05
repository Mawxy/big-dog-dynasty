import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Absences, CviFile, DviFile, Ownership, PlayerShard,
  SummaryRow, Team, Values, Weekly, WeeklyRow,
} from "../lib/types";
import { jDaily, jl, jlDaily } from "../lib/data";
import { fmt, sgn, mean } from "../lib/stats";
import { pInfo, POS_COLOR, rosterSeasonOf } from "../lib/league";
import { useLeague } from "../lib/context";
import PosBadge from "../components/PosBadge";
import TScroll from "../components/TScroll";
import WeekGrid from "../components/WeekGrid";
import QuickJump from "../components/QuickJump";

const num = (n: number) => n.toLocaleString("en-US");
const WINDOWS = ["7", "14", "30"] as const;

/** The projection streams, restored as a lens. Every one is a full 3-year path
 *  in projections.json; the control picks which is the headline and whose 80%
 *  band the Range column draws. All three stay visible as columns — the lens
 *  changes emphasis, not what you are allowed to see.
 *
 *  There is deliberately no separate Sleeper stream. Composite is 90% Sleeper
 *  in year 1, so the near-year figure already IS the points read; a fourth
 *  column would have restated it within a rounding error. */
const STREAMS = [
  { key: "composite", label: "Composite", line: "composite", lo: "comp_low", hi: "comp_high",
    desc: "Sleeper's points blended into the model — 90/50/10 by year" },
  { key: "proj", label: "Age curve", line: "proj", lo: "nat_low", hi: "nat_high",
    desc: "the model alone, if healthy — a full 13-game season" },
  { key: "expected", label: "Adjusted", line: "expected", lo: "adj_low", hi: "adj_high",
    desc: "the model × availability — carries injury risk" },
] as const;
type StreamKey = typeof STREAMS[number]["key"];

/**
 * Player page (3A): split rail. The rail carries identity and the career WAR
 * ladder — projected years above played ones, so decline is visible in the
 * rail alone; the content column carries the figure strip, the verdict, the
 * projection table, last season's week strip, ownership, and market value.
 */
export default function Player({ pid }: { pid: string }) {
  const { meta, players, league } = useLeague();
  const nav = useNavigate();
  const [shard, setShard] = useState<PlayerShard | null | undefined>(undefined);
  const [dvi, setDvi] = useState<{ dvi: number; rank: number; pos_rank: number } | null>(null);
  const [cvi, setCvi] = useState<{ cvi: number; rank: number; pos_rank: number } | null>(null);
  const [own, setOwn] = useState<Ownership>({});
  const [wks, setWks] = useState<WeeklyRow[] | null>(null);
  const [abs, setAbs] = useState<Record<string, string>>({});
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [vals, setVals] = useState<Values | null>(null);
  /** league-season WAR by year — the ladder fallback when there's no shard */
  const [leagueCareer, setLeagueCareer] = useState<[number, number][] | null>(null);
  /** which projection stream leads the table (the restored lens) */
  const [stream, setStream] = useState<StreamKey>("composite");
  /** which PLAYED season the week grid shows — the career ladder sets it */
  const [weekSeason, setWeekSeason] = useState<string | null>(null);

  const last = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1];
  /** the ladder's pick, falling back to the newest played season */
  const wkSeason = weekSeason && meta.seasons.includes(weekSeason) ? weekSeason : last;

  useEffect(() => {
    let live = true;
    jl<PlayerShard>(`player/${pid}.json`)
      .then(sh => { if (live) setShard(sh); })
      .catch(async () => {
        // 404 = no projection; the ladder falls back to league seasons
        const sums = await Promise.all(meta.seasons.map(s =>
          jl<SummaryRow[]>(`${s}/summary.json`).catch(() => [] as SummaryRow[])));
        if (!live) return;
        const career: [number, number][] = [];
        meta.seasons.forEach((s, i) => {
          const r = sums[i].find(x => x[0] === pid);
          if (r) career.push([+s, r[6]]);
        });
        setLeagueCareer(career);
        setShard(null);
      });
    jlDaily<DviFile>("dvi.json").then(d => { if (live) setDvi(d.players[pid] ?? null); }).catch(() => {});
    jlDaily<CviFile>("cvi.json").then(d => { if (live) setCvi(d.players[pid] ?? null); }).catch(() => {});
    jl<Ownership>("ownership.json").then(o => { if (live) setOwn(o); }).catch(() => {});
    jl<Weekly>(`${wkSeason}/weekly.json`)
      .then(w => { if (live) setWks((w[pid] || []).slice().sort((a, b) => a[0] - b[0])); })
      .catch(() => { if (live) setWks([]); });
    jl<Absences>(`${wkSeason}/absence.json`)
      .then(a => { if (live) setAbs(a[pid] || {}); }).catch(() => { if (live) setAbs({}); });
    jl<Team[]>(`${rosterSeasonOf(league)}/teams.json`)
      .then(t => { if (live) setTeams(t); }).catch(() => {});
    jDaily<Values>("data/values.json").then(v => { if (live) setVals(v); }).catch(() => {});
    return () => { live = false; };
  }, [pid, last, wkSeason, league, meta]);

  const refs = {
    projection: useRef<HTMLDivElement>(null),
    lastSeason: useRef<HTMLDivElement>(null),
    ownership: useRef<HTMLDivElement>(null),
    market: useRef<HTMLDivElement>(null),
  };
  const goto = (k: keyof typeof refs) =>
    refs[k].current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const [nm, pos, nfl] = pInfo(players, pid);
  const proj = shard?.proj ?? null;
  const years = shard?.years ?? [];
  const owner = useMemo(() => {
    const t = teams?.find(x => x.players.includes(pid));
    return t ? t.team : null;
  }, [teams, pid]);

  const events = own[pid] || [];
  const v = vals?.players[pid];
  const market = useMemo(() => {
    if (!v) return [];
    const closest = (list: [string, number][] | undefined, val: number) => {
      if (!list?.length) return null;
      let best = list[0];
      for (const pk of list) if (Math.abs(pk[1] - val) < Math.abs(best[1] - val)) best = pk;
      return best;
    };
    return [
      { src: "KeepTradeCut", value: v.ktc, ovr: v.ktcRank, posRank: v.ktcPosRank, t: v.ktcT, imp: v.impWar?.ktc ?? null, picks: vals?.picks?.ktc },
      { src: "FantasyCalc", value: v.fc, ovr: v.fcRank, posRank: v.fcPosRank, t: v.fcT, imp: v.impWar?.fc ?? null, picks: vals?.picks?.fc },
    ].filter(m => m.value != null).map(m => ({
      ...m, value: m.value as number, pick: closest(m.picks, m.value as number),
    }));
  }, [v, vals]);

  if (shard === undefined) return <div className="empty">Loading player…</div>;

  // wks goes null again whenever the ladder picks a new season. That is a
  // reload of ONE section, not of the page — gating the whole render on it
  // flashed "Loading player…" over everything on every click.
  const reg = (wks ?? []).filter(w => w[0] <= 14);
  const lastWar = reg.length ? reg.reduce((s, w) => s + w[5], 0) : null;

  /** ladder rows, newest first: projected years above played ones */
  const played: [number, number][] = proj?.career ?? leagueCareer ?? [];
  const projected: [number, number][] = proj
    ? years.map((y, i) => [y, proj.composite[i] ?? 0] as [number, number])
    : [];
  const ladder = [...projected.slice().reverse(), ...played.slice().reverse()];
  const ladderMax = Math.max(0.001, ...ladder.map(([, w]) => Math.max(0, w)));
  const careerWar = played.reduce((s, [, w]) => s + w, 0);
  const firstYear = played.length ? played[0][0] : null;

  const barColor = (w: number) =>
    w >= 1.5 ? "var(--acc)" : w >= 0.75 ? "var(--acc-dim)" : "var(--dim)";

  /** verdict prose — generated from the payload, never hand-written */
  const verdict = proj && years.length >= 3 ? (() => {
    const c = proj.composite;
    const lastIdx = Math.min(2, c.length - 1);
    const dir = (c[lastIdx] ?? 0) - (c[0] ?? 0);
    const trend = dir > 0.15 ? "rising" : dir < -0.15 ? "declining" : "holding";
    const curveGap = mean(c.map((x, i) => x - (proj.proj[i] ?? 0)));
    const width = (proj.comp_high[0] ?? 0) - (proj.comp_low[0] ?? 0);
    const fin = proj.posFin?.[0] ? `, a ${pos}${proj.posFin[0]} finish` : "";
    return {
      meta: `${years[0]} composite ${fmt(c[0], 2)} WAR · band ${fmt(proj.comp_low[0], 2)} to ${fmt(proj.comp_high[0], 2)}`,
      body: `Year one projects ${fmt(c[0], 2)} WAR${fin}. The three-year path is ${trend} — `
        + `${fmt(c[0], 2)} in ${years[0]} to ${fmt(c[lastIdx], 2)} by ${years[lastIdx]}. `
        + `The composite reads ${curveGap >= 0 ? "above" : "below"} the pure age-curve path by `
        + `${fmt(Math.abs(curveGap), 2)} WAR a year, and the 80% band on year one spans `
        + `${fmt(width, 2)} WAR.`,
    };
  })() : null;

  const st = STREAMS.find(s => s.key === stream) ?? STREAMS[0];
  /** the selected stream's path; Sleeper is absent for most of the file */
  const stLine: number[] | null = proj ? (proj[st.line] as number[]) : null;
  const stLo = proj ? (proj[st.lo] as number[]) : null;
  const stHi = proj ? (proj[st.hi] as number[]) : null;
  // the axis has to hold whichever band is showing, not always the composite's
  const rangeMax = proj ? Math.max(0.001, ...(stHi ?? proj.comp_high)) : 1;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Player</span>
        <QuickJump />
      </div>
      <div className="board" style={{ marginTop: 0 }}>
        <div className="split">
          <div className="rail">
            <span className="rail-back" onClick={() => nav(-1)}>← Back</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <PosBadge pos={pos} />
              {nfl && <span style={{ font: "600 13px/1 var(--cond)", letterSpacing: ".12em", color: "var(--dim)" }}>{nfl}</span>}
            </div>
            <div className="rail-name">{nm}</div>
            <div className="rail-sub">
              {proj && <>age {proj.age} · {proj.exp ?? 0} seasons · bye {proj.bye ?? "—"} · </>}
              {owner ?? "free agent"}
            </div>

            {ladder.length > 0 && <>
              <div className="rail-h">Career WAR</div>
              <div className="rail-ladder">
                {ladder.map(([y, w]) => {
                  const isProj = projected.some(([py]) => py === y);
                  // A projected year has no weeks to show, so it stays inert.
                  // Only played seasons are pickable, and the one showing below
                  // takes the accent — the same rule as the franchise ladder.
                  const on = !isProj && String(y) === wkSeason;
                  return (
                    <div key={y} role={isProj ? undefined : "button"}
                      tabIndex={isProj ? undefined : 0}
                      title={isProj ? undefined : `Show ${y} week by week`}
                      className={`rail-war${isProj ? " proj" : " pick"}${on ? " mark" : ""}`}
                      onClick={isProj ? undefined : () => {
                        setWeekSeason(String(y));
                        setWks(null);
                        refs.lastSeason.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                      onKeyDown={isProj ? undefined : e => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault(); setWeekSeason(String(y)); setWks(null);
                        }
                      }}>
                      <span className="yr">{y}</span>
                      <span className="bar">
                        <i style={{
                          width: `${Math.round(Math.max(0, w) / ladderMax * 100)}%`,
                          background: isProj ? "var(--dim)" : barColor(w),
                        }} />
                      </span>
                      <span className="v">{fmt(w, 2)}</span>
                    </div>
                  );
                })}
              </div>
            </>}

            <div className="rail-h">On this page</div>
            <div className="rail-nav">
              {proj && <button onClick={() => goto("projection")}>Projection</button>}
              <button onClick={() => goto("lastSeason")}>Week by week</button>
              {events.length > 0 && <button onClick={() => goto("ownership")}>Ownership</button>}
              {market.length > 0 && <button onClick={() => goto("market")}>Market value</button>}
            </div>
          </div>

          <div className="main">
            <div className="figstrip">
              <div className="figcell">
                <div className="figkey">Dynasty index</div>
                <div className="figval acc">{dvi ? fmt(dvi.dvi, 1) : "—"}</div>
                <div className="figsub">{dvi ? `#${dvi.rank} overall · ${pos}${dvi.pos_rank}` : "no index"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Contender index</div>
                <div className="figval acc">{cvi ? fmt(cvi.cvi, 1) : "—"}</div>
                <div className="figsub">{cvi ? `#${cvi.rank} this season · ${pos}${cvi.pos_rank}` : "no index"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">{wkSeason} WAR</div>
                <div className="figval">{wks === null ? "—" : lastWar == null ? "—" : fmt(lastWar, 2)}</div>
                <div className="figsub">{wks === null ? "loading"
                  : lastWar == null ? `did not play ${wkSeason}` : "regular season"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Career WAR</div>
                <div className="figval">{played.length ? fmt(careerWar, 2) : "—"}</div>
                <div className="figsub">{firstYear ? `since ${firstYear}` : "no seasons"}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Next 3 years</div>
                <div className="figval">{proj ? fmt(proj.total_comp, 2) : "—"}</div>
                <div className="figsub">composite WAR</div>
              </div>
            </div>

            {verdict && (
              <div className="verdict">
                <div className="k">Model read</div>
                <div className="meta">{verdict.meta}</div>
                <div className="body">{verdict.body}</div>
              </div>
            )}

            {proj && years.length > 0 && (
              <div ref={refs.projection}>
                <div className="band">
                  <span className="band-label">Projection · {years[0]}–{years[years.length - 1]}</span>
                  <span className="band-note">{st.desc} · range is the 80% band</span>
                </div>
                <div className="lens">
                  {STREAMS.map(s => (
                    <button key={s.key} type="button" title={s.desc}
                      className={`seg${s.key === stream ? " on" : ""}`}
                      onClick={() => setStream(s.key)}>{s.label}</button>
                  ))}
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr className="grp">
                      <th colSpan={2}></th>
                      <th className="edge" colSpan={3}>Paths</th>
                      <th className="edge value" colSpan={2}>{st.label} view</th>
                    </tr>
                    <tr>
                      <th className="t" style={{ width: "9%" }}>Season</th>
                      <th className="n" style={{ width: "7%" }}>Age</th>
                      {/* every path is named for what it is; the lens only
                          decides which one carries the accent */}
                      <th className="n edge" style={{ width: "11%" }}>Composite</th>
                      <th className="n" style={{ width: "11%" }}>Age curve</th>
                      <th className="n" style={{ width: "11%" }}>Adjusted</th>
                      <th className="t key edge" style={{ width: "37%" }}>Range</th>
                      <th className="n" style={{ width: "14%" }}>Position finish</th>
                    </tr>
                  </thead>
                  <tbody>
                    {years.map((y, i) => (
                      <tr key={y} className={i % 2 ? "zebra" : ""}>
                        <td className="t fig strong">{y}</td>
                        <td className="n fig quiet">{proj.age + i}</td>
                        {STREAMS.map((s, k) => {
                          const v = (proj[s.line] as number[])[i];
                          const on = s.key === stream;
                          return (
                            <td key={s.key} className={`n${k === 0 ? " edge" : ""}${on ? "" : " fig quiet"}`}>
                              {v == null ? <span className="fig quiet">—</span>
                                : on ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmt(v, 2)}</span>
                                  : fmt(v, 2)}
                            </td>
                          );
                        })}
                        <td className="t edge" style={{ whiteSpace: "normal" }}>
                          <div className="range-band">
                            <div className="fill" style={{
                              left: `${(Math.max(0, stLo?.[i] ?? 0) / rangeMax * 100).toFixed(1)}%`,
                              width: `${(Math.max(0, (stHi?.[i] ?? 0) - Math.max(0, stLo?.[i] ?? 0)) / rangeMax * 100).toFixed(1)}%`,
                            }} />
                            <div className="tick" style={{ left: `${(Math.max(0, stLine?.[i] ?? 0) / rangeMax * 100).toFixed(1)}%` }} />
                          </div>
                          <div className="range-ends">
                            <span>{fmt(stLo?.[i] ?? 0, 2)}</span>
                            <span>{fmt(stHi?.[i] ?? 0, 2)}</span>
                          </div>
                        </td>
                        <td className="n last">
                          {proj.posFin?.[i]
                            ? <span className="pos wide" style={{ background: POS_COLOR[pos] || "var(--rule-2)" }}>{pos}{proj.posFin[i]}</span>
                            : <span className="fig quiet">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TScroll>
              </div>
            )}

            <div ref={refs.lastSeason}>
              <div className="band">
                <span className="band-label">
                  {wkSeason === last ? "Last season" : "Season"} · {wkSeason}
                </span>
                <span className="band-note">Regular-season weeks · WAR vs the best player left out of the startable pool</span>
              </div>
              <div style={{ padding: "14px 22px 18px" }}>
                {wks === null ? <div className="tnote">Loading {wkSeason}…</div>
                  : reg.length ? <WeekGrid weeks={reg} absent={abs} />
                    : <div className="tnote">No scored weeks in {wkSeason} — the player was not in the league that season.</div>}
              </div>
            </div>

            {events.length > 0 && (
              <div ref={refs.ownership}>
                <div className="band">
                  <span className="band-label">Ownership</span>
                  <span className="band-note">Every roster event since the league began</span>
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th className="t" style={{ width: "12%" }}>When</th>
                      <th className="t" style={{ width: "12%" }}>Event</th>
                      <th className="t" style={{ width: "76%" }}>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.slice().reverse().map((e, i) => {
                      const kind = e[2].startsWith("traded") ? "Trade"
                        : e[2].startsWith("drafted") ? "Draft"
                          : e[2].includes("waiver") ? "Waiver" : "Move";
                      return (
                        <tr key={i} className={i % 2 ? "zebra" : ""}>
                          <td className="t fig" style={{ color: kind === "Trade" ? "var(--acc)" : undefined }}>
                            {e[0]}{e[1] ? ` W${e[1]}` : ""}
                          </td>
                          <td className="t fig quiet">{kind}</td>
                          <td className="t last" style={{ whiteSpace: "normal", font: "400 13px/1.55 var(--sans)", color: "var(--txt2)" }}>
                            {e[2]}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </TScroll>
              </div>
            )}

            {market.length > 0 && (
              <div ref={refs.market}>
                <div className="band">
                  <span className="band-label">Market value · as of {vals?.fetched ?? "—"}</span>
                  <span className="band-note">Priced like = the rookie pick currently worth the same · implied WAR runs the price through the value-to-WAR curve</span>
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr className="grp">
                      <th colSpan={2}></th>
                      <th className="edge" colSpan={3}>Movement</th>
                      <th className="edge" colSpan={3}>Standing</th>
                      <th className="edge value" colSpan={1}>Implied</th>
                    </tr>
                    <tr>
                      <th className="t" style={{ width: "16%" }}>Source</th>
                      <th className="n" style={{ width: "10%" }}>Value</th>
                      <th className="n edge" style={{ width: "9%" }}>7 day</th>
                      <th className="n" style={{ width: "9%" }}>14 day</th>
                      <th className="n" style={{ width: "9%" }}>30 day</th>
                      <th className="n edge" style={{ width: "9%" }}>Overall</th>
                      <th className="n" style={{ width: "9%" }}>Position</th>
                      <th className="t" style={{ width: "19%" }}>Priced like</th>
                      <th className="n key edge" style={{ width: "10%" }}>WAR / 3yr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {market.map((m, i) => (
                      <tr key={m.src} className={i % 2 ? "zebra" : ""}>
                        <td className="t name quiet">{m.src}</td>
                        <td className="n"><span className="head-fig sm">{num(m.value)}</span></td>
                        {WINDOWS.map((d, k) => {
                          const t = m.t?.[d];
                          return (
                            <td key={d} className={`n fig${k === 0 ? " edge" : ""}`}
                              style={{ color: t == null ? "var(--dim3)" : t > 0 ? "var(--good)" : t < 0 ? "var(--bad)" : "var(--dim)" }}>
                              {t == null ? "—" : t === 0 ? "0" : `${t > 0 ? "▲" : "▼"} ${num(Math.abs(t))}`}
                            </td>
                          );
                        })}
                        <td className="n fig edge">{m.ovr == null ? "—" : `#${m.ovr}`}</td>
                        <td className="n fig">{m.posRank == null ? "—" : `${pos}${m.posRank}`}</td>
                        <td className="t sub">{m.pick ? `${m.pick[0]} (${num(m.pick[1])})` : "—"}</td>
                        <td className="n last edge"><span className="head-fig sm" style={{ color: "var(--acc)" }}>{m.imp == null ? "—" : fmt(m.imp, 2)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TScroll>
                <div className="tnote" style={{ padding: "0 22px 16px" }}>
                  A dash in a movement column means the daily snapshot history doesn't reach back that far yet.
                  Deltas are raw value, not rank.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
