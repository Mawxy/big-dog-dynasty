#!/usr/bin/env python3
"""
sleeper_crawl.py — snowball-crawl dynasty leagues from seed league(s) to gather
crowd-sourced valuation signals the production model (WAR/VoWP) can't see: how
widely each player is ROSTERED, TAXI-stashed, and where they land in STARTUP and
ROOKIE drafts. Roster/taxi rate and startup ADP price a young dart-throw's
UPSIDE natively — the thing KTC-through-Bridge-B strips back out.

Sleeper has no global league search, so we BFS the user<->league graph:
  seed league -> rosters -> owner user_ids -> each user's other leagues ->
  keep the dynasty ones (settings.type == 2) -> recurse.
Coverage is the connected component of the seeds; dynasty players stack leagues,
so a few active seeds reach thousands. Bounded by --max-leagues.

Output data/league_signals.json:
  { generated, season, leagues_crawled, drafts_seen, users_seen,
    players: { pid: { roster_rate, taxi_rate,
                      startup_adp, startup_n, rookie_adp, rookie_n } } }

Also, in the SAME pass (the graph traversal is the expensive part), a corpus of
real completed trades -> data/trade_corpus.json:
  { generated, season, leagues, trades:
    [ { tid, season, week, sides: [ { roster_id, players:[pid],
        picks:[{season,round,orig}], faab } , ... ] } , ... ] }
This is the revealed-preference market — what bundles actually swap for what —
and it prices dart-throws at their true dynasty value, unlike production WAR.

Usage:
  python scripts/sleeper_crawl.py [SEED_LEAGUE_ID ...]
      [--season 2026] [--max-leagues 3000] [--trade-weeks 18]
      [--out data/league_signals.json] [--trades-out data/trade_corpus.json]
Runs where Sleeper is reachable (local / CI), NOT the sandbox. Heavy: expect
several calls per league (+1 per trade-week); bound with --max-leagues.
"""
import argparse, datetime, json, sys, time, urllib.error, urllib.request
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.sleeper.app/v1"
DELAY = 0.12                 # seconds between calls; keeps under ~1000/min
RETRIES = 3
RATE_LIMIT_TRIES = 10
STARTUP_MIN_ROUNDS = 10      # >= this many rounds = startup (whole-pool) draft
CHECKPOINT_EVERY = 250       # flush outputs every N counted leagues (long-run safety)
# the Big Dog Dynasty chain, 2022-2026 — every season is its own entry point
DEFAULT_SEEDS = ["1312221243742621696", "1180090288907112448",
                 "1048300464669937664", "916360462835634176",
                 "814608002207334400"]


_calls = 0                   # total API calls made, for the heartbeat


def get(path):
    """GET Sleeper JSON (None on 404/null). 429s get their own budget and raise
    on exhaustion rather than silently truncating the crawl."""
    global _calls
    url = path if path.startswith("http") else BASE + path
    attempt = rate_hits = 0
    while True:
        try:
            time.sleep(DELAY)
            _calls += 1
            with urllib.request.urlopen(url, timeout=30) as r:
                body = r.read().decode("utf-8")
            return json.loads(body) if body and body != "null" else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:
                rate_hits += 1
                if rate_hits >= RATE_LIMIT_TRIES:
                    raise RuntimeError(f"rate-limited {rate_hits}x, giving up: {url}")
                time.sleep(30)
                continue
            attempt += 1
            if attempt >= RETRIES:
                raise
            time.sleep(2 ** attempt)
        except (urllib.error.URLError, TimeoutError):
            attempt += 1
            if attempt >= RETRIES:
                raise
            time.sleep(2 ** attempt)


def is_dynasty(league):
    return bool(league) and (league.get("settings") or {}).get("type") == 2


def is_superflex(league):
    rp = league.get("roster_positions") or []
    return "SUPER_FLEX" in rp or rp.count("QB") >= 2


def counts_for_data(league, teams, require_sf):
    """A league only contributes to the aggregates if it matches YOUR format.
    Every dynasty league is still traversed for graph expansion — we just drop
    the data from off-format ones (1QB, non-12-team) as we go."""
    if teams and league.get("total_rosters") != teams:
        return False
    if require_sf and not is_superflex(league):
        return False
    return True


def extract_trade(tx, season):
    """One completed trade -> per-side bundles (players, picks, FAAB). Picks keep
    (season, round, original roster) so a later model can tier them."""
    sides = {}
    def side(rid):
        return sides.setdefault(rid, {"roster_id": rid, "players": [], "picks": [], "faab": 0})
    for pid, rid in (tx.get("adds") or {}).items():
        side(rid)["players"].append(pid)
    for pk in (tx.get("draft_picks") or []):
        side(pk.get("owner_id"))["picks"].append(
            {"season": pk.get("season"), "round": pk.get("round"), "orig": pk.get("roster_id")})
    for wb in (tx.get("waiver_budget") or []):
        side(wb.get("receiver"))["faab"] += wb.get("amount", 0)
    return {"tid": tx.get("transaction_id"), "season": season,
            "week": tx.get("leg"), "sides": list(sides.values())}


def main():
    ap = argparse.ArgumentParser(description="snowball-crawl dynasty leagues for roster/ADP signals")
    ap.add_argument("seeds", nargs="*", help="seed league_id(s) (default: Big Dog Dynasty chain)")
    ap.add_argument("--season", help="season for user-league lookups (default: current)")
    ap.add_argument("--max-leagues", type=int, default=3000,
                    help="stop after visiting N dynasty leagues (matched or not)")
    ap.add_argument("--teams", type=int, default=12,
                    help="only COUNT leagues with this many teams (0 = any)")
    ap.add_argument("--any-qb", action="store_true",
                    help="also count non-superflex leagues (default: superflex only)")
    ap.add_argument("--trade-weeks", type=int, default=18,
                    help="scan transaction weeks 1..N per league for trades (0 = skip trades)")
    ap.add_argument("--log-every", type=float, default=10.0,
                    help="print a progress heartbeat at least every N seconds")
    ap.add_argument("--out", default="data/league_signals.json")
    ap.add_argument("--trades-out", default="data/trade_corpus.json")
    args = ap.parse_args()
    seeds = args.seeds or DEFAULT_SEEDS
    season = args.season or (get("/state/nfl") or {}).get("season")
    if not season:
        sys.exit("could not resolve season from /state/nfl; pass --season")

    t0 = last_log = time.time()

    def heartbeat(tag="crawling"):
        el = int(time.time() - t0)
        rate = _calls / (time.time() - t0) if time.time() > t0 else 0
        print(f"[{el // 60:02d}:{el % 60:02d}] {tag}: {n_visited} visited / "
              f"{n_counted} counted | {len(seen_users)} users | "
              f"{len(seen_drafts)} drafts | {len(trades)} trades | "
              f"frontier {len(frontier)} | {_calls} calls ({rate:.1f}/s)",
              file=sys.stderr, flush=True)

    require_sf = not args.any_qb
    print(f"seeds={seeds} season={season} max_leagues={args.max_leagues} "
          f"count-filter: teams={args.teams or 'any'} superflex={require_sf} "
          f"trade_weeks={args.trade_weeks}", file=sys.stderr, flush=True)

    seen_leagues, seen_users, seen_drafts = set(), set(), set()
    trades = {}                          # transaction_id -> trade (deduped across leagues)
    rostered = defaultdict(int)          # pid -> # COUNTED leagues rostering
    started = defaultdict(int)           # pid -> # counted leagues starting
    taxied = defaultdict(int)            # pid -> # counted leagues stashing on taxi
    startup_adp = defaultdict(list)      # pid -> [pick_no, ...] in startup drafts
    rookie_adp = defaultdict(list)       # pid -> [pick_no, ...] in rookie drafts
    frontier = deque(seeds)
    n_visited = n_counted = 0

    def adp(store, pid):
        v = store.get(pid) or []
        return (round(sum(v) / len(v), 1), len(v)) if v else (None, 0)

    def flush():
        """Write both outputs. Called periodically so a timeout/kill on a long
        crawl still leaves the work done so far (not just at the very end)."""
        players = {}
        for pid in set(rostered) | set(startup_adp) | set(rookie_adp):
            sa, sn = adp(startup_adp, pid)
            ra, rn = adp(rookie_adp, pid)
            players[pid] = {
                "roster_rate": round(rostered[pid] / n_counted, 4) if n_counted else 0.0,
                "start_rate": round(started[pid] / n_counted, 4) if n_counted else 0.0,
                "taxi_rate": round(taxied[pid] / n_counted, 4) if n_counted else 0.0,
                "startup_adp": sa, "startup_n": sn, "rookie_adp": ra, "rookie_n": rn,
            }
        today = datetime.date.today().isoformat()
        dest = Path(args.out)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(
            {"generated": today, "season": season,
             "leagues_visited": n_visited, "leagues_counted": n_counted,
             "format": {"teams": args.teams or "any", "superflex_only": require_sf},
             "users_seen": len(seen_users), "drafts_seen": len(seen_drafts),
             "players": players}, indent=1), encoding="utf-8")
        if args.trade_weeks:
            Path(args.trades_out).write_text(json.dumps(
                {"generated": today, "season": season, "leagues": n_counted,
                 "trades": list(trades.values())}, indent=1), encoding="utf-8")
        return len(players)

    while frontier and n_visited < args.max_leagues:
        lid = frontier.popleft()
        if lid in seen_leagues:
            continue
        seen_leagues.add(lid)
        try:
            league = get(f"/league/{lid}")
            if not is_dynasty(league):
                continue                 # only dynasty leagues are traversed at all
            rosters = get(f"/league/{lid}/rosters") or []
            if not rosters:
                continue
            n_visited += 1
            # every dynasty league expands the frontier (bridge to more users),
            # but only ON-FORMAT leagues contribute data to the aggregates
            counts = counts_for_data(league, args.teams, require_sf)
            here_players, here_taxi, here_start = set(), set(), set()
            for r in rosters:
                if counts:
                    here_players.update(r.get("players") or [])
                    here_taxi.update(r.get("taxi") or [])
                    # starters can contain "0" for empty lineup slots — drop those
                    here_start.update(p for p in (r.get("starters") or []) if p and p != "0")
                for uid in [r.get("owner_id"), *(r.get("co_owners") or [])]:
                    if not uid or uid in seen_users:
                        continue
                    seen_users.add(uid)
                    for lg in (get(f"/user/{uid}/leagues/nfl/{season}") or []):
                        nlid = lg.get("league_id")
                        if nlid and nlid not in seen_leagues and is_dynasty(lg):
                            frontier.append(nlid)
            if not counts:
                if time.time() - last_log >= args.log_every:
                    heartbeat(); last_log = time.time()
                continue                 # off-format: keep its users, drop its data
            n_counted += 1
            for pid in here_players:
                rostered[pid] += 1
            for pid in here_start:
                started[pid] += 1
            for pid in here_taxi:
                taxied[pid] += 1
            # drafts -> ADP (completed drafts only, so partial boards don't skew it)
            for d in (get(f"/league/{lid}/drafts") or []):
                did = d.get("draft_id")
                if not did or did in seen_drafts or d.get("status") != "complete":
                    continue
                seen_drafts.add(did)
                rounds = (d.get("settings") or {}).get("rounds") or 0
                bucket = startup_adp if rounds >= STARTUP_MIN_ROUNDS else rookie_adp
                for pk in (get(f"/draft/{did}/picks") or []):
                    pid, pno = pk.get("player_id"), pk.get("pick_no")
                    if pid and pno:
                        bucket[pid].append(pno)
            # trades -> corpus. transaction_ids are globally unique, so the same
            # deal reached from two leagues is stored once.
            for wk in range(1, args.trade_weeks + 1):
                for tx in (get(f"/league/{lid}/transactions/{wk}") or []):
                    if tx.get("type") != "trade" or tx.get("status") != "complete":
                        continue
                    tid = tx.get("transaction_id")
                    if tid and tid not in trades:
                        trades[tid] = extract_trade(tx, season)
            if n_counted % CHECKPOINT_EVERY == 0:
                flush()                  # periodic save so a timeout keeps progress
        except RuntimeError:
            raise                        # rate-limit exhaustion: stop cleanly
        except Exception as e:
            print(f"  skip league {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            heartbeat()
            last_log = time.time()

    heartbeat("done" if not frontier else f"stopped at max-leagues {args.max_leagues}")
    n_players = flush()
    print(f"wrote {args.out}: {n_counted} counted leagues ({n_visited} visited), "
          f"{len(seen_users)} users, {len(seen_drafts)} drafts, {n_players} players")
    if args.trade_weeks:
        print(f"wrote {args.trades_out}: {len(trades)} unique completed trades")


if __name__ == "__main__":
    main()
