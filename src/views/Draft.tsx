import { useEffect, useMemo, useState } from "react";
import type { Drafts, Franchises, PickValues } from "../lib/types";
import { j, jDaily } from "../lib/data";
import { fmt } from "../lib/stats";
import { boxStats } from "../components/BoxMarks";

const POS: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };
const sgn2 = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), 2);
const sgn1 = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);

/** linear hex blend, matching the prototype's mix(a, b, t). */
function mix(a: string, b: string, t: number): string {
  t = Math.max(0, Math.min(1, t));
  const p = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const h = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + h(r1 + (r2 - r1) * t) + h(g1 + (g2 - g1) * t) + h(b1 + (b2 - b1) * t);
}

interface Pick { slot: string; season: string; name: string; pos: string; drafter: string; expected: number | null; war: number }

export default function Draft() {
  const [pv, setPv] = useState<PickValues | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    jDaily<PickValues>("data/pick_values.json").then(setPv).catch(() => setErr(true));
    j<Drafts>("data/drafts.json").then(setDrafts).catch(() => setDrafts({}));
    j<Franchises>("data/franchises.json").then(setFr).catch(() => setFr({}));
  }, []);

  const model = useMemo(() => {
    if (!pv?.bands || !pv.picks) return null;
    // round distributions from the corpus (E/M/L tiers merged per round)
    const byRound = [1, 2, 3, 4].map(rd => {
      const dist = pv.bands.filter(b => b.bucket[0] === String(rd)).flatMap(b => b.dist3 ?? []);
      return { round: rd, dist, n: dist.length, s: dist.length >= 2 ? boxStats(dist) : null };
    });
    // median career WAR per exact slot
    const slotMed: Record<string, number | null> = {};
    for (const p of pv.picks) {
      const d = p.dist3 ?? [];
      slotMed[p.bucket] = d.length >= 1 ? boxStats(d).md : null;
    }
    return { byRound, slotMed };
  }, [pv]);

  const returns = useMemo(() => {
    if (!drafts) return null;
    const nameOf = (rid: number): string => {
      const f = fr?.[String(rid)];
      return f?.seasons.length ? f.seasons[f.seasons.length - 1].name : `Roster ${rid}`;
    };
    const graded: Pick[] = [];
    for (const [rid, picks] of Object.entries(drafts))
      for (const p of picks) {
        if (p.traded || p.expected == null || p.years <= 0) continue;
        graded.push({
          slot: p.slot, season: p.season, name: p.name, pos: p.pos,
          drafter: nameOf(p.drafted_by ?? +rid), expected: p.expected, war: p.war,
        });
      }
    const byWar = graded.slice().sort((a, b) => b.war - a.war);
    return { n: graded.length, best: byWar.slice(0, 8), worst: byWar.slice(-8).reverse() };
  }, [drafts, fr]);

  if (err) return <div className="empty">No draft data yet — run scripts/pick_value.py.</div>;
  if (!pv || !model) return <div className="empty">Loading draft data…</div>;

  const years = pv.meta.years_published;
  const classes = pv.meta.classes;

  // fixed WAR axis, per the handoff
  const LO = -2.6, HI = 3.8, W = 800;
  const sx = (v: number) => Math.max(0, Math.min(W, ((v - LO) / (HI - LO)) * W));
  const grid = [-2, -1, 0, 1, 2, 3];

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Rookie draft returns</span>
        <span className="screen-note">{returns ? <><b>{returns.n}</b> graded picks · </> : null}{classes} classes</span>
      </div>

      {/* (a) career WAR by round */}
      <div className="panel">
        <div className="chart-label">Career WAR by round — box is the middle 50%, line is the median</div>
        <div className="box-rows">
          {model.byRound.map((b, i) => (
            <div key={b.round} className="box-row">
              <div className="lbl">RD {b.round}</div>
              <svg width={W} height={30} viewBox={`0 0 ${W} 30`}>
                {grid.map(t => (
                  <line key={t} x1={sx(t)} y1={0} x2={sx(t)} y2={30}
                    stroke={t === 0 ? "#4e5d6c" : "var(--rule)"} strokeWidth={1} />
                ))}
                {b.s && <>
                  <line x1={sx(b.s.mn)} y1={15} x2={sx(b.s.mx)} y2={15} stroke="#4e5d6c" strokeWidth={1.5} />
                  <rect x={sx(b.s.q1)} y={3} width={Math.max(1, sx(b.s.q3) - sx(b.s.q1))} height={24}
                    fill={mix("#0c0f13", accent(), 0.16 * (4 - i))} stroke={mix("#4e5d6c", accent(), 0.3 * (4 - i) / 4)} strokeWidth={1.5} />
                  <line x1={sx(b.s.md)} y1={3} x2={sx(b.s.md)} y2={27} stroke="var(--txt)" strokeWidth={2.5} />
                </>}
              </svg>
              <div className="meta">{b.s ? `n=${b.n}  ·  median ${fmt(b.s.md, 2)}  ·  best ${fmt(b.s.mx, 2)}` : "not enough matured picks"}</div>
            </div>
          ))}
        </div>
        <div className="axis">
          <div className="pad" />
          <div className="scale">
            {grid.map(t => (
              <span key={t} style={{ left: sx(t) + "px" }}>{sgn1(t)}</span>
            ))}
          </div>
        </div>
      </div>

      {/* (b) median career WAR by exact slot */}
      <div style={{ padding: "0 var(--pad)" }}>
        <div className="chart-label">Median career WAR by exact slot</div>
      </div>
      <div className="heat">
        {[1, 2, 3, 4].map(rd => (
          <div key={rd} className="heat-row">
            <div className="lbl">RD {rd}</div>
            {Array.from({ length: 12 }, (_, j) => {
              const slot = rd + "." + String(j + 1).padStart(2, "0");
              const m = model.slotMed[slot] ?? null;
              const t = m == null ? 0 : Math.max(0, Math.min(1, (m + 1.6) / 3.4));
              const light = t > 0.55;
              return (
                <div key={slot} className="heat-cell"
                  style={{ background: m == null ? "var(--zebra)" : mix("#141a21", accent(), t * t) }}>
                  <div className="slot" style={{ color: light ? "rgba(5,7,10,.65)" : "var(--dim2)" }}>{slot}</div>
                  <div className="val" style={{ color: light ? "var(--acc-ink)" : "var(--txt)" }}>{m == null ? "—" : fmt(m, 2)}</div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* (c) best / worst returns */}
      {returns && (
        <div className="pick-tables">
          {([["Best returns", "best", returns.best], ["Worst returns", "worst", returns.worst]] as const).map(([title, cls, rows]) => (
            <div key={cls}>
              <div className={`pick-title ${cls}`}>{title}</div>
              <table>
                <thead><tr>
                  <th className="t" style={{ width: 60 }}>Slot</th>
                  <th className="t" style={{ width: 56 }}>Yr</th>
                  <th className="t">Player</th>
                  <th className="t">Drafted by</th>
                  <th className="n" style={{ width: 70 }}>Exp</th>
                  <th className="n key" style={{ width: 74 }}>WAR</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, k) => (
                    <tr key={k}>
                      <td className="t" style={{ font: "600 15px/1 var(--cond)", color: "var(--txt2)" }}>{r.slot}</td>
                      <td className="t sub">{r.season}</td>
                      <td className="t" style={{ font: "600 13.5px/1 var(--sans)", whiteSpace: "nowrap" }}>
                        <span className="pos" style={{ width: "auto", minWidth: 26, padding: "1px 4px", fontSize: 11, marginRight: 7, background: POS[r.pos] || "var(--rule)" }}>{r.pos}</span>{r.name}
                      </td>
                      <td className="t sub" style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>{r.drafter}</td>
                      <td className="n sub">{r.expected == null ? "—" : sgn2(r.expected)}</td>
                      <td className="n" style={{ font: "700 20px/1 var(--cond)", color: r.war > 0 ? "var(--acc)" : "var(--bad)" }}>{fmt(r.war, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      <div className="footnote">
        Exp = the slot's empirically expected WAR (Bridge A) · distributions pool matured rookie picks from five
        12-team superflex leagues ({classes}); real Big Dog WAR where we have it, calibrated history otherwise
        {years.length ? ` · ${years.length}-year window` : ""}
      </div>
    </>
  );
}

/** read the themed accent as a hex string for canvas-style colour mixing */
function accent(): string {
  if (typeof window === "undefined") return "#f5c518";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--acc").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#f5c518";
}
