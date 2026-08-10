import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Absences, CviFile, DviFile, KnnFile, KnnProjection, MatrixFile, MatrixModel,
  MatrixRow, Ownership, PlayerShard, SummaryRow, Team, Values, Weekly, WeeklyRow,
} from "../lib/types";
import { jDaily, jl, jlDaily } from "../lib/data";
import { fmt, mean } from "../lib/stats";
import { pInfo, POS_COLOR, rosterSeasonOf } from "../lib/league";
import { useLeague } from "../lib/context";
import PosBadge from "../components/PosBadge";
import TScroll from "../components/TScroll";
import WeekGrid from "../components/WeekGrid";
import QuickJump from "../components/QuickJump";
import HonorMarks, { HonorLegend, HonorSprite } from "../components/HonorMarks";
import {
  honorTotals, loadCareer, loadHonors, ownerSplits, playerHonors, yearSpan,
  type CareerSeason, type HonorIndex, type OwnerSplit,
} from "../lib/honors";

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

/** The six curves, as three models x two streams. The lens picks which MODEL
 *  carries the accent; all six stay on screen, because the disagreement between
 *  them is the thing worth reading. Hiding four of six behind a control would
 *  turn a comparison into a single answer with extra steps. */
const MODELS: { key: MatrixModel; label: string; desc: string }[] = [
  { key: "scalar", label: "Scalar",
    desc: "the shipped model — one recency-weighted level, aged forward" },
  { key: "analog", label: "Analog",
    desc: "nearest historical comparables and what they actually returned" },
  { key: "blend", label: "Blend",
    desc: "the two naturals mixed by how good the analog's cohort is" },
];

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
  /** league-wide honor index — loaded once per page load, shared by every player */
  const [honors, setHonors] = useState<HonorIndex | null>(null);
  /** this player's league seasons — the career table's rows */
  const [career, setCareer] = useState<CareerSeason[] | null>(null);
  /** career split by the franchise that held him — the table's footer */
  const [splits, setSplits] = useState<OwnerSplit[]>([]);
  /** the experimental analog projection, shown beside the parametric one */
  const [knn, setKnn] = useState<KnnProjection | null>(null);
  /** the six-curve matrix, and which model the comparison table accents */
  const [mx, setMx] = useState<MatrixRow | null>(null);
  const [mxMeta, setMxMeta] = useState<MatrixFile["meta"] | null>(null);
  const [model, setModel] = useState<MatrixModel>("blend");

  const last = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1];
  /** the open career row. Null means every row is collapsed — the week grid is
   *  a drawer now, so nothing is fetched until a season is actually opened. */
  const wkSeason = weekSeason && meta.seasons.includes(weekSeason) ? weekSeason : null;

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
    jl<Team[]>(`${rosterSeasonOf(league)}/teams.json`)
      .then(t => { if (live) setTeams(t); }).catch(() => {});
    jDaily<Values>("data/values.json").then(v => { if (live) setVals(v); }).catch(() => {});
    loadHonors(meta.seasons).then(h => { if (live) setHonors(h); }).catch(() => {});
    jl<KnnFile>("projections_knn_hybrid.json")
      .then(k => { if (live) setKnn(k.players.find(p => p.pid === pid) ?? null); })
      .catch(() => {});
    jl<MatrixFile>("projections_matrix.json")
      .then(m => {
        if (!live) return;
        setMxMeta(m.meta);
        setMx(m.players.find(p => p.pid === pid) ?? null);
      })
      .catch(() => {});
    loadCareer(meta.seasons).then(c => {
      if (!live) return;
      const rows = c[pid] ?? [];
      setCareer(rows);
      // splits fetch weekly data only for seasons he changed hands in
      ownerSplits(rows).then(s => { if (live) setSplits(s); }).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, [pid, last, league, meta]);

  /**
   * The open drawer's two files, and ONLY those.
   *
   * wkSeason changes every time a career row is clicked, and it used to sit in
   * the dependency list above — so opening a drawer re-ran the whole cascade:
   * the shard, both indices, ownership, teams, market values, the league-wide
   * honor index and the career build. All of it cached, none of it free, and it
   * reset state the page was already showing. A drawer toggle is a drawer
   * fetch.
   */
  useEffect(() => {
    if (!wkSeason) return;
    let live = true;
    jl<Weekly>(`${wkSeason}/weekly.json`)
      .then(w => { if (live) setWks((w[pid] || []).slice().sort((a, b) => a[0] - b[0])); })
      .catch(() => { if (live) setWks([]); });
    jl<Absences>(`${wkSeason}/absence.json`)
      .then(a => { if (live) setAbs(a[pid] || {}); }).catch(() => { if (live) setAbs({}); });
    return () => { live = false; };
  }, [pid, wkSeason]);

  const refs = {
    projection: useRef<HTMLDivElement>(null),
    career: useRef<HTMLDivElement>(null),
    ownership: useRef<HTMLDivElement>(null),
    market: useRef<HTMLDivElement>(null),
  };
  const goto = (k: keyof typeof refs) =>
    refs[k].current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const [nm, pos, nfl] = pInfo(players, pid);
  const proj = shard?.proj ?? null;
  const years = shard?.years ?? [];
  /** the accented model, forced back to scalar for a player with no cohort.
   *  Derived rather than corrected in state: the lens remembers what the reader
   *  picked, so navigating from a player who has an analog read to one who does
   *  not and back does not silently reset their choice. */
  const modelOn: MatrixModel = mx && !mx.has_analog ? "scalar" : model;
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

  /**
   * The 80% band for the model the six-curve table is accenting.
   *
   * Each model owns its own uncertainty and they are not interchangeable: the
   * scalar band is the residual spread of the fitted aging curve, the analog
   * band is p20/p80 of THIS player's cohort. Blend interpolates by the same
   * `trust` that mixes the two point estimates, so the band and the figure it
   * sits under are always built from the same weighting.
   *
   * Declared HERE, above the `shard === undefined` guard below, with every
   * other hook. Hooks must run in the same order on every render, and this one
   * originally sat down with the render-time derivations past that early
   * return — so the first paint ran one fewer hook than the second and React
   * bailed out with "rendered more hooks than during the previous render".
   */
  const band = useMemo(() => {
    const none = { lo: null as number[] | null, hi: null as number[] | null };
    const p = shard?.proj ?? null;
    if (!p) return none;
    const sc = { lo: p.nat_low, hi: p.nat_high };
    if (modelOn === "scalar" || !knn?.low || !knn?.high) return sc;
    const an = { lo: knn.low, hi: knn.high };
    if (modelOn === "analog") return an;
    const t = mx?.trust ?? 0;
    const mix = (a: number[], b: number[]) =>
      b.map((val, i) => t * val + (1 - t) * (a[i] ?? val));
    return { lo: mix(sc.lo, an.lo), hi: mix(sc.hi, an.hi) };
  }, [shard, knn, mx, modelOn]);

  if (shard === undefined) return <div className="empty">Loading player…</div>;

  // wks goes null again whenever a different season is opened. That is a
  // reload of ONE drawer, not of the page — gating the whole render on it
  // flashed "Loading player…" over everything on every click.
  const reg = (wks ?? []).filter(w => w[0] <= 14);
  /** newest league season, for the figure strip. Read from the career rows
   *  rather than the week fetch, so the strip no longer depends on a drawer
   *  being open. */
  const lastRow = career?.find(r => r.season === last) ?? career?.[0] ?? null;

  /** the career table's totals row. PPG is points over games, not the mean of
   *  the per-season averages — a four-game season should not weigh as much as
   *  a full one. */
  const tot = career?.length ? {
    seasons: career.length,
    gp: career.reduce((s, r) => s + r.gp, 0),
    pts: career.reduce((s, r) => s + r.pts, 0),
    war: career.reduce((s, r) => s + r.war, 0),
    /** mean position finish. Belongs on the average row and NOT on the career
     *  row above it: a total of ranks is meaningless, but a mean of them is
     *  exactly what "average season" claims to be. Seasons he went unranked are
     *  left out rather than counted as a bad finish. */
    finish: (() => {
      const r = career.filter(x => x.posRank != null).map(x => x.posRank as number);
      return r.length ? r.reduce((a, b) => a + b, 0) / r.length : null;
    })(),
  } : null;

  /** open a season's drawer and bring it into view; clicking the open one closes it.
   *  Both setters are called from the handler, not from inside the updater — a
   *  state updater has to be pure, and React runs it twice under StrictMode. */
  const openSeason = (s: string, scroll = false) => {
    const next = weekSeason === s ? null : s;
    setWeekSeason(next);
    if (next) setWks(null);
    if (scroll) refs.career.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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

  /** career honors: the rail row is the total, the ladder carries the seasons */
  const honorRows = playerHonors(honors, pid);
  const honorBySeason = new Map(honorRows.map(r => [r.season, r.keys]));
  const honorCareer = honorTotals(honorRows);

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
  const rangeMax = proj
    ? Math.max(0.001, ...((mx ? band.hi : stHi) ?? proj.comp_high))
    : 1;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Player</span>
        <QuickJump />
      </div>
      <HonorSprite />
      <div className="board" style={{ marginTop: 0 }}>
        {/* the position tint is declared once here, not on the rail: the career
            table needs it too, and scoping it to the rail left every crown and
            gem in the table falling back to gray */}
        <div className={`split pos-mark-${pos}`}>
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

            {honorCareer.length > 0 && (
              <>
                {/* Scoped on purpose: honors are league seasons only, and the
                    ladder above runs back further than the league does. */}
                <div className="rail-h">Honors · in league</div>
                <div className="rail-honors">
                  <HonorMarks marks={honorCareer} />
                </div>
              </>
            )}

            {ladder.length > 0 && <>
              <div className="rail-h">Career WAR</div>
              <div className="rail-ladder">
                {ladder.map(([y, w]) => {
                  const isProj = projected.some(([py]) => py === y);
                  // Three kinds of row, and only one of them is pickable.
                  // A projected year has no weeks. A season before the league
                  // existed has no career row to open and no honors to earn —
                  // it is career context, not league history, and it says so by
                  // sitting back. Leaving it clickable pointed at a row that
                  // was never rendered.
                  const inLeague = meta.seasons.includes(String(y));
                  const pick = !isProj && inLeague;
                  const on = pick && String(y) === wkSeason;
                  return (
                    <div key={y} role={pick ? "button" : undefined}
                      tabIndex={pick ? 0 : undefined}
                      title={pick ? `Open ${y} in the career table`
                        : isProj ? undefined : `${y} — before the league began`}
                      className={`rail-war${isProj ? " proj" : pick ? " pick" : " pre"}${on ? " mark" : ""}`}
                      onClick={pick ? () => openSeason(String(y), true) : undefined}
                      onKeyDown={pick ? e => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault(); openSeason(String(y), true);
                        }
                      } : undefined}>
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
              <button onClick={() => goto("career")}>Career</button>
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
                <div className="figkey">{lastRow?.season ?? last} WAR</div>
                <div className="figval">{lastRow ? fmt(lastRow.war, 2) : "—"}</div>
                <div className="figsub">{lastRow
                  ? `${pos}${lastRow.posRank ?? "—"} · ${lastRow.gp} games`
                  : `did not play ${last}`}</div>
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

            {/* The projection section is the six-curve table when the matrix is
                available. The three-stream table below is the fallback for a
                deploy whose data predates projections_matrix.json — same band,
                same slot, so the page never loses its projection. */}
            {proj && years.length > 0 && mx && (
              <div ref={refs.projection}>
                <div className="band">
                  <span className="band-label">Projection · {years[0]}–{years[years.length - 1]}</span>
                  {/* One line. The figures that drive the table but appear
                      nowhere in it — trust, and Sleeper's year-one share — ride
                      here as tokens with the explanation on hover, rather than
                      as a paragraph underneath. */}
                  <span className="band-note">
                    {MODELS.find(m => m.key === modelOn)?.desc} · 80% band
                    {mx.trust != null && <>
                      {" · "}
                      <span title={`How dense his cohort of comparables is (median distance ${fmt(mx.d_med ?? 0, 2)}${mx.padded ? ", padded past the cutoff" : ""}). A tight cohort keeps the analog's own read; a thin one hands the answer to the scalar model and to Sleeper.`}>
                        trust {fmt(mx.trust, 2)}
                      </span>
                    </>}
                    {mx.w_sleeper != null && <>
                      {" · "}
                      <span title={`Sleeper projects ${num(Math.round(mx.pts13))} points over 13 games, worth ${fmt(mx.sleeper_war ?? 0, 2)} WAR. The analog composite takes it at this weight in year one; scalar and blend take it at ${Math.round((mxMeta?.blend_w?.[0] ?? 0.9) * 100)}%.`}>
                        Sleeper {Math.round(mx.w_sleeper * 100)}%
                      </span>
                    </>}
                  </span>
                </div>
                <div className="lens">
                  {MODELS.map(m => (
                    <button key={m.key} type="button" title={m.desc}
                      className={`seg${m.key === modelOn ? " on" : ""}`}
                      disabled={m.key !== "scalar" && !mx.has_analog}
                      onClick={() => setModel(m.key)}>{m.label}</button>
                  ))}
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr className="grp">
                      <th colSpan={2}></th>
                      {MODELS.map(m => (
                        <th key={m.key} scope="colgroup" colSpan={2}
                          className={`edge${m.key === modelOn ? " value" : ""}`}>
                          {m.label}
                        </th>
                      ))}
                      <th scope="colgroup" className="edge" colSpan={2}>
                        {MODELS.find(m => m.key === modelOn)?.label} view
                      </th>
                    </tr>
                    <tr>
                      <th scope="col" className="t" style={{ width: "9%" }}>Season</th>
                      <th scope="col" className="n" style={{ width: "6%" }}>Age</th>
                      {MODELS.map(m => (
                        <Fragment key={m.key}>
                          <th scope="col" className="n edge" style={{ width: "10%" }}>Natural</th>
                          <th scope="col" className="n" style={{ width: "10%" }}>Composite</th>
                        </Fragment>
                      ))}
                      <th scope="col" className="t key edge" style={{ width: "27%" }}>Range</th>
                      <th scope="col" className="n" style={{ width: "8%" }}>Position finish</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mx.blend_natural.map((_, i) => (
                      <tr key={i} className={i % 2 ? "zebra" : ""}>
                        <td className="t fig strong">{years[i] ?? `Year ${i + 1}`}</td>
                        <td className="n fig quiet">{mx.age == null ? "—" : mx.age + i}</td>
                        {MODELS.map(m => {
                          /* A model with no cohort has no read. The JSON carries
                             the scalar fallback so downstream consumers get a
                             number, but repeating it here under an "Analog"
                             header would claim a measurement that never
                             happened — so it reads as an em dash instead. */
                          const off = m.key !== "scalar" && !mx.has_analog;
                          const on = m.key === modelOn && !off;
                          return (
                            <Fragment key={m.key}>
                              {(["natural", "composite"] as const).map((s, k) => {
                                const v = mx[`${m.key}_${s}` as const][i];
                                /* no Sleeper above the pts13 floor means the
                                   composite IS the natural — shown, but never
                                   accented, so an echo cannot read as a second
                                   opinion */
                                const echo = s === "composite" && !mx.has_sleeper;
                                return (
                                  <td key={s} className={`n${k === 0 ? " edge" : ""}${on && !echo ? "" : " fig quiet"}`}>
                                    {off ? <span className="fig quiet">—</span>
                                      : on && !echo
                                        ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmt(v, 2)}</span>
                                        : fmt(v, 2)}
                                  </td>
                                );
                              })}
                            </Fragment>
                          );
                        })}
                        <td className="t edge" style={{ whiteSpace: "normal" }}>
                          {band.lo && band.hi ? <>
                            <div className="range-band">
                              <div className="fill" style={{
                                left: `${(Math.max(0, band.lo[i] ?? 0) / rangeMax * 100).toFixed(1)}%`,
                                width: `${(Math.max(0, (band.hi[i] ?? 0) - Math.max(0, band.lo[i] ?? 0)) / rangeMax * 100).toFixed(1)}%`,
                              }} />
                              <div className="tick" style={{ left: `${(Math.max(0, mx[`${modelOn}_natural` as const][i]) / rangeMax * 100).toFixed(1)}%` }} />
                            </div>
                            <div className="range-ends">
                              <span>{fmt(band.lo[i] ?? 0, 2)}</span>
                              <span>{fmt(band.hi[i] ?? 0, 2)}</span>
                            </div>
                          </> : <span className="fig quiet">—</span>}
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

            {proj && years.length > 0 && !mx && (
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
                      <th scope="colgroup" className="edge" colSpan={3}>Paths</th>
                      <th scope="colgroup" className="edge value" colSpan={2}>{st.label} view</th>
                    </tr>
                    <tr>
                      <th scope="col" className="t" style={{ width: "9%" }}>Season</th>
                      <th scope="col" className="n" style={{ width: "7%" }}>Age</th>
                      {/* every path is named for what it is; the lens only
                          decides which one carries the accent */}
                      <th scope="col" className="n edge" style={{ width: "11%" }}>Composite</th>
                      <th scope="col" className="n" style={{ width: "11%" }}>Age curve</th>
                      <th scope="col" className="n" style={{ width: "11%" }}>Adjusted</th>
                      <th scope="col" className="t key edge" style={{ width: "37%" }}>Range</th>
                      <th scope="col" className="n" style={{ width: "14%" }}>Position finish</th>
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

            {knn && knn.near && knn.near.length > 0 && (
              <div>
                <div className="band">
                  <span className="band-label">Closest comparables · {knn.near.length} of {knn.n}</span>
                  <span className="band-note">
                    What each one actually returned over the three years after ·
                    cohort median match {knn.sim_med ?? 0}
                  </span>
                </div>
                <TScroll>
                <table style={{ tableLayout: "fixed" }}>
                  <thead>
                    <tr>
                      <th scope="col" className="t" style={{ width: "27%" }}>Comparable</th>
                      <th scope="col" className="n" style={{ width: "6%" }}>Age</th>
                      <th scope="col" className="t edge" style={{ width: "24%" }}>Points going in</th>
                      {[0, 1, 2].map(i => (
                        <th key={i} scope="col" className={`n${i === 0 ? " edge" : ""}`}
                          style={{ width: "11%" }}>Year {i + 1}</th>
                      ))}
                      <th scope="col" className="n edge" style={{ width: "10%" }}
                        title="0–100, higher is more alike: 100 is an identical profile, 0 is nothing in common. Comparable across players, and 50 is exactly the cutoff for joining a cohort — above it he was already in the neighbourhood, below it he was reached for.">
                        Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {knn.near.map((m, i) => (
                      <tr key={`${m.name}-${m.season}`} className={i % 2 ? "zebra" : ""}>
                        <td className="t name">{m.name ?? "—"} <span className="fig quiet">{m.season}</span></td>
                        <td className="n fig quiet">{m.age ?? "—"}</td>
                        {/* the same three numbers the match was made on, most
                            recent first. A slot he has no season for reads as a
                            dash: it is not a season in which he scored nothing. */}
                        <td className="t fig quiet edge">
                          {m.seen.map(v => v == null ? "—" : Math.round(v * 100)).join(" · ")}
                        </td>
                        {m.then.map((v, k) => (
                          <td key={k} className={`n${k === 0 ? " edge" : ""}`}>
                            {v == null
                              /* hurt or inactive that year — skipped, never
                                 scored. A real 0.00 below means he left the
                                 league, which is a different fact. */
                              ? <span className="fig quiet">—</span>
                              : <span className="fig" style={{
                                color: v > 0.005 ? "var(--good)"
                                  : v < -0.005 ? "var(--bad)" : "var(--dim)",
                              }}>{v > 0.005 ? "+" : v < -0.005 ? "−" : ""}{fmt(Math.abs(v), 2)}</span>}
                          </td>
                        ))}
                        {/* a 0-100 score is an index: a bare figure, never a
                            meter. A bar would only restate the number. */}
                        <td className="n edge last">
                          <span className="head-fig sm">{m.sim}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </TScroll>
              </div>
            )}

            <div ref={refs.career}>
              <div className="band">
                <span className="band-label">Career · league seasons</span>
                <span className="band-note">Open a season for its week grid · WAR vs the best player left out of the startable pool</span>
              </div>
              {career === null ? <div className="tnote" style={{ padding: "14px 22px 18px" }}>Loading career…</div>
                : career.length === 0 ? <div className="tnote" style={{ padding: "14px 22px 18px" }}>
                  No league seasons — this player has never been scored in the league.
                </div> : <>
                  <TScroll>
                  <table style={{ tableLayout: "fixed" }}>
                    <thead>
                      <tr>
                        <th scope="col" className="t" style={{ width: "9%" }}>Season</th>
                        <th scope="col" className="t" style={{ width: "30%" }}>Held by</th>
                        <th scope="col" className="n" style={{ width: "7%" }}>GP</th>
                        <th scope="col" className="n" style={{ width: "10%" }}>Points</th>
                        <th scope="col" className="n" style={{ width: "9%" }}>PPG</th>
                        <th scope="col" className="n key edge" style={{ width: "11%" }}>WAR</th>
                        <th scope="col" className="n" style={{ width: "10%" }}>Finish</th>
                        <th scope="col" className="t edge" style={{ width: "14%" }}>Honors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {career.map((r, i) => {
                        const on = r.season === wkSeason;
                        return (
                          <Fragment key={r.season}>
                            <tr className={`${i % 2 ? "zebra " : ""}click${on ? " open" : ""}`}
                              onClick={() => openSeason(r.season)}
                              title={`${on ? "Close" : "Open"} ${r.season} week by week`}>
                              <td className="t fig strong">{r.season}</td>
                              <td className="t name quiet"
                                title={r.owners.map(o => o.from
                                  ? `${o.team} · W${o.from}${o.to > o.from ? `–${o.to}` : ""}`
                                  : o.team).join("  →  ")}>
                                {r.owners.length
                                  ? r.owners.map((o, k) => (
                                    <Fragment key={`${o.team}-${o.from}`}>
                                      {k > 0 && <span className="held-arrow">→</span>}
                                      {o.team}
                                    </Fragment>
                                  ))
                                  : <span className="fig quiet">—</span>}
                              </td>
                              <td className="n fig quiet">{r.gp}</td>
                              <td className="n fig">{num(Math.round(r.pts))}</td>
                              <td className="n fig">{fmt(r.ppg, 1)}</td>
                              <td className="n edge"><span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmt(r.war, 2)}</span></td>
                              <td className="n fig">
                                {r.posRank
                                  ? <span className="pos wide" style={{ background: POS_COLOR[r.pos] || "var(--rule-2)" }}>{r.pos}{r.posRank}</span>
                                  : <span className="fig quiet">—</span>}
                              </td>
                              <td className="t last edge">
                                {r.keys.length
                                  ? <HonorMarks marks={r.keys} size={17} showCounts={false} />
                                  : <span className="fig quiet">—</span>}
                              </td>
                            </tr>
                            {on && (
                              <tr className="drawer-row">
                                <td colSpan={8}>
                                  <div style={{ padding: "14px 22px 18px" }}>
                                    {wks === null ? <div className="tnote">Loading {r.season}…</div>
                                      : reg.length ? <WeekGrid weeks={reg} absent={abs} />
                                        : <div className="tnote">No scored weeks in {r.season}.</div>}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                    {tot && (
                      <tfoot>
                        {/* One label cell spanning the season and Held by
                            columns. Split across two, a franchise name had 30%
                            of the table and clipped to a single letter. */}
                        <tr className="tot">
                          <td className="t fig strong" colSpan={2}>
                            Career<span className="tot-yrs">{tot.seasons} {tot.seasons === 1 ? "yr" : "yrs"}</span>
                          </td>
                          <td className="n fig">{tot.gp}</td>
                          <td className="n fig">{num(Math.round(tot.pts))}</td>
                          <td className="n fig">{tot.gp ? fmt(tot.pts / tot.gp, 1) : "—"}</td>
                          <td className="n edge"><span className="head-fig sm" style={{ color: "var(--acc)" }}>{fmt(tot.war, 2)}</span></td>
                          {/* Finish is a per-season rank and does not add up.
                              Best-of is a different statistic wearing this
                              column's header, so the career row leaves it. */}
                          <td className="n fig quiet">—</td>
                          <td className="t last edge">
                            {honorCareer.length
                              ? <HonorMarks marks={honorCareer} size={17} />
                              : <span className="fig quiet">—</span>}
                          </td>
                        </tr>
                        <tr className="tot sub">
                          <td className="t fig quiet" colSpan={2}>Average season</td>
                          <td className="n fig quiet">{fmt(tot.gp / tot.seasons, 1)}</td>
                          <td className="n fig quiet">{num(Math.round(tot.pts / tot.seasons))}</td>
                          <td className="n fig quiet">{tot.gp ? fmt(tot.pts / tot.gp, 1) : "—"}</td>
                          <td className="n fig quiet edge">{fmt(tot.war / tot.seasons, 2)}</td>
                          {/* a MEAN finish, so a figure rather than the badge the
                              per-season rows use — those are placings, this is
                              not, and rendering them alike would say he finished
                              RB8.4 in some season */}
                          <td className="n fig quiet">
                            {tot.finish == null ? "—" : `${pos} ${fmt(tot.finish, 1)}`}
                          </td>
                          {/* honors do not average — the career row above already
                              carries every mark he has */}
                          <td className="t last edge"><span className="fig quiet">—</span></td>
                        </tr>
                        {splits.length > 1 && splits.map(s => (
                          <tr key={s.rid} className="tot owner">
                            {/* the manager, not the team name — a franchise
                                renames itself most years and the splits have
                                to survive that */}
                            <td className="t name quiet" colSpan={2}
                              title={`${s.manager} — most recently ${s.team.trim()}`}>
                              {s.manager}
                              {/* the seasons themselves, not just how many:
                                  a count cannot tell you WHICH years were his */}
                              <span className="tot-yrs">{yearSpan(s.years)}</span>
                            </td>
                            <td className="n fig quiet">{s.gp}</td>
                            <td className="n fig quiet">{num(Math.round(s.pts))}</td>
                            <td className="n fig quiet">{s.gp ? fmt(s.pts / s.gp, 1) : "—"}</td>
                            <td className="n fig edge">{fmt(s.war, 2)}</td>
                            <td className="n fig quiet">
                              {s.finish == null ? "—" : `${pos} ${fmt(s.finish, 1)}`}
                            </td>
                            {/* what he won while this manager held him. A season
                                he changed hands in goes whole to whoever had him
                                longest — an award cannot be cut in half. */}
                            <td className="t last edge">
                              {s.keys.length
                                ? <HonorMarks marks={s.keys} size={17} />
                                : <span className="fig quiet">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tfoot>
                    )}
                  </table>
                  </TScroll>
                  <HonorLegend />
                  <div className="tnote" style={{ padding: "12px 22px 16px" }}>
                    The crown and the gem carry the position's color. Honors cover league seasons
                    only, and held by is the roster at season end — a player traded in November
                    shows his new team, with the moves themselves in the ownership table below.
                  </div>
                </>}
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
                      <th scope="col" className="t" style={{ width: "12%" }}>When</th>
                      <th scope="col" className="t" style={{ width: "12%" }}>Event</th>
                      <th scope="col" className="t" style={{ width: "76%" }}>Detail</th>
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
                      <th scope="colgroup" className="edge" colSpan={3}>Movement</th>
                      <th scope="colgroup" className="edge" colSpan={3}>Standing</th>
                      <th scope="colgroup" className="edge value" colSpan={1}>Implied</th>
                    </tr>
                    <tr>
                      <th scope="col" className="t" style={{ width: "16%" }}>Source</th>
                      <th scope="col" className="n" style={{ width: "10%" }}>Value</th>
                      <th scope="col" className="n edge" style={{ width: "9%" }}>7 day</th>
                      <th scope="col" className="n" style={{ width: "9%" }}>14 day</th>
                      <th scope="col" className="n" style={{ width: "9%" }}>30 day</th>
                      <th scope="col" className="n edge" style={{ width: "9%" }}>Overall</th>
                      <th scope="col" className="n" style={{ width: "9%" }}>Position</th>
                      <th scope="col" className="t" style={{ width: "19%" }}>Priced like</th>
                      <th scope="col" className="n key edge" style={{ width: "10%" }}>WAR / 3yr</th>
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
