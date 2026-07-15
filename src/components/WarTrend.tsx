import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

export default function WarTrend({ data }: { data: { season: string; WAR: number; WAA: number }[] }) {
  if (data.length < 2) return null;
  return (
    <div style={{ maxWidth: 720, margin: "0 0 26px" }}>
      <div style={{ color: "var(--txt)", fontSize: 13, marginBottom: 4 }}><b>WAR by season</b>
        <span style={{ color: "var(--dim)", fontWeight: 400 }}> — solid WAR · dashed WAA</span></div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -14 }}>
          <CartesianGrid stroke="#242c38" strokeDasharray="3 3" />
          <XAxis dataKey="season" stroke="#8b96a5" fontSize={12} tickLine={false} />
          <YAxis stroke="#8b96a5" fontSize={12} tickLine={false} width={54} />
          <Tooltip
            contentStyle={{ background: "#161b23", border: "1px solid #242c38", borderRadius: 8, fontSize: 12.5 }}
            labelStyle={{ color: "#e6ebf2" }} itemStyle={{ padding: 0 }}
            formatter={(v: number) => v.toFixed(3)} />
          <ReferenceLine y={0} stroke="#8b96a5" />
          <Line type="monotone" dataKey="WAR" stroke="#f0a01e" strokeWidth={2}
            dot={{ r: 3, fill: "#f0a01e", strokeWidth: 0 }} activeDot={{ r: 4 }} />
          <Line type="monotone" dataKey="WAA" stroke="#3fb26f" strokeWidth={1.5} strokeDasharray="4 3"
            dot={{ r: 2, fill: "#3fb26f", strokeWidth: 0 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
