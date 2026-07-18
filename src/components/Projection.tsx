import { useState } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Projection as Proj, SleeperProj } from "../lib/types";
import { fmt } from "../lib/stats";

const GOLD = "#f0a01e";

const TABS = [
  { label: "Natural", line: "proj", lo: "nat_low", hi: "nat_high",
    color: "#f0a01e", desc: "if healthy — full 13-game season" },
  { label: "Composite", line: "composite", lo: "comp_low", hi: "comp_high",
    color: "#3fb26f", desc: "blended with Sleeper's year-1 projection" },
  { label: "Adjusted", line: "expected", lo: "adj_low", hi: "adj_high",
    color: "#5b8fd6", desc: "× availability — accounts for injury" },
] as const;

/** Career WAR into the 3-year projection. Tabs switch between the three streams;
 *  each shows its line (dashed) with its p20/p80 band shaded. */
export default function Projection({ p, trend, sleeper, years }: {
  p: Proj;
  trend: { season: string; WAR: number }[];
  sleeper?: SleeperProj | null;
  years: number[];
}) {
  const [tab, setTab] = useState(0);
  const t = TABS[tab];
  const line = p[t.line], lo = p[t.lo], hi = p[t.hi];

  const hist = p.career && p.career.length
    ? p.career.map(([s, w]) => ({ season: String(s), WAR: w }))
    : trend;
  const lastActual = hist.length ? hist[hist.length - 1].WAR : 0;
  const data: Record<string, unknown>[] = [
    ...hist.map(h => ({ season: h.season, actual: h.WAR })),
    ...years.map((y, i) => ({ season: String(y), proj: line[i], band: [lo[i], hi[i]] as [number, number] })),
  ];
  if (hist.length) {
    data[hist.length - 1].proj = lastActual;                     // bridge the line
    data[hist.length - 1].band = [lastActual, lastActual];       // fan band out from the anchor
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13, color: "var(--txt)" }}>3-year projection</b>
        <div style={{ display: "flex", gap: 6 }}>
          {TABS.map((tb, i) => (
            <span key={tb.label} className={i === tab ? "chip on" : "chip"}
              style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => setTab(i)}>
              {tb.label}
            </span>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -14 }}>
          <CartesianGrid stroke="#242c38" strokeDasharray="3 3" />
          <XAxis dataKey="season" stroke="#8b96a5" fontSize={12} tickLine={false} />
          <YAxis stroke="#8b96a5" fontSize={12} tickLine={false} width={54} />
          <Tooltip
            contentStyle={{ background: "#161b23", border: "1px solid #242c38", borderRadius: 8, fontSize: 12.5 }}
            labelStyle={{ color: "#e6ebf2" }} itemStyle={{ padding: 0 }}
            formatter={(v: number | number[], name: string) =>
              [Array.isArray(v) ? `${v[0].toFixed(2)} – ${v[1].toFixed(2)}` : (v as number).toFixed(2),
              name === "band" ? "p20–p80" : name === "proj" ? t.label : "actual"]} />
          <ReferenceLine y={0} stroke="#8b96a5" />
          <Area type="monotone" dataKey="band" stroke="none" fill={t.color} fillOpacity={0.13} />
          <Line type="linear" dataKey="actual" stroke={GOLD} strokeWidth={2.5} connectNulls
            dot={{ r: 3, fill: GOLD, strokeWidth: 0 }} />
          <Line type="linear" dataKey="proj" stroke={t.color} strokeWidth={2} strokeDasharray="5 4" connectNulls
            dot={{ r: 3, fill: t.color, strokeWidth: 0 }} />
        </ComposedChart>
      </ResponsiveContainer>
      <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
        <b style={{ color: t.color }}>{t.label}</b> — {t.desc} · level {fmt(p.level, 2)} · age {p.age}
        {sleeper && p.proj_ext != null &&
          <> · Sleeper {years[0]}: {fmt(sleeper.ppg, 1)} ppg → {fmt(p.proj_ext, 2)} WAR</>}
      </div>
    </div>
  );
}
