#!/usr/bin/env python3
"""
sleeper_crawl.py — stateful, sharded dynasty-league crawler in three modes that
run as separate scheduled jobs (separate runner IPs = separate rate budgets, so
they parallelize past Sleeper's ~1000/min per-IP cap).

  --mode signals : the ONLY discoverer. Snowballs the user<->league graph, keeps
                   on-format (superflex/12-team) leagues, and records roster% /
                   start% / taxi% from a rolling window of roster snapshots.
                   Publishes data/crawl_leagues.json (the counted league IDs) as
                   the hand-off, and data/league_signals.json.
  --mode trades  : reads crawl_leagues.json, takes its SHARD of the leagues
                   (league_id % nshards == shard), pulls transactions, and
                   accumulates a deduped trade corpus. Run as a 4-way matrix.
  --mode drafts  : reads crawl_leagues.json, pulls drafts, emits ADP
                   (data/draft_signals.json).

Each mode owns a separate --state dir (persisted via the workflow's cache) and a
separate output, so the modes/shards never clobber each other. A league is
skipped until its per-mode timestamp is older than --cooldown-days, so repeated
6-hour runs reach an ever-larger, self-refreshing set of leagues.

Seeds (signals): the Big Dog Dynasty chain, 2022-2026.
"""
import argparse, datetime, json, sys, time, urllib.error, urllib.request
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.sleeper.app/v1"
DELAY = 0.12
RETRIES = 3
RATE_LIMIT_TRIES = 10
STARTUP_MIN_ROUNDS = 10
CHECKPOINT_EVERY = 250
DEFAULT_SEEDS = ["1312221243742621696", "1180090288907112448",
                 "1048300464669937664", "916360462835634176",
                 "814608002207334400"]

_calls = 0


def get(path):
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


def is_dynasty(l):
    return bool(l) and (l.get("settings") or {}).get("type") == 2


def is_superflex(l):
    rp = l.get("roster_positions") or []
    return "SUPER_FLEX" in rp or rp.count("QB") >= 2


def counts_for_data(l, teams, require_sf):
    if teams and l.get("total_rosters") != teams:
        return False
    if require_sf and not is_superflex(l):
        return False
    return True


def extract_trade(tx, season):
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


# ---------------------------------------------------------------- state I/O ---
def jload(p, default):
    p = Path(p)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def jdump(p, obj):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj), encoding="utf-8")


def fresh(ts, cooldown_days):
    return ts is not None and (time.time() - ts) < cooldown_days * 86400


def load_player_exp(state_dir, cache_hours=20):
    """{pid: years_exp} for the rookie-class filter, refreshed from /players/nfl
    at most ~daily (Sleeper asks the 5MB map be pulled sparingly)."""
    f = Path(state_dir) / "player_exp.json"
    cached = jload(f, {})
    if cached.get("ts") and (time.time() - cached["ts"]) < cache_hours * 3600:
        return cached.get("exp", {})
    pmap = get("/players/nfl") or {}
    exp = {pid: p.get("years_exp") for pid, p in pmap.items()
           if isinstance(p, dict) and p.get("years_exp") is not None}
    jdump(f, {"ts": time.time(), "exp": exp})
    return exp


def make_heartbeat(t0, counters):
    def hb(tag="crawling"):
        el = int(time.time() - t0)
        rate = _calls / (time.time() - t0) if time.time() > t0 else 0
        parts = " | ".join(f"{k} {v}" for k, v in counters().items())
        print(f"[{el // 60:02d}:{el % 60:02d}] {tag}: {parts} | {_calls} calls "
              f"({rate:.1f}/s)", file=sys.stderr, flush=True)
    return hb


# ------------------------------------------------------------ mode: signals ---
def mode_signals(args, t0):
    sd = Path(args.state)
    registry = jload(sd / "registry.json", {})     # lid -> {counts, last_signals}
    frontier = deque(jload(sd / "frontier.json", []) or args.seeds or DEFAULT_SEEDS)
    snapshots = jload(sd / "snapshots.json", {})   # lid -> {ts, players, starters, taxi}
    seen_users = {}                                # transient per run
    require_sf = not args.any_qb
    # re-enqueue counted leagues whose snapshots have gone stale, for refresh
    for lid, m in registry.items():
        if m.get("counts") and not fresh(m.get("last_signals"), args.cooldown_days):
            frontier.append(lid)
    n_visited = n_counted = 0
    counters = lambda: {"visited": n_visited, "counted": n_counted,
                        "registry": len(registry), "frontier": len(frontier)}
    hb = make_heartbeat(t0, counters)
    print(f"[signals] seeds={list(frontier)[:3]}... cooldown={args.cooldown_days}d "
          f"teams={args.teams or 'any'} sf={require_sf}", file=sys.stderr, flush=True)

    def flush():
        cutoff = time.time() - args.cooldown_days * 86400
        live = {lid: s for lid, s in snapshots.items() if s.get("ts", 0) >= cutoff}
        snapshots.clear(); snapshots.update(live)
        n = len(live)
        rostered, started, taxied = defaultdict(int), defaultdict(int), defaultdict(int)
        for s in live.values():
            for pid in set(s.get("players") or []): rostered[pid] += 1
            for pid in set(s.get("starters") or []): started[pid] += 1
            for pid in set(s.get("taxi") or []): taxied[pid] += 1
        players = {pid: {"roster_rate": round(rostered[pid] / n, 4),
                         "start_rate": round(started[pid] / n, 4),
                         "taxi_rate": round(taxied[pid] / n, 4)}
                   for pid in rostered} if n else {}
        jdump(ROOT / args.signals_out,
              {"generated": datetime.date.today().isoformat(), "season": args.season,
               "leagues": n, "format": {"teams": args.teams or "any", "superflex_only": require_sf},
               "players": players})
        counted_ids = [lid for lid, m in registry.items() if m.get("counts")]
        jdump(ROOT / args.leagues_out,
              {"generated": datetime.date.today().isoformat(), "count": len(counted_ids),
               "leagues": counted_ids})
        jdump(sd / "registry.json", registry)
        jdump(sd / "frontier.json", list(frontier))
        jdump(sd / "snapshots.json", snapshots)
        return n

    deadline = t0 + args.max_minutes * 60 if args.max_minutes else None
    last_log = t0
    while frontier and n_visited < args.max_leagues:
        if deadline and time.time() >= deadline:
            break
        lid = frontier.popleft()
        m = registry.get(lid)
        if m and fresh(m.get("last_signals"), args.cooldown_days):
            continue                                # already fresh this window
        try:
            league = get(f"/league/{lid}")
            if not is_dynasty(league):
                continue
            rosters = get(f"/league/{lid}/rosters") or []
            if not rosters:
                continue
            n_visited += 1
            counts = counts_for_data(league, args.teams, require_sf)
            registry[lid] = {"counts": counts, "last_signals": time.time(),
                             "last_trades": (m or {}).get("last_trades"),
                             "last_drafts": (m or {}).get("last_drafts")}
            here_p, here_t, here_s = set(), set(), set()
            for r in rosters:
                if counts:
                    here_p.update(r.get("players") or [])
                    here_t.update(r.get("taxi") or [])
                    here_s.update(p for p in (r.get("starters") or []) if p and p != "0")
                for uid in [r.get("owner_id"), *(r.get("co_owners") or [])]:
                    if not uid or uid in seen_users:
                        continue
                    seen_users[uid] = 1
                    for lg in (get(f"/user/{uid}/leagues/nfl/{args.season}") or []):
                        nlid = lg.get("league_id")
                        if not nlid or not is_dynasty(lg):
                            continue
                        rm = registry.get(nlid)
                        if not rm or not fresh(rm.get("last_signals"), args.cooldown_days):
                            frontier.append(nlid)
            if counts:
                n_counted += 1
                snapshots[lid] = {"ts": time.time(), "players": list(here_p),
                                  "starters": list(here_s), "taxi": list(here_t)}
                if n_counted % CHECKPOINT_EVERY == 0:
                    flush()
        except RuntimeError:
            raise
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    n = flush()
    hb("done" if not frontier else "stopped")
    print(f"[signals] {n_counted} counted this run, {n} leagues in window, "
          f"{len(seen_users)} users", file=sys.stderr, flush=True)


# ------------------------------------------------------------- mode: trades ---
def mode_trades(args, t0):
    sd = Path(args.state)
    progress = jload(sd / "progress.json", {})     # lid -> last_trades ts
    trades = jload(sd / "trades.json", {})         # tid -> trade
    league_list = jload(ROOT / args.leagues_out, {}).get("leagues", [])
    mine = [lid for lid in league_list
            if int(lid) % args.nshards == args.shard
            and not fresh(progress.get(lid), args.cooldown_days)]
    n_done = 0
    counters = lambda: {"shard": f"{args.shard}/{args.nshards}", "todo": len(mine) - n_done,
                        "done": n_done, "trades": len(trades)}
    hb = make_heartbeat(t0, counters)
    print(f"[trades] shard {args.shard}/{args.nshards}: {len(mine)} leagues due "
          f"of {len(league_list)}", file=sys.stderr, flush=True)

    def flush():
        # prune trades older than the window by their created week is unknown; keep
        # a rolling cap by dropping leagues' contributions is complex — instead keep
        # all deduped trades (corpus is append-only market history).
        jdump(sd / "progress.json", progress)
        jdump(sd / "trades.json", trades)
        jdump(ROOT / (args.trades_out.replace(".json", f"_{args.shard}.json")),
              {"generated": datetime.date.today().isoformat(), "shard": args.shard,
               "nshards": args.nshards, "trades": list(trades.values())})
        return len(trades)

    deadline = t0 + args.max_minutes * 60 if args.max_minutes else None
    last_log = t0
    for lid in mine:
        if deadline and time.time() >= deadline:
            break
        try:
            for wk in range(1, args.trade_weeks + 1):
                for tx in (get(f"/league/{lid}/transactions/{wk}") or []):
                    if tx.get("type") != "trade" or tx.get("status") != "complete":
                        continue
                    tid = tx.get("transaction_id")
                    if tid and tid not in trades:
                        trades[tid] = extract_trade(tx, args.season)
            progress[lid] = time.time()
            n_done += 1
            if n_done % CHECKPOINT_EVERY == 0:
                flush()
        except RuntimeError:
            raise
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    flush()
    hb("done")
    print(f"[trades] shard {args.shard}: pulled {n_done} leagues, {len(trades)} trades",
          file=sys.stderr, flush=True)


# ------------------------------------------------------------- mode: drafts ---
def mode_drafts(args, t0):
    sd = Path(args.state)
    progress = jload(sd / "progress.json", {})     # lid -> last_drafts ts
    contrib = jload(sd / "contrib.json", {})       # lid -> {ts, startup:{pid:[pno]}, rookie:{...}}
    seen_drafts = set(jload(sd / "seen_drafts.json", []))
    league_list = jload(ROOT / args.leagues_out, {}).get("leagues", [])
    mine = [lid for lid in league_list if not fresh(progress.get(lid), args.cooldown_days)]
    exp = load_player_exp(sd)                      # {pid: years_exp}
    cur = int(args.season)

    def is_rookie_of(pid, dseason):
        """True iff the player's draft class == this draft's season."""
        ye = exp.get(pid)
        return ye is not None and dseason and (cur - ye) == int(dseason)

    n_done = 0
    counters = lambda: {"todo": len(mine) - n_done, "done": n_done, "leagues": len(contrib)}
    hb = make_heartbeat(t0, counters)
    print(f"[drafts] {len(mine)} leagues due of {len(league_list)}", file=sys.stderr, flush=True)

    def flush():
        cutoff = time.time() - args.cooldown_days * 86400
        live = {lid: c for lid, c in contrib.items() if c.get("ts", 0) >= cutoff}
        contrib.clear(); contrib.update(live)
        startup, rookie = defaultdict(list), defaultdict(list)
        for c in live.values():
            for pid, picks in (c.get("startup") or {}).items(): startup[pid] += picks
            for pid, picks in (c.get("rookie") or {}).items(): rookie[pid] += picks
        def adp(store, pid):
            v = store.get(pid) or []
            return (round(sum(v) / len(v), 1), len(v)) if v else (None, 0)
        players = {}
        for pid in set(startup) | set(rookie):
            sa, sn = adp(startup, pid); ra, rn = adp(rookie, pid)
            players[pid] = {"startup_adp": sa, "startup_n": sn, "rookie_adp": ra, "rookie_n": rn}
        jdump(ROOT / args.drafts_out,
              {"generated": datetime.date.today().isoformat(), "leagues": len(live), "players": players})
        jdump(sd / "progress.json", progress)
        jdump(sd / "contrib.json", contrib)
        jdump(sd / "seen_drafts.json", list(seen_drafts))
        return len(players)

    deadline = t0 + args.max_minutes * 60 if args.max_minutes else None
    last_log = t0
    for lid in mine:
        if deadline and time.time() >= deadline:
            break
        try:
            su, rk = defaultdict(list), defaultdict(list)
            for d in (get(f"/league/{lid}/drafts") or []):
                did = d.get("draft_id")
                if not did or did in seen_drafts or d.get("status") != "complete":
                    continue
                seen_drafts.add(did)
                rounds = (d.get("settings") or {}).get("rounds") or 0
                startup = rounds >= STARTUP_MIN_ROUNDS
                dseason = d.get("season")
                for pk in (get(f"/draft/{did}/picks") or []):
                    pid, pno = pk.get("player_id"), pk.get("pick_no")
                    if not (pid and pno):
                        continue
                    if startup:
                        su[pid].append(pno)          # startups: everyone counts
                    elif is_rookie_of(pid, dseason):
                        rk[pid].append(pno)          # rookie bucket: matching class only
            contrib[lid] = {"ts": time.time(), "startup": dict(su), "rookie": dict(rk)}
            progress[lid] = time.time()
            n_done += 1
            if n_done % CHECKPOINT_EVERY == 0:
                flush()
        except RuntimeError:
            raise
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    flush()
    hb("done")


def main():
    ap = argparse.ArgumentParser(description="stateful sharded dynasty crawler")
    ap.add_argument("--mode", choices=["signals", "trades", "drafts"], required=True)
    ap.add_argument("--state", required=True, help="state dir (persisted via CI cache)")
    ap.add_argument("seeds", nargs="*", help="signals: seed league_ids (default: Big Dog chain)")
    ap.add_argument("--season")
    ap.add_argument("--cooldown-days", type=float, default=7.0)
    ap.add_argument("--max-leagues", type=int, default=1000000, help="signals: visit cap per run")
    ap.add_argument("--max-minutes", type=float, default=0, help="self-stop budget (0 = none)")
    ap.add_argument("--teams", type=int, default=12, help="signals: only count N-team leagues (0=any)")
    ap.add_argument("--any-qb", action="store_true", help="signals: also count non-superflex")
    ap.add_argument("--trade-weeks", type=int, default=18)
    ap.add_argument("--shard", type=int, default=0, help="trades: this shard index")
    ap.add_argument("--nshards", type=int, default=1, help="trades: total shards")
    ap.add_argument("--log-every", type=float, default=10.0)
    ap.add_argument("--signals-out", default="data/league_signals.json")
    ap.add_argument("--leagues-out", default="data/crawl_leagues.json")
    ap.add_argument("--trades-out", default="data/trade_corpus.json")
    ap.add_argument("--drafts-out", default="data/draft_signals.json")
    args = ap.parse_args()
    args.season = args.season or (get("/state/nfl") or {}).get("season")
    if not args.season:
        sys.exit("could not resolve season; pass --season")
    t0 = time.time()
    {"signals": mode_signals, "trades": mode_trades, "drafts": mode_drafts}[args.mode](args, t0)


if __name__ == "__main__":
    main()
