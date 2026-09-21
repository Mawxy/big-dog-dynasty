import { useEffect, useRef, useState } from "react";

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
 * THE POLLER (2026-09-21). One implementation drives both feeds, and it has
 * five properties the two hand-rolled copies did not:
 *
 *  - **A STOP CONDITION.** The old chain polled two public APIs every sixty
 *    seconds for the whole week — Tuesday, Wednesday, Thursday morning, and
 *    every hour after the Monday night final — because nothing ever told it
 *    the week was over or had not started. The NFL scoreboard knows both: see
 *    `pollDelay`.
 *  - **BACKOFF.** A failure retried at the same cadence forever. Sleeper and
 *    ESPN both rate-limit, and hammering a 429 once a minute is how a reader
 *    stays rate-limited. Consecutive failures double the wait to a cap.
 *  - **A TIMEOUT, AND AN ABORT ON CLEANUP.** `fetch` has no default timeout,
 *    so a hung connection held the chain open indefinitely and a navigation
 *    left the request running.
 *  - **ONE CHAIN.** `onVisible` cleared `timer` and started a new tick. If a
 *    fetch was already in flight the timer was already spent, the clear was a
 *    no-op, and the second chain ran forever alongside the first — one more
 *    per tab switch, all of them polling.
 *  - **NO STALE FRAME.** `live` and `board` survived a league or week change,
 *    so for one render the previous week's scores sat under the new week's
 *    heading. State resets in render, the way `useJson` does it, and the feed
 *    says which week its data belongs to.
 *
 * Polled only while the tab is visible, refetched when it comes back into
 * view. A failed fetch keeps the last good read rather than blanking the
 * cards; before the first success the hook is null and the screen shows the
 * pregame card it always did.
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

/* ---- cadence -------------------------------------------------------------
   Four numbers, and each one is a claim about what is happening. */

/** games are on, or nothing says otherwise */
export const POLL_MS = 60_000;
/** the week is scheduled and nothing has kicked off — check back at kickoff,
 *  and no less often than this while waiting */
export const IDLE_MS = 15 * 60_000;
/** every game is final: one last read for the late stat corrections, then the
 *  chain stops for good */
export const POST_GRACE_MS = 5 * 60_000;
/** the ceiling on the backoff after consecutive failures */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** a single request's budget before it is aborted */
export const FETCH_TIMEOUT_MS = 12_000;
/** past this with no good read, a consumer should say so rather than keep
 *  showing a running total as though it were current */
export const STALE_MS = 5 * 60_000;

export async function fetchLiveWeek(
  leagueId: string, week: number, signal?: AbortSignal,
): Promise<LiveWeek> {
  const res = await fetch(
    `https://api.sleeper.app/v1/league/${leagueId}/matchups/${week}`, { signal });
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

/* ========================================================================
   THE FEED
   ======================================================================== */

/**
 * One polled feed, with everything a screen needs to caption it.
 *
 * ADDITIVE. `useLiveScores` and `useNflScoreboard` still return exactly what
 * they returned before; this is what the `…Feed` forms hand back for a caller
 * that wants to show a staleness line or hide a "live" dot on a dead poll.
 */
export interface LiveFeed<T> {
  /** the last GOOD read, or null before the first one */
  data: T | null;
  /** the week `data` belongs to — null before the first read. A screen that
   *  renders a week heading should check this rather than assume. */
  week: number | null;
  /** ms epoch of that read; 0 when there has never been one */
  fetched: number;
  /** consecutive failures since the last good read; 0 while healthy */
  failures: number;
  /** the chain has stopped because there is nothing left to read — every game
   *  is final. A feed switched off by `on` is simply idle, not done. */
  done: boolean;
}

const IDLE_FEED: LiveFeed<never> = {
  data: null, week: null, fetched: 0, failures: 0, done: false,
};

/** has the last good read aged out? `now` is a parameter so this is pure and
 *  a caller can drive it off its own ticker. */
export const isStale = (f: LiveFeed<unknown>, now = Date.now()): boolean =>
  f.data == null || now - f.fetched > STALE_MS;

/**
 * THE POLL CADENCE, off the NFL scoreboard.
 *
 * Returns the milliseconds until the next read, or null for "stop — nothing
 * more is going to happen". The board is the only thing on the site that
 * knows whether a game is on, so it answers for both feeds.
 *
 *  - no board, or a week ESPN has no games for → the old flat cadence; an
 *    unknown state is not a licence to stop.
 *  - any game under way → every minute.
 *  - every game final → stop.
 *  - otherwise the week is ahead of us: wait until the earliest kickoff,
 *    checking in no less often than IDLE_MS in case the schedule moves.
 */
export function pollDelay(
  board: Scoreboard | null | undefined, now = Date.now(),
): number | null {
  const games = Object.values(board ?? {});
  if (!games.length) return POLL_MS;
  if (games.some(g => g.state === "in")) return POLL_MS;
  if (games.every(g => g.state === "post")) return null;
  let soonest = Infinity;
  for (const g of games) {
    if (g.state !== "pre") continue;
    const t = Date.parse(g.date);
    if (Number.isFinite(t) && t < soonest) soonest = t;
  }
  // kickoff has passed but ESPN has not flipped the state yet
  if (!Number.isFinite(soonest) || soonest <= now) return POLL_MS;
  return Math.min(IDLE_MS, Math.max(POLL_MS, soonest - now));
}

/** a coarse label for the week, and the token the live feed restarts its
 *  chain on — a transition is exactly when an armed long wait is wrong */
export type BoardPhase = "pre" | "live" | "post" | "unknown";
export function boardPhase(board: Scoreboard | null | undefined): BoardPhase {
  const games = Object.values(board ?? {});
  if (!games.length) return "unknown";
  if (games.some(g => g.state === "in")) return "live";
  if (games.every(g => g.state === "post")) return "post";
  return "pre";
}

/**
 * The shared chain. `key` identifies the resource (league id or season) and
 * null switches the feed off; `delayOf` is consulted after every successful
 * read and may stop the chain by returning null.
 *
 * `fetcher` and `delayOf` are read through refs rather than depended on, so a
 * caller may define them inline. `bump` is the one thing that legitimately
 * restarts the chain without resetting its data.
 */
function usePoll<T>(
  on: boolean, key: string | null, week: number | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  delayOf: (data: T | null) => number | null,
  bump = "",
): LiveFeed<T> {
  const [st, setSt] = useState<LiveFeed<T>>(IDLE_FEED);
  const fetchRef = useRef(fetcher);
  const delayRef = useRef(delayOf);
  fetchRef.current = fetcher;
  delayRef.current = delayOf;

  /* Reset in RENDER, not from the effect — the same reason `useJson` does it
     there. Cleared from the effect, one committed frame pairs the previous
     league's scores with the new league's heading. */
  const id = `${key ?? ""}|${week ?? ""}|${on ? 1 : 0}`;
  const [cur, setCur] = useState(id);
  if (cur !== id) { setCur(id); setSt(IDLE_FEED); }

  useEffect(() => {
    if (!on || key == null || week == null) return;

    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** the in-flight guard. Without it `onVisible` forked a second chain. */
    let inFlight = false;
    let failures = 0;
    let last: T | null = null;

    const arm = (ms: number) => {
      if (dead) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void tick(); }, ms);
    };

    const tick = async () => {
      // clear BEFORE nulling: a tick called straight from `onVisible` leaves
      // the armed timeout pending otherwise, and that is the duplicate chain
      if (timer) { clearTimeout(timer); timer = null; }
      if (dead || inFlight) return;
      // never fetch while hidden; `onVisible` brings the chain back at once
      if (document.visibilityState !== "visible") { arm(IDLE_MS); return; }

      inFlight = true;
      const ctl = new AbortController();
      const bail = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      try {
        const d = await fetchRef.current(ctl.signal);
        if (dead) return;
        last = d;
        failures = 0;
        setSt({ data: d, week, fetched: Date.now(), failures: 0, done: false });
      } catch {
        if (dead) return;
        failures++;
        setSt(p => ({ ...p, failures }));
      } finally {
        clearTimeout(bail);
        inFlight = false;
      }
      if (dead) return;

      // a failing endpoint gets exponentially more room, to a cap; a healthy
      // one gets whatever the caller's cadence says
      const next = failures
        ? Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS)
        : delayRef.current(last);
      if (next == null) { setSt(p => ({ ...p, done: true })); return; }
      arm(next);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // a fetch in flight already owns the chain, and a chain that has
      // stopped (no timer, nothing in flight) stopped on purpose
      if (inFlight || !timer) return;
      void tick();
    };

    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [on, key, week, bump]);

  return st;
}

/* ========================================================================
   THE TWO FEEDS
   ======================================================================== */

/**
 * The live read for one week, with its metadata. `on` gates the whole thing:
 * pass false once the pipeline has scored the week (its file is the record
 * then) and nothing is fetched.
 *
 * `board` is `useNflScoreboard`'s answer for the same week, and it is what
 * lets this stop: without it the feed has no way to know the week is over and
 * falls back to the flat one-minute cadence it always had.
 */
export function useLiveWeekFeed(
  leagueId: string | null, week: number | null, on: boolean,
  board?: Scoreboard | null,
): LiveFeed<LiveWeek> {
  /** how many post-final reads have been taken; see the delay below */
  const grace = useRef(0);
  return usePoll<LiveWeek>(
    on, leagueId, week,
    signal => fetchLiveWeek(leagueId as string, week as number, signal),
    () => {
      const d = pollDelay(board);
      if (d != null) { grace.current = 0; return d; }
      /* Every game is final. Sleeper settles a few minutes behind ESPN and
         stat corrections land later still, so take exactly one more read and
         then stop — the pipeline owns the week from here. */
      return grace.current++ === 0 ? POST_GRACE_MS : null;
    },
    boardPhase(board),
  );
}

/** the live read for one week, or null — the original shape, unchanged */
export function useLiveScores(
  leagueId: string | null, week: number | null, on: boolean,
  board?: Scoreboard | null,
): LiveWeek | null {
  return useLiveWeekFeed(leagueId, week, on, board).data;
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

export async function fetchScoreboard(
  season: string, week: number, signal?: AbortSignal,
): Promise<Scoreboard> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}&dates=${season}`;
  const res = await fetch(url, { signal });
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

/** the week's scoreboard with its metadata; `data` is null until it lands.
 *  The cadence comes from the board's own contents — see `pollDelay`. */
export function useNflBoardFeed(
  season: string | null, week: number | null, on: boolean,
): LiveFeed<Scoreboard> {
  return usePoll<Scoreboard>(
    on, season, week,
    signal => fetchScoreboard(season as string, week as number, signal),
    board => pollDelay(board),
  );
}

/** the week's scoreboard, or null — the original shape, unchanged */
export function useNflScoreboard(
  season: string | null, week: number | null, on: boolean,
): Scoreboard | null {
  return useNflBoardFeed(season, week, on).data;
}
