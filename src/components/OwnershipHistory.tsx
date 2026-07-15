import type { OwnEvent } from "../lib/types";

export default function OwnershipHistory({ events }: { events: OwnEvent[] }) {
  if (!events.length) return null;
  return (
    <div style={{ marginTop: 8, fontSize: 12.5, color: "var(--dim)" }}>
      <b style={{ color: "var(--txt)" }}>Ownership history</b>
      {events.map((h, i) => <Evt key={i} h={h} />)}
    </div>
  );
}

function Evt({ h }: { h: OwnEvent }) {
  const badge = <span className="ownwk">{h[0]}{h[1] ? ` W${h[1]}` : ""}</span>;
  const i = h[2].indexOf(" — ");
  if (i < 0) return <div className="ownevt">{badge}{h[2]}</div>;
  const evt = h[2].slice(0, i);
  const sides = h[2].slice(i + 3).split("; ");
  return (
    <div className="ownevt">
      {badge}{evt}
      <div className="ownsides">
        {sides.map((x, k) => {
          const g = x.indexOf(" get ");
          return g < 0 ? <div key={k}>{x}</div> : (
            <div key={k}><b style={{ color: "var(--txt)" }}>{x.slice(0, g)}</b> received {x.slice(g + 5)}</div>
          );
        })}
      </div>
    </div>
  );
}
