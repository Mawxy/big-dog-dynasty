import { useEffect, useMemo, useState } from "react";
import type { CviFile, DviFile, PicksOwned, PickValues, ProjectionsFile } from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { fmt, sgn } from "../lib/stats";
import { pickStream, ROUND_ORD } from "../lib/rosterModel";
import { POS_COLOR } from "../lib/league";
import { useMobile } from "../lib/useWidth";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

/**
 * Trade machine (1G): two baskets, each line priced in every currency the
 * site keeps — DVI, CVI, and 3-year composite WAR. Picks carry projected WAR
 * from the pick-value bridge and read — on both indices until they convert.
 *
 * The verdict never converts an index gap into a "side X wins": the two
 * indices answer different questions, and the copy says so.
 */
interface Asset {
  key: string; label: string; kind: "player" | "pick";
  pid?: string; pos?: string; age: number | null;
  dvi: number | null; cvi: number | null;
  /** players: 3-yr composite; picks: Bridge A slot/tier stream, summed */
  war: number;
}

const TIERS = ["Early", "Mid", "Late"];

export default function TradeCalc() {
  // MOBILE.md M7 — baskets stack and each asset is a two-line record with its
  // figures named; each basket closes with its own labelled total band
  const mobile = useMobile();
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [owned, setOwned] = useState<PicksOwned | null>(null);
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [cvi, setCvi] = useState<CviFile | null>(null);
  // keys, not Asset snapshots: an asset added before the index files resolve
  // re-resolves against the live options each render, so late loads fill in
  const [sideKeys, setSideKeys] = useState<[string[], string[]]>([[], []]);

  useEffect(() => {
    jl<ProjectionsFile>("projections.json").then(setProj).catch(() => {});
    // jlDaily, NOT jl: Draft.tsx fetches this file via jlDaily and the cache
    // keys on the path string — a bare jl here made two 1.4 MB downloads
    jlDaily<PickValues>("pick_values.json").then(setPv).catch(() => {});
    jl<PicksOwned>("picks_owned.json").then(setOwned).catch(() => {});
    jlDaily<DviFile>("dvi.json").then(setDvi).catch(() => {});
    jlDaily<CviFile>("cvi.json").then(setCvi).catch(() => {});
  }, []);

  const options = useMemo<Asset[]>(() => {
    if (!proj) return [];
    const out: Asset[] = [];
    for (const p of proj.players) {
      out.push({
        key: `p${p.pid}`, label: p.name, kind: "player", pid: p.pid, pos: p.pos,
        age: p.age ?? null,
        dvi: dvi?.players[p.pid]?.dvi ?? null,
        cvi: cvi?.players[p.pid]?.cvi ?? null,
        war: p.total_comp,
      });
    }
    if (pv) {
      const cur = pv.meta.generated_for_season + 1;   // current rookie class
      const sum = (s: number[]) => s.reduce((a, x) => a + x, 0);
      // current-year picks: every exact slot; Bridge A knows each one
      for (let r = 0; r < 4; r++)
        for (let s = 1; s <= 12; s++) {
          const bucket = `${r + 1}.${String(s).padStart(2, "0")}`;
          const tier = TIERS[Math.min(2, Math.floor((s - 1) / 4))];
          out.push({
            key: `k${cur} Pick ${bucket}`, label: `${cur} Pick ${bucket}`, kind: "pick",
            age: null, dvi: null, cvi: null,
            war: sum(pickStream(pv, tier, r + 1)),
          });
        }
      // future years: Early/Mid/Late tiers, out to every season picks are owned
      const lastYear = Math.max(cur + 2, ...(owned?.meta?.seasons ?? []));
      for (let y = cur + 1; y <= lastYear; y++)
        for (let r = 0; r < 4; r++)
          for (const tier of TIERS)
            out.push({
              key: `k${y} ${tier} ${ROUND_ORD[r]}`, label: `${y} ${tier} ${ROUND_ORD[r]}`, kind: "pick",
              age: null, dvi: null, cvi: null,
              war: sum(pickStream(pv, tier, r + 1)),
            });
    }
    return out;
  }, [proj, pv, owned, dvi, cvi]);

  const optByKey = useMemo(() => new Map(options.map(o => [o.key, o])), [options]);
  const sides = useMemo<[Asset[], Asset[]]>(() => [
    sideKeys[0].map(k => optByKey.get(k)).filter((a): a is Asset => !!a),
    sideKeys[1].map(k => optByKey.get(k)).filter((a): a is Asset => !!a),
  ], [sideKeys, optByKey]);

  const add = (side: 0 | 1, a: Asset) => setSideKeys(prev => {
    if (prev[0].includes(a.key) || prev[1].includes(a.key)) return prev;
    const next: [string[], string[]] = [[...prev[0]], [...prev[1]]];
    next[side] = [...next[side], a.key];
    return next;
  });
  const remove = (side: 0 | 1, key: string) => setSideKeys(prev => {
    const next: [string[], string[]] = [[...prev[0]], [...prev[1]]];
    next[side] = next[side].filter(k => k !== key);
    return next;
  });

  const tot = (s: Asset[]) => ({
    dvi: s.reduce((a, x) => a + (x.dvi ?? 0), 0),
    cvi: s.reduce((a, x) => a + (x.cvi ?? 0), 0),
    war: s.reduce((a, x) => a + x.war, 0),
    picks: s.filter(x => x.kind === "pick").length,
  });
  const tA = tot(sides[0]), tB = tot(sides[1]);
  const any = sides[0].length + sides[1].length > 0;

  /** prose that reads the signs without ever naming a winner */
  const prose = (() => {
    if (!any) return "Add players or picks to each side. Every asset is priced in dynasty index points, win-now index points, and projected 3-year WAR.";
    const lean = (d: number, unit: string, what: string) =>
      Math.abs(d) < 0.05 ? `the two sides are even on ${what}`
        : `Side ${d > 0 ? "A" : "B"} sends ${fmt(Math.abs(d), unit === "WAR" ? 2 : 1)} more ${what}`;
    const pickNote = tA.picks + tB.picks > 0
      ? " Picks carry projected WAR from the pick-value bridge but no index points until they convert to a player."
      : "";
    return `${lean(tA.dvi - tB.dvi, "pts", "dynasty index points")}; `
      + `${lean(tA.cvi - tB.cvi, "pts", "win-now index points")}; `
      + `${lean(tA.war - tB.war, "WAR", "projected 3-year WAR")}. `
      + `The two indices answer different questions — a dynasty edge and a win-now edge can point at different sides, and neither converts into a verdict on who wins the trade.`
      + pickNote;
  })();

  if (!proj) return <div className="empty">Loading…</div>;

  const basket = (i: 0 | 1) => {
    const t = i ? tB : tA;
    const rows = sides[i];
    return (
      <div className="basket" key={i}>
        <div className="basket-head">
          <span>Side {i ? "B" : "A"} sends</span>
          <span className="n">{rows.length ? `${rows.length} asset${rows.length === 1 ? "" : "s"}` : "empty"}</span>
        </div>
        {rows.length > 0 && mobile && (
          <div className="records flat">
            {rows.map((a, k) => (
              <div key={a.key} className={`rec${k % 2 ? " zebra" : ""}`}>
                <div className="rec-l1">
                  <span className="spine" style={{
                    background: a.kind === "player" ? POS_COLOR[a.pos!] ?? "var(--rule-2)" : "var(--rule-2)",
                  }} />
                  <span className="rec-id">
                    {a.kind === "player" ? <PlayerLink pid={a.pid!} name={a.label} /> : a.label}
                    <span className="rec-sub">
                      {a.kind === "player"
                        ? <>{a.pos}{a.age != null && <> · age {a.age}</>}</>
                        : "rookie pick · no index until it converts"}
                    </span>
                  </span>
                  <span className="rec-fig">
                    {a.dvi == null ? <span className="quiet">—</span> : fmt(a.dvi, 1)}
                  </span>
                  <span className="rec-key">DVI</span>
                  <button type="button" className="rec-x" title="remove"
                    onClick={() => remove(i, a.key)}>×</button>
                </div>
                <div className="rec-l2">
                  <span className="mic"><span className="mk">CVI</span>
                    <span className="mv">{a.cvi == null ? <span className="quiet">—</span> : fmt(a.cvi, 1)}</span></span>
                  <span className="mic"><span className="mk">Proj WAR</span>
                    <span className="mv">{sgn(a.war, 2)}</span></span>
                </div>
              </div>
            ))}
            {/* the basket's own total band — every figure labelled */}
            <div className="band">
              <span className="band-label">Total</span>
              <span className="band-note">
                DVI {fmt(t.dvi, 1)} · CVI {fmt(t.cvi, 1)} · WAR {sgn(t.war, 2)}
              </span>
            </div>
          </div>
        )}
        {rows.length > 0 && !mobile && (
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="c" style={{ width: "12%" }}>Pos</th>
                <th className="t" style={{ width: "37%" }}>Asset</th>
                <th className="n" style={{ width: "9%" }}>Age</th>
                <th className="n edge" style={{ width: "12%" }}>DVI</th>
                <th className="n" style={{ width: "12%" }}>CVI</th>
                <th className="n edge" style={{ width: "13%" }}>Proj WAR</th>
                <th className="c" style={{ width: "5%" }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, k) => (
                <tr key={a.key} className={k % 2 ? "zebra" : ""}>
                  <td className="c">{a.kind === "player"
                    ? <PosBadge pos={a.pos!} />
                    : <span className="pos PICK">PICK</span>}</td>
                  <td className="t name" style={{ whiteSpace: "normal" }}>
                    {a.kind === "player" ? <PlayerLink pid={a.pid!} name={a.label} /> : a.label}
                  </td>
                  <td className="n fig quiet">{a.age ?? "—"}</td>
                  <td className="n fig edge">{a.dvi == null ? "—" : fmt(a.dvi, 1)}</td>
                  <td className="n fig">{a.cvi == null ? "—" : fmt(a.cvi, 1)}</td>
                  <td className="n fig strong edge">{sgn(a.war, 2)}</td>
                  <td className="c">
                    <span style={{ color: "var(--dim)", cursor: "pointer" }} title="remove"
                      onClick={() => remove(i, a.key)}>×</span>
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: "1px solid var(--rule)" }}>
                <td className="c"></td>
                <td className="t name">Total</td>
                <td className="n"></td>
                <td className="n edge"><span className="head-fig sm">{fmt(t.dvi, 1)}</span></td>
                <td className="n"><span className="head-fig sm">{fmt(t.cvi, 1)}</span></td>
                <td className="n edge"><span className="head-fig sm">{sgn(t.war, 2)}</span></td>
                <td className="c"></td>
              </tr>
            </tbody>
          </table>
        )}
        <div style={{ padding: "10px 14px 14px" }}>
          <AssetSearch options={options}
            taken={new Set([...sides[0], ...sides[1]].map(a => a.key))}
            onPick={a => add(i, a)}
            placeholder="+ Add player or pick (e.g. 2027 Early 1st)…" />
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="band">
        <span className="band-label">Build the two sides</span>
        <span className="band-note">
          Each column lists what that team sends away · both sides in the same neutral ink,
          and index deltas are index points, not value
        </span>
      </div>
      <div className="baskets" style={{ marginTop: 14 }}>
        {basket(0)}
        {basket(1)}
      </div>

      <div className="verdict-band">
        <div className="figs">
          <div>
            <div className="figkey">Dynasty Δ · A − B</div>
            <div className="figval">{any ? sgn(tA.dvi - tB.dvi, 1) : "—"}</div>
            <div className="figsub">index points, not value</div>
          </div>
          <div>
            <div className="figkey">Win-now Δ · A − B</div>
            <div className="figval">{any ? sgn(tA.cvi - tB.cvi, 1) : "—"}</div>
            <div className="figsub">index points, not value</div>
          </div>
          <div>
            <div className="figkey">Proj WAR Δ · A − B</div>
            <div className="figval">{any ? sgn(tA.war - tB.war, 2) : "—"}</div>
            <div className="figsub">3-year composite WAR</div>
          </div>
        </div>
        <div className="prose">{prose}</div>
      </div>

      <div className="tnote" style={{ padding: "10px var(--pad) 0" }}>
        Players are priced by DVI (dynasty), CVI (win now) and their 3-year composite WAR
        projection. Picks are priced by Bridge A's empirical slot and tier WAR; a pick has
        no index until it converts to a player.
      </div>
    </>
  );
}

/** typeahead over players + picks — the basket's add control */
function AssetSearch({ options, taken, onPick, placeholder }: {
  options: Asset[]; taken: Set<string>; onPick: (a: Asset) => void; placeholder: string;
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
      .filter(([sc, o]) => sc >= 0 && !taken.has(o.key))
      .sort((a, b) => a[0] - b[0])
      .slice(0, 8).map(([, o]) => o);
  }, [q, options, taken]);
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
          background: "var(--band)", border: "1px solid var(--rule)",
          overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,.35)",
        }}>
          {hits.map((o, i) => (
            <div key={o.key} onMouseDown={e => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setSel(i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
                background: i === sel ? "var(--rule)" : "transparent",
              }}>
              <span style={{ color: "var(--dim)", fontSize: 10.5, letterSpacing: .5, width: 30, flexShrink: 0 }}>
                {o.kind === "player" ? o.pos : "PICK"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
              <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 12 }}>{sgn(o.war, 2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
