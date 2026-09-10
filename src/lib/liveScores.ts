import { useEffect, useState } from "react";

/**
 * LIVE SCORING (Max, 2026-09-10) — the week in progress, straight from
 * Sleeper, so the League page keeps count while games are on.
 *
 * Everything else on the board is a static file the pipeline wrote; the
 * pipeline scores a week once, after it is over. Points accrue Thursday
 * night through Monday, and a card that says "Pregame line" all weekend is
 * lying by omission. So, for the one week that is in progress, the browser
 * asks Sleeper's public API directly: `/v1/league/<id>/matchups/<week>`
 * carries each roster's running total, its starters as set, and every
 * rostered player's points so far. Sleeper serves it with open CORS.
 *
 * Polled once a minute while the tab is visible, refetched when it comes
 * back into view, and never while it is hidden. A failed fetch keeps the
 * last good read rather than blanking the cards; before the first success
 * the hook is null and the screen shows the pregame card it always did.
 */
export interface LiveSide {
  rid: number;
  /** the roster's points so far this week */
  pts: number;
  /** the lineup as the manager has it set, in slot order ("0" = empty) */
  starters: string[];
  /** every rostered player's points so far */
  ppts: Record<string, number>;
}
export interface LiveWeek {
  week: number;
  /** when this read landed (ms) */
  fetched: number;
  sides: Record<string, LiveSide>;
  /** anybody has scored — the week is under way, not merely scheduled */
  started: boolean;
}

interface SleeperMatchup {
  roster_id: number; matchup_id: number | null;
  points: number | null;
  /** a commissioner's override, when there is one */
  custom_points?: number | null;
  starters: string[] | null;
  starters_points?: (number | null)[] | null;
  players_points?: Record<string, number> | null;
}

const POLL_MS = 60_000;

export async function fetchLiveWeek(leagueId: string, week: number): Promise<LiveWeek> {
  const res = await fetch(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`);
  if (!res.ok) throw new Error(`sleeper ${res.status}`);
  // an unknown id comes back as null with a 200 — an empty week, not a crash
  const rows = ((await res.json()) ?? []) as SleeperMatchup[];
  const sides: Record<string, LiveSide> = {};
  let started = false;
  for (const r of rows) {
    const pts = r.custom_points ?? r.points ?? 0;
    if (pts > 0) started = true;
    sides[String(r.roster_id)] = {
      rid: r.roster_id, pts,
      starters: r.starters ?? [],
      ppts: r.players_points ?? {},
    };
  }
  return { week, fetched: Date.now(), sides, started };
}

/**
 * The live read for one week, or null. `on` gates the whole thing: pass
 * false once the pipeline has scored the week (its file is the record then)
 * and nothing is fetched.
 */
export function useLiveScores(leagueId: string | null, week: number | null, on: boolean): LiveWeek | null {
  const [live, setLive] = useState<LiveWeek | null>(null);
  useEffect(() => {
    if (!on || !leagueId || week == null) { setLive(null); return; }
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (dead) return;
      if (document.visibilityState === "visible") {
        try {
          const lw = await fetchLiveWeek(leagueId, week);
          if (!dead) setLive(lw);
        } catch { /* keep the last read */ }
      }
      if (!dead) timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [leagueId, week, on]);
  return live;
}

/* ---- the NFL scoreboard ---------------------------------------------------
   To re-project a side mid-week the board has to know, per player, whether
   his game is still to come, under way (and how far along), or over. Sleeper
   does not say; ESPN's public scoreboard does, with the clock, and serves it
   with open CORS. Keyed by Sleeper's team code so a player's `team` in
   players_min looks straight up. */

export interface GameClock {
  state: "pre" | "in" | "post";
  /** the share of regulation still to play: 1 before kickoff, 0 at the final */
  remaining: number;
  /** the other side, Sleeper's code, and whether this team is at home */
  opp: string;
  home: boolean;
  /** kickoff, ISO */
  date: string;
  /** ESPN's short status — "Final", "Q3 4:12", "Halftime" — for a game
   *  under way or over; the kickoff is formatted from `date` before */
  detail: string;
}
export type Scoreboard = Record<string, GameClock>;

/** ESPN's code where it differs from Sleeper's */
const ESPN_TO_SLEEPER: Record<string, string> = { WSH: "WAS" };

interface EspnScoreboard {
  events?: {
    date?: string;
    competitions?: {
      date?: string;
      status?: { period?: number; clock?: number; type?: { state?: string; shortDetail?: string } };
      competitors?: { homeAway?: string; team?: { abbreviation?: string } }[];
    }[];
  }[];
}

export async function fetchScoreboard(season: string, week: number): Promise<Scoreboard> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`espn ${res.status}`);
  const data = (await res.json()) as EspnScoreboard;
  const out: Scoreboard = {};
  for (const ev of data.events ?? []) {
    const c = ev.competitions?.[0];
    if (!c) continue;
    const st = c.status?.type?.state;
    const state: GameClock["state"] = st === "post" ? "post" : st === "in" ? "in" : "pre";
    let remaining = state === "pre" ? 1 : 0;
    if (state === "in") {
      const p = c.status?.period ?? 1;
      const clock = c.status?.clock ?? 900;   // seconds left in the period
      // overtime is nearly over whatever the clock says
      remaining = p > 4 ? 0.02 : Math.max(0, 1 - ((p - 1) * 900 + (900 - clock)) / 3600);
    }
    const codes = (c.competitors ?? []).map(t => ({
      code: t.team?.abbreviation ? (ESPN_TO_SLEEPER[t.team.abbreviation] ?? t.team.abbreviation) : null,
      home: t.homeAway === "home",
    }));
    const date = c.date ?? ev.date ?? "";
    const detail = c.status?.type?.shortDetail ?? "";
    for (const t of codes) {
      if (!t.code) continue;
      const other = codes.find(o => o !== t)?.code ?? "";
      out[t.code] = { state, remaining, opp: other, home: t.home, date, detail };
    }
  }
  return out;
}

/** the week's scoreboard, polled on the live cadence; null until it lands */
export function useNflScoreboard(season: string | null, week: number | null, on: boolean): Scoreboard | null {
  const [board, setBoard] = useState<Scoreboard | null>(null);
  useEffect(() => {
    if (!on || !season || week == null) { setBoard(null); return; }
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (dead) return;
      if (document.visibilityState === "visible") {
        try {
          const b = await fetchScoreboard(season, week);
          if (!dead) setBoard(b);
        } catch { /* keep the last read */ }
      }
      if (!dead) timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [season, week, on]);
  return board;
}
