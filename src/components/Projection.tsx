import {
  CartesianGrid, Legend, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { Projection as Proj, SleeperProj } from "../lib/types";
import { fmt } from "../lib/stats";

const GOLD = "#f0a01e";     // natural (if-healthy) + actual
const GREEN = "#3fb26f";    // blended (composite)
const BLUE = "#5b8fd6";     // smoothed (injury-adjusted)

/** Career WAR flowing into the 3-year projection, three scenario lines:
 *  Natural (if-healthy), Blended (half math / half Sleeper), Smoothed
 *  (injury-adjusted). Solid past, dashed forward, bridged at the last season. */
export default function Projection({ p, trend, sleeper, years }: {
  p: Proj;
  trend: { season: string; WAR: number }[];
  sleeper?: SleeperProj | null;
  years: number[];
}) {
  const lastActual = trend.length ? trend[trend.length - 1].WAR : p.war25;
  const data: Record<string, unknown>[] = [
    ...trend.map(t => ({ season: t.season, actual: t.WAR })),
    ...years.map((y, i) => ({
      season: String(y),
      natural: p.proj[i], blended: p.composite[i], smoothed: p.expected[i],
    })),
  ];
  if (trend.length) {   // bridge every forward line to the last real season
    Object.assign(data[trend.length - 1],
      { natural: lastActual, blended: lastActual, smoothed: lastActual });
  }
  const draft = p.pick < 999 ? `R${Math.ceil(p.pick / 32)} #${p.pick}` : "UDFA";

  return (
    <div>
      <div style={{ color: "var(--txt)", fontSize: 13, marginBottom: 4 }}>
        <b>3-year WAR projection</b>
        <span style={{ color: "var(--dim)", fontWeight: 400 }}> — solid = actual, dashed = projected</span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -14 }}>
          <CartesianGrid stroke="#242c38" strokeDasharray="3 3" />
          <XAxis dataKey="season" stroke="#8b96a5" fontSize={12} tickLine={false} />
          <YAxis stroke="#8b96a5" fontSize={12} tickLine={false} width={54} />
          <Tooltip
            contentStyle={{ background: "#161b23", border: "1px solid #242c38", borderRadius: 8, fontSize: 12.5 }}
            labelStyle={{ color: "#e6ebf2" }} itemStyle={{ padding: 0 }}
            formatter={(v: number) => v.toFixed(2)} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
          <ReferenceLine y={0} stroke="#8b96a5" />
          <Line dataKey="actual" name="Actual" legendType="none" stroke={GOLD} strokeWidth={2.5}
            connectNulls dot={{ r: 3, fill: GOLD, strokeWidth: 0 }} />
          <Line dataKey="natural" name="Natural" stroke={GOLD} strokeWidth={2} strokeDasharray="5 4"
            connectNulls dot={{ r: 3, fill: GOLD, strokeWidth: 0 }} />
          <Line dataKey="blended" name="Blended" stroke={GREEN} strokeWidth={2} strokeDasharray="5 4"
            connectNulls dot={{ r: 3, fill: GREEN, strokeWidth: 0 }} />
          <Line dataKey="smoothed" name="Adjusted" stroke={BLUE} strokeWidth={2} strokeDasharray="5 4"
            connectNulls dot={{ r: 3, fill: BLUE, strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
        level {fmt(p.level, 2)} · drafted {draft} · age {p.age}
        {sleeper && p.proj_ext != null &&
          <> · Sleeper {years[0]}: {fmt(sleeper.ppg, 1)} ppg → {fmt(p.proj_ext, 2)} WAR</>}
      </div>
    </div>
  );
}
