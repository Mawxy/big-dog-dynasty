import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { Absences, PlayersMin, Team, Weekly, WeeklyRow } from "../lib/types";
import { useJson } from "../lib/useJson";
import { fmt, sgnWar, sd, mean, quart } from "../lib/stats";
import { pInfo, ownerOf, REG_WEEKS } from "../lib/league";
import { useLeaguePath } from "../lib/context";
import PosBadge from "./PosBadge";
import WeekGrid from "./WeekGrid";

interface Props { pid: string; season: string; teams: Team[]; players: PlayersMin }

const NO_ABSENCES: Record<string, string> = {};

/**
 * Row drawer (1E): one season at a glance. Six figures and a link to the full
 * player page on the left, the fixed regular-season week strip on the right.
 *
 * The drawer answers "was this season good, and when". The signed reference
 * columns (vs avg / vs replacement) and ownership history deliberately live on
 * the player page, not here — six signed columns is a reference table, and
 * ownership is a career fact, not a season one.
 */
export default function PlayerPanel({ pid, season, teams, players }: Props) {
  const nav = useNavigate();
  const lp = useLeaguePath();

  const weekly = useJson<Weekly>(`${season}/weekly.json`);
  // a season with no absence file is a legal shape — the strip just carries no
  // BYE/DNP flags, which is not the same as a failure to load the week scores
  const absences = useJson<Absences>(`${season}/absence.json`).data;
  const wks = useMemo<WeeklyRow[] | null>(
    () => (weekly.data ? (weekly.data[pid] || []).slice().sort((a, b) => a[0] - b[0]) : null),
    [weekly.data, pid]);
  const abs = absences?.[pid] ?? NO_ABSENCES;

  // a transient weekly.json failure otherwise hangs on "loading…" forever
  if (weekly.error) return <div className="empty">couldn't load — reopen to retry</div>;
  if (!wks) return <div className="empty">loading…</div>;

  const [nm, pos, nfl] = pInfo(players, pid);
  const owner = ownerOf(teams)[pid];
  // the strip is the regular season only; playoff rows never enter it
  const reg = wks.filter(w => w[0] <= REG_WEEKS);
  const pts = reg.map(w => w[1]);
  const med = pts.length ? quart(pts.slice().sort((a, b) => a - b), 0.5) : 0;
  const waa = reg.reduce((s, w) => s + w[4], 0);
  const war = reg.reduce((s, w) => s + w[5], 0);

  const figs: [string, string, boolean][] = [
    ["Games", String(pts.length), false],
    ["PPG", fmt(mean(pts), 1), false],
    ["Volatility", fmt(sd(pts), 1), false],
    ["Median", fmt(med, 1), false],
    ["WAA", sgnWar(waa), false],
    ["WAR", sgnWar(war), true],
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
