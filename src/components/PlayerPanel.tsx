import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Absences, PlayersMin, Team, Weekly, WeeklyRow } from "../lib/types";
import { jl } from "../lib/data";
import { fmt, sgn, sd, mean, quart } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import { useLeaguePath } from "../lib/context";
import PosBadge from "./PosBadge";
import WeekGrid from "./WeekGrid";

interface Props { pid: string; season: string; teams: Team[]; players: PlayersMin }

/**
 * Row drawer (1E): one season at a glance. Six figures and a link to the full
 * player page on the left, the fixed 14-cell week strip on the right.
 *
 * The drawer answers "was this season good, and when". The signed reference
 * columns (vs avg / vs replacement) and ownership history deliberately live on
 * the player page, not here — six signed columns is a reference table, and
 * ownership is a career fact, not a season one.
 */
export default function PlayerPanel({ pid, season, teams, players }: Props) {
  const [wks, setWks] = useState<WeeklyRow[] | null>(null);
  const [abs, setAbs] = useState<Record<string, string>>({});
  const [err, setErr] = useState(false);
  const nav = useNavigate();
  const lp = useLeaguePath();

  useEffect(() => {
    let live = true;
    setErr(false);
    (async () => {
      try {
        const [weekly, absences] = await Promise.all([
          jl<Weekly>(`${season}/weekly.json`),
          jl<Absences>(`${season}/absence.json`).catch(() => ({} as Absences)),
        ]);
        if (!live) return;
        setWks((weekly[pid] || []).slice().sort((a, b) => a[0] - b[0]));
        setAbs(absences[pid] || {});
      } catch {
        // a transient weekly.json failure otherwise hangs on "loading…" forever
        if (live) setErr(true);
      }
    })();
    return () => { live = false; };
  }, [pid, season]);

  if (err) return <div className="empty">couldn't load — reopen to retry</div>;
  if (!wks) return <div className="empty">loading…</div>;

  const [nm, pos, nfl] = pInfo(players, pid);
  const owner = ownerOf(teams)[pid];
  // the strip is the 14 regular-season cells; playoff rows never enter it
  const reg = wks.filter(w => w[0] <= 14);
  const pts = reg.map(w => w[1]);
  const med = pts.length ? quart(pts.slice().sort((a, b) => a - b), 0.5) : 0;
  const waa = reg.reduce((s, w) => s + w[4], 0);
  const war = reg.reduce((s, w) => s + w[5], 0);

  const figs: [string, string, boolean][] = [
    ["Games", String(pts.length), false],
    ["PPG", fmt(mean(pts), 1), false],
    ["Volatility", fmt(sd(pts), 1), false],
    ["Median", fmt(med, 1), false],
    ["WAA", sgn(waa), false],
    ["WAR", sgn(war), true],
  ];

  return (
    <div className="drawer">
      <div className="drawer-body">
        <div style={{ flex: "0 0 auto", minWidth: 200 }}>
          <div className="drawer-title">{nm}</div>
          <div className="drawer-sub" style={{ marginTop: 4 }}>
            <PosBadge pos={pos} />{" "}
            {nfl && <>{nfl} · </>}{season} · {owner ?? "free agent"}
          </div>
          <div className="drawer-figs">
            {figs.map(([k, v, acc]) => (
              <div key={k}>
                <div className="k">{k}</div>
                <div className={acc ? "v acc" : "v"}>{v}</div>
              </div>
            ))}
          </div>
          <button type="button" className="dlink" style={{ marginLeft: 0 }}
            onClick={() => nav(lp(`/player/${pid}`))}>
            Full player page
          </button>
        </div>
        <div style={{ flex: "1 1 440px", minWidth: 320 }}>
          <div className="chart-label">{season} week by week · regular season</div>
          <WeekGrid weeks={reg} absent={abs} />
        </div>
      </div>
    </div>
  );
}
