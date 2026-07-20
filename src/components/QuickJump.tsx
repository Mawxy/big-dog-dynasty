import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeague } from "../lib/context";
import { j } from "../lib/data";
import { seasonSeg } from "../lib/league";
import type { Franchises } from "../lib/types";
import PosBadge from "./PosBadge";

interface Opt { key: string; label: string; pos?: string; to: string }

/** Typeahead for jumping straight to another player or team page without
 *  backing out to a leaderboard. Prefix matches rank above substring matches;
 *  teams (12 franchises, latest name) list ahead of players at equal rank. */
export default function QuickJump() {
  const { meta, players } = useLeague();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const [frs, setFrs] = useState<Franchises | null>(null);
  const nav = useNavigate();
  useEffect(() => { j<Franchises>("data/franchises.json").then(setFrs).catch(() => {}); }, []);
  const latest = meta.seasons[meta.seasons.length - 1];

  const opts = useMemo<Opt[]>(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const score = (name: string): number => {
      const n = name.toLowerCase();
      return n.startsWith(s) ? 0
        : n.split(/\s+/).some(w => w.startsWith(s)) ? 1
          : n.includes(s) ? 2 : -1;
    };
    const scored: [number, Opt][] = [];
    for (const [rid, f] of Object.entries(frs ?? {})) {
      const name = f.seasons[f.seasons.length - 1].name.trim();
      const sc = score(name);
      if (sc >= 0) scored.push([sc, {
        key: `t${rid}`, label: name,
        to: `/teams/${seasonSeg(latest)}/${rid}`,
      }]);
    }
    for (const [pid, [name, pos]] of Object.entries(players)) {
      const sc = score(name);
      if (sc >= 0) scored.push([sc, { key: pid, label: name, pos, to: `/player/${pid}` }]);
    }
    return scored.sort((a, b) => a[0] - b[0]).slice(0, 8).map(x => x[1]);
  }, [q, players, frs, latest]);

  const go = (o: Opt) => { setQ(""); setOpen(false); nav(o.to); };

  return (
    <div style={{ position: "relative", marginLeft: "auto" }}>
      <input type="search" placeholder="Jump to player or team…" value={q}
        style={{ minWidth: 170 }}
        onChange={e => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => Math.min(i + 1, opts.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && opts[sel]) go(opts[sel]);
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && opts.length > 0 && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 30,
          background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10,
          minWidth: 235, maxWidth: 320, overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,.35)",
        }}>
          {opts.map((o, i) => (
            // onMouseDown (not click) so it fires before the input's blur closes the list
            <div key={o.key} onMouseDown={e => { e.preventDefault(); go(o); }}
              onMouseEnter={() => setSel(i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
                background: i === sel ? "var(--line)" : "transparent",
              }}>
              {o.pos
                ? <PosBadge pos={o.pos} />
                : <span style={{ color: "var(--dim)", fontSize: 10.5, letterSpacing: .5 }}>TEAM</span>}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
