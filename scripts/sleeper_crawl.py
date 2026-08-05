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
import argparse, csv, datetime, hashlib, json, re, sys, time, urllib.error, urllib.request
from collections import defaultdict, deque
from pathlib import Path

# one definition of "franchise-level season", shared with the analysis script
# rather than restated — see METHODOLOGY.md "Franchise players"
from franchise_players import ELITE_BAR, FRANCHISE_BAR, MIN_SEASONS as MIN_FRANCHISE_SEASONS

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://api.sleeper.app/v1"
DELAY = 0.12
RETRIES = 3
RATE_LIMIT_TRIES = 10
STARTUP_MIN_ROUNDS = 10
CHECKPOINT_EVERY = 250
# Rookie-corpus chain walk. Sleeper's /league/<id>/drafts is per league_id, and
# a league_id is ONE SEASON — so a crawl seeded from current-season leagues can
# only ever see the current rookie class. Follow previous_league_id back to
# reach older classes; stop at FIRST_CLASS, the oldest class Bridge A prices.
FIRST_CLASS = 2019
MAX_CHAIN = 10
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


def shard_of(lid, nshards):
    """Stable, uniform shard for a league_id. NOT int(lid) % n: Sleeper IDs are
    Snowflake IDs whose low bits (a sequence counter) are almost always 0, so
    modulo dumps nearly everything into shard 0. md5 scrambles the bits evenly."""
    return int(hashlib.md5(lid.encode()).hexdigest()[:8], 16) % nshards


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


def extract_trade(tx, season, lid):
    """One trade, flattened.

    `lid` is the join key. Without it the corpus is a bag of anonymous trades:
    a roster_id means nothing on its own, two trades can't be known to belong to
    the same league, and no trade can be tied to an outcome (who won, who held
    which picks). Every league-level question — do champions buy or sell picks,
    does trading your own 1st help — needs this field and nothing else new.
    """
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
    return {"tid": tx.get("transaction_id"), "lid": lid, "season": season,
            "week": tx.get("leg"), "sides": list(sides.values())}


# ---------------------------------------------------------------- state I/O ---
def jload(p, default):
    p = Path(p)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def jdump(p, obj):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj), encoding="utf-8")


def git_push(paths, message):
    """Best-effort commit+push of output files mid-crawl (durable incremental
    saves + gets crawl_leagues.json to the trades/drafts crawlers early). Never
    fatal: the end-of-job commit step is the backstop.

    RE-PARENTS onto origin rather than rebasing onto it. These outputs are
    generated files rewritten whole on every flush, so `pull --rebase` hits a
    content conflict on every replayed commit — deterministically, not
    occasionally. The old loop retried the identical rebase four times, aborted
    each one, and left the commit behind; over a long run that stacked eight
    unpushed commits and handed the end-of-job step a rebase it could not
    finish either. A mixed reset onto the fetched head keeps the working tree,
    drops the local commits and stages only our own paths, so the newest
    complete file wins and no merge is ever attempted. Safe because each mode
    is the only writer of the files it names.
    """
    import subprocess
    def run(*a):
        return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True)
    try:
        run("config", "user.name", "big-dog-bot")
        run("config", "user.email", "actions@users.noreply.github.com")
        # heal a detached HEAD left by an older build's conflicted rebase
        run("rebase", "--abort")
        for i in range(1, 5):
            if run("fetch", "origin", "main").returncode != 0:
                time.sleep(i * 5)
                continue
            run("reset", "FETCH_HEAD")
            run("add", *paths)
            if run("diff", "--cached", "--quiet").returncode == 0:
                return                              # nothing new to push
            run("commit", "-m", message)
            if run("push", "origin", "HEAD:main").returncode == 0:
                print(f"  pushed: {message}", file=sys.stderr, flush=True)
                return
            time.sleep(i * 5)
        print("  periodic push failed; end-of-run commit is the backstop",
              file=sys.stderr, flush=True)
    except Exception as e:
        print(f"  periodic push error: {e}", file=sys.stderr, flush=True)


def fresh(ts, cooldown_days):
    return ts is not None and (time.time() - ts) < cooldown_days * 86400


def load_player_meta(state_dir, cache_hours=20):
    """{pid: {exp, name, pos, dob}} from /players/nfl (rookie-class filter + the
    rookie pick corpus's name/pos, which pick_value matches to gsis). `dob` is
    what joins a Sleeper player to nflverse WAR — see elite_index(). Refreshed
    ~daily; a cache written before `dob` existed is discarded rather than used,
    or every elite count would silently come back zero."""
    f = Path(state_dir) / "player_meta.json"
    cached = jload(f, {})
    fresh_enough = cached.get("ts") and (time.time() - cached["ts"]) < cache_hours * 3600
    has_dob = any("dob" in v for v in (cached.get("meta") or {}).values())
    if fresh_enough and has_dob:
        return cached["meta"]
    pmap = get("/players/nfl") or {}
    meta = {pid: {"exp": p.get("years_exp"),
                  "name": (p.get("first_name", "") + " " + p.get("last_name", "")).strip(),
                  "pos": p.get("position"),
                  "dob": p.get("birth_date")}
            for pid, p in pmap.items() if isinstance(p, dict)}
    jdump(f, {"ts": time.time(), "meta": meta})
    return meta


def _last(name):
    n = (name or "").lower().replace(".", "").replace("'", "").replace("-", " ")
    n = re.sub(r"\s+(jr|sr|ii|iii|iv|v)$", "", n.strip())
    return (n.split() or [""])[-1]


# Lineup slots priced on a championship roster. Mirrors ROSTER_POSITIONS
# (QB, RB, RB, WR, WR, WR, TE, FLEX, SUPER_FLEX): QB2 is the superflex slot.
# Slot n = the roster's nth-best player at that position by THAT season's WAR,
# which prices the lineup a manager could actually field rather than the one he
# did — the same "best legal lineup" convention the rest of the board uses.
LINEUP_SLOTS = [("QB", 1), ("QB", 2), ("RB", 1), ("RB", 2),
                ("WR", 1), ("WR", 2), ("WR", 3), ("TE", 1)]
SLOT_FIELDS = [f"{p.lower()}{n}_war" for p, n in LINEUP_SLOTS]


def slot_wars(players, wars, season):
    """[WAR of QB1, QB2, RB1, RB2, WR1, WR2, WR3, TE1] for one roster.

    A slot with nobody in it is 0.0, not missing: a team carrying one
    quarterback in superflex really did field nothing in that slot, and
    dropping it from the average would flatter exactly the rosters that were
    short. Players absent from nfl_history never played, so 0.0 is right there
    too.
    """
    have = defaultdict(list)
    for pid in players:
        rec = wars.get((season, pid))
        if rec:
            have[rec[0]].append(rec[1])
    for v in have.values():
        v.sort(reverse=True)
    return [round(have[p][n - 1], 3) if len(have.get(p, ())) >= n else 0.0
            for p, n in LINEUP_SLOTS]


def tier_index(pmeta):
    """(season, sleeper_pid) -> (position, WAR) for EVERY scored player-season.

    Full WAR, not a tier flag: pricing a lineup slot needs the value of the
    roster's third-best receiver whatever it is, and a bar-filtered index only
    knows about players above the bar. Tiers are derived from this at read time
    via FRANCHISE_BAR / ELITE_BAR.

    The join is **last name + date of birth**, not name. nflverse stores legal
    names and Sleeper stores common ones, so a name match loses Josh Allen,
    Tom Brady, DK Metcalf, Deebo Samuel, T.J. Hockenson and Deshaun Watson —
    20% of all elite player-seasons, and precisely the players who decide
    titles. Last name plus DOB resolves 245 of 245 elite seasons since 2020.

    Reads nfl_history/waa_war_<season>.csv, which is committed, so this costs
    no API calls. Missing history (a fresh checkout) yields empty indexes and
    the tier columns come back zero.

    Returns (tiers, became). `became` is pid -> the season a player's THIRD
    qualifying year landed, which is the CAREER definition — a franchise player
    per METHODOLOGY.md is three such seasons, not one. A roster in season S
    holds one iff `became[pid] <= S`, so the measure stays backward-looking and
    no 2022 team is credited for a career that matured in 2024.
    """
    by_key = {}
    for pid, m in pmeta.items():
        if m.get("dob") and m.get("pos") in FRANCHISE_BAR:
            by_key[(_last(m.get("name")), m["dob"])] = pid
    hist = ROOT / "nfl_history"
    meta_f = hist / "players_meta.csv"
    if not meta_f.exists():
        return {}, {}
    dob_of = {}
    with open(meta_f, encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            dob_of[r["gsis_id"]] = (_last(r["name"]), r["birth_date"])
    out, qual = {}, defaultdict(list)
    for f in sorted(hist.glob("waa_war_*.csv")):
        m = re.search(r"waa_war_(\d{4})\.csv$", f.name)
        if not m:
            continue
        season = int(m.group(1))
        with open(f, encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                pos = r["pos"]
                bar = FRANCHISE_BAR.get(pos)
                if bar is None:
                    continue
                w = float(r["WAR"])
                pid = by_key.get(dob_of.get(r["player_id"]))
                if pid:
                    out[(season, pid)] = (pos, w)
                    if w >= bar:
                        qual[pid].append(season)
    # pid -> the season his THIRD qualifying year landed. A roster in season S
    # holds a franchise player iff that season is <= S, which is what keeps the
    # measure backward-looking: no 2022 team is credited for a career that only
    # became franchise-grade in 2024.
    became = {pid: sorted(seasons)[MIN_FRANCHISE_SEASONS - 1]
              for pid, seasons in qual.items()
              if len(seasons) >= MIN_FRANCHISE_SEASONS}
    return out, became


def load_player_teams(state_dir, cache_hours=20):
    """{pid: nfl_team} for bye detection, refreshed from /players/nfl ~daily."""
    f = Path(state_dir) / "player_teams.json"
    cached = jload(f, {})
    if cached.get("ts") and (time.time() - cached["ts"]) < cache_hours * 3600:
        return cached.get("team", {})
    pmap = get("/players/nfl") or {}
    team = {pid: p.get("team") for pid, p in pmap.items()
            if isinstance(p, dict) and p.get("team")}
    jdump(f, {"ts": time.time(), "team": team})
    return team


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
    # season-long start% accumulator: usage = started-weeks / rostered-weeks.
    # Each weekly re-crawl of a league adds one observation, so a single injured
    # week barely moves it (and a half-season absence rightly lowers it). Unlike
    # roster%/taxi% (windowed to "now"), this accumulates all season, reset at
    # rollover.
    acc_raw = jload(sd / "start_acc.json", {})
    if acc_raw.get("season") != args.season:
        acc_raw = {"season": args.season, "acc": {}}
    start_acc = acc_raw["acc"]                      # pid -> [started_obs, rostered_obs]
    # bye handling: a player on bye can't start, so that week isn't a fair usage
    # observation — skip it. Only needed in-season.
    pid_team, byes = {}, {}
    if args.season_type == "regular":
        pid_team = load_player_teams(sd)
        byes = jload(ROOT / "data" / str(args.season) / "byes.json", {})   # {team: week}
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
        rostered, taxied, started_now = defaultdict(int), defaultdict(int), defaultdict(int)
        for s in live.values():
            for pid in set(s.get("players") or []): rostered[pid] += 1
            for pid in set(s.get("starters") or []): started_now[pid] += 1
            for pid in set(s.get("taxi") or []): taxied[pid] += 1
        players = {}
        for pid in rostered:
            sa = start_acc.get(pid, [0, 0])           # season usage, not this week
            players[pid] = {
                "roster_rate": round(rostered[pid] / n, 4),
                "start_rate": round(sa[0] / sa[1], 4) if sa[1] else 0.0,  # season avg (primary)
                "start_obs": sa[1],                                       # weeks backing it
                "start_rate_now": round(started_now[pid] / rostered[pid], 4),  # current snapshot fallback
                "taxi_rate": round(taxied[pid] / n, 4)}
        jdump(sd / "start_acc.json", {"season": args.season, "acc": start_acc})
        jdump(ROOT / args.signals_out,
              {"generated": datetime.date.today().isoformat(), "season": args.season,
               "season_type": args.season_type, "week": args.week, "leagues": n,
               "format": {"teams": args.teams or "any", "superflex_only": require_sf},
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
    rate_limited = None
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
                # one weekly usage observation per rostered player — regular
                # season only, and skipping anyone on BYE this week (a bye isn't
                # a fair "chose not to start him" observation)
                if args.season_type == "regular":
                    for pid in here_p:
                        tm = pid_team.get(pid)
                        if tm and byes.get(tm) == args.week:
                            continue
                        a = start_acc.setdefault(pid, [0, 0])
                        a[1] += 1                    # rostered, available
                        if pid in here_s:
                            a[0] += 1                # started
                if n_counted % CHECKPOINT_EVERY == 0:
                    flush()
                if args.commit_every and n_counted % args.commit_every == 0:
                    git_push([args.signals_out, args.leagues_out],
                             f"Crawl signals (partial, {n_counted} leagues) "
                             f"{datetime.date.today().isoformat()}")
        except RuntimeError as e:
            # Rate-limit exhaustion. Do NOT re-raise: an escaping exception
            # skips the flush below AND fails the job, and a failed job skips
            # the actions/cache post-step save — losing the whole run's state,
            # not just this league. Flush, report, and exit 0 so the cache
            # persists; the next scheduled run resumes from here.
            rate_limited = e
            break
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    n = flush()
    if rate_limited:
        print(f"[signals] stopped early: {rate_limited}", file=sys.stderr, flush=True)
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
            if shard_of(lid, args.nshards) == args.shard
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
    rate_limited = None
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
                        trades[tid] = extract_trade(tx, args.season, lid)
            progress[lid] = time.time()
            n_done += 1
            if n_done % CHECKPOINT_EVERY == 0:
                flush()
        except RuntimeError as e:
            # see mode_signals: flush + exit 0, or the CI cache save is lost
            rate_limited = e
            break
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    flush()
    if rate_limited:
        print(f"[trades] stopped early: {rate_limited}", file=sys.stderr, flush=True)
    hb("done")
    print(f"[trades] shard {args.shard}: pulled {n_done} leagues, {len(trades)} trades",
          file=sys.stderr, flush=True)


# ------------------------------------------------------------- mode: drafts ---
def mode_drafts(args, t0):
    sd = Path(args.state)
    progress = jload(sd / "progress.json", {})     # lid -> last_drafts ts
    contrib = jload(sd / "contrib.json", {})       # lid -> {ts, startup:{pid:[pno]}, rookie:{...}}
    # did -> [league_id, season, kind] for every completed draft ever walked.
    # This was a bare set used only for dedup, which threw away the one fact
    # that makes the corpus joinable: WHICH league a draft belonged to. The
    # aggregate rookie corpus stays keyed "season|pick|pid" (it must — see
    # flush()), so this index is what lets a per-league question be asked of it
    # later. One row per draft, not per pick.
    raw_seen = jload(sd / "seen_drafts.json", {})
    seen_drafts = ({d: None for d in raw_seen} if isinstance(raw_seen, list)
                   else dict(raw_seen))          # migrate the old list form
    # rookie-pick corpus for Bridge A: "season|pick|pid" -> # drafts. Persistent
    # and NOT windowed — a completed rookie draft is a permanent historical fact.
    rookie_corpus = jload(sd / "rookie_corpus.json", {})
    # league_ids whose chain has already been walked. A predecessor reached once
    # never needs re-fetching: its own history was walked in the same pass, and
    # completed drafts don't change. Keeps the backfill a one-time cost and lets
    # next season's league_id stop as soon as it reaches this season's.
    seen_leagues = set(jload(sd / "seen_leagues.json", []))
    league_list = jload(ROOT / args.leagues_out, {}).get("leagues", [])
    mine = [lid for lid in league_list if not fresh(progress.get(lid), args.cooldown_days)]
    pmeta = load_player_meta(sd)                   # {pid: {exp, name, pos}}
    cur = int(args.season)

    def is_rookie_of(pid, dseason):
        """True iff the player's draft class == this draft's season.

        `exp` is years-of-experience as of `cur`, so this reads a historical
        class correctly for anyone still in the league. Players who have since
        retired lose their exp and drop out, which biases old classes toward
        survivors — accepted: the window is clamped to a career's first years
        and volume swamps it.
        """
        ye = (pmeta.get(pid) or {}).get("exp")
        return ye is not None and dseason and (cur - ye) == int(dseason)

    def chain_of(lid):
        """This league and its predecessors, newest first — one league_id per
        season. Without this the rookie corpus is only ever the current class."""
        out, guard = [], set()
        node = lid
        while node and node not in guard and len(out) < MAX_CHAIN:
            guard.add(node)
            out.append(node)
            if node in seen_leagues:
                break                       # history already harvested
            lg = get(f"/league/{node}")
            if not lg:
                break
            if int(lg.get("season") or 0) <= FIRST_CLASS:
                break                       # older than any class Bridge A prices
            node = lg.get("previous_league_id")
        return out

    n_done = 0
    counters = lambda: {"todo": len(mine) - n_done, "done": n_done,
                        "leagues": len(contrib), "walked": len(seen_leagues),
                        "classes": len({k.split("|")[0] for k in rookie_corpus})}
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
        # rookie pick corpus -> Bridge A. [season, pick, pid, name, pos, count]
        corpus = []
        for key, cnt in rookie_corpus.items():
            season, pno, pid = key.split("|")
            m = pmeta.get(pid) or {}
            corpus.append([int(season), int(pno), pid, m.get("name"), m.get("pos"), cnt])
        jdump(ROOT / args.rookie_out,
              {"generated": datetime.date.today().isoformat(), "picks": corpus})
        # The draft -> league index. Published as well as kept in state so a
        # consumer can join drafts to leagues without the CI cache.
        jdump(ROOT / args.draft_index_out,
              {"generated": datetime.date.today().isoformat(),
               "drafts": {d: v for d, v in seen_drafts.items() if v}})
        jdump(sd / "rookie_corpus.json", rookie_corpus)
        jdump(sd / "seen_leagues.json", sorted(seen_leagues))
        jdump(sd / "progress.json", progress)
        jdump(sd / "contrib.json", contrib)
        jdump(sd / "seen_drafts.json", seen_drafts)
        return len(players)

    deadline = t0 + args.max_minutes * 60 if args.max_minutes else None
    last_log = t0
    rate_limited = None
    for lid in mine:
        if deadline and time.time() >= deadline:
            break
        try:
            su, rk = defaultdict(list), defaultdict(list)
            chain = chain_of(lid)
            for clid in chain:
                for d in (get(f"/league/{clid}/drafts") or []):
                    did = d.get("draft_id")
                    if not did or did in seen_drafts or d.get("status") != "complete":
                        continue
                    rounds = (d.get("settings") or {}).get("rounds") or 0
                    startup = rounds >= STARTUP_MIN_ROUNDS
                    dseason = d.get("season")
                    seen_drafts[did] = [clid, dseason,
                                        "startup" if startup else "rookie"]
                    for pk in (get(f"/draft/{did}/picks") or []):
                        pid, pno = pk.get("player_id"), pk.get("pick_no")
                        if not (pid and pno):
                            continue
                        if startup:
                            su[pid].append(pno)      # startups: everyone counts
                        elif is_rookie_of(pid, dseason):
                            rk[pid].append(pno)      # rookie bucket: matching class only
                            key = f"{dseason}|{pno}|{pid}"
                            rookie_corpus[key] = rookie_corpus.get(key, 0) + 1
            seen_leagues.update(chain)
            contrib[lid] = {"ts": time.time(), "startup": dict(su), "rookie": dict(rk)}
            progress[lid] = time.time()
            n_done += 1
            if n_done % CHECKPOINT_EVERY == 0:
                flush()
            if args.commit_every and n_done % args.commit_every == 0:
                git_push([args.drafts_out],
                         f"Crawl drafts (partial, {n_done} leagues) "
                         f"{datetime.date.today().isoformat()}")
        except RuntimeError as e:
            # see mode_signals: flush + exit 0, or the CI cache save is lost
            rate_limited = e
            break
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    flush()
    if rate_limited:
        print(f"[drafts] stopped early: {rate_limited}", file=sys.stderr, flush=True)
    hb("done")


# ----------------------------------------------------------- mode: outcomes ---
def champ_of(bracket):
    """(champion_roster_id, runner_up_roster_id) from a winners bracket.

    The title game is the one carrying placement 1. Sleeper marks it `p: 1`;
    everything else in the bracket is an earlier round or a consolation
    placement. A bracket still in progress has no winner on that game yet.
    """
    for g in bracket or []:
        if g.get("p") == 1:
            return g.get("w"), g.get("l")
    return None, None


def placements_of(winners, ranked):
    """{roster_id: place}, 1 = champion. PLAYOFF RESULT, THEN REGULAR SEASON.

    The winners bracket decides the top: a game with `p: n` places its winner
    nth and its loser (n+1)th. Everyone who missed the playoffs is ordered
    underneath by record — `ranked` is roster_ids by wins then points, Sleeper's
    own standings tiebreak.

    The consolation bracket is deliberately NOT read, so this does not always
    equal `finish` in franchises.json, which does read it. That is a definition,
    not a bug. `place` exists to answer "how bad was this roster", and many
    leagues seed the toilet bowl in reverse for draft position or never contest
    it, so its result is noise against the question. A 5-9 team that wins the
    consolation bracket was not the 7th best roster in the league.

    It also saves one API call per league-season across ~76k leagues.
    """
    place = {}
    for g in winners or []:
        p = g.get("p")
        if not p:
            continue
        if g.get("w"):
            place.setdefault(g["w"], p)
        if g.get("l"):
            place.setdefault(g["l"], p + 1)
    nxt = max(place.values()) + 1 if place else 1
    for rid in ranked:
        if rid not in place:
            place[rid] = nxt
            nxt += 1
    return place


def pick_holdings(rids, traded, nxt, rounds=4):
    """Who holds which of next season's rookie picks, and who sold their own 1st.

    /traded_picks reports only picks that MOVED, as
    {season, round, roster_id: original owner, owner_id: holder now}. So start
    everyone with their own pick in every round and apply the moves: the
    original owner loses it, the current holder gains it. A roster that flipped
    the same pick twice appears once, already resolved to its final owner.
    """
    held = {rid: {r: 1 for r in range(1, rounds + 1)} for rid in rids}
    sold_own_1st = {rid: False for rid in rids}
    for tp in traded or []:
        try:
            if int(tp.get("season") or 0) != nxt:
                continue
        except (TypeError, ValueError):
            continue
        rd, orig, now = tp.get("round"), tp.get("roster_id"), tp.get("owner_id")
        if not rd or rd > rounds or orig not in held or now not in held:
            continue
        held[orig][rd] -= 1
        held[now][rd] += 1
        if rd == 1 and orig != now:
            sold_own_1st[orig] = True
    return held, sold_own_1st


def mode_outcomes(args, t0):
    """Per league-season: who won, what each roster held, what it drafted.

    Why aggregate rather than dump rows: the raw join — every pick and every
    trade tagged with its league — is ~200 MB of JSON at full crawl scale, which
    is a database, not a repo file. So this mode answers the questions in the
    crawler and ships counters, the same trade `mode_signals` already makes.
    The cost is that a NEW question means re-crawling rather than re-querying;
    the questions baked in are the ones in ROW_FIELDS below.

    A chain is walked oldest-first so `drafted_by` accumulates forward: a 2025
    roster's homegrown share correctly counts a player it drafted in 2022.
    """
    sd = Path(args.state)
    progress = jload(sd / "progress.json", {})       # entry lid -> last ts
    rows = jload(sd / "rows.json", {})               # "lid|season" -> row
    pmeta = load_player_meta(sd)                     # {pid: {exp, name, pos, dob}}
    tier_idx, franchise_from = tier_index(pmeta)     # season tiers + career flag
    print(f"[outcomes] tier index: {len(tier_idx)} player-seasons, "
          f"{len(franchise_from)} franchise careers", file=sys.stderr, flush=True)
    league_list = jload(ROOT / args.leagues_out, {}).get("leagues", [])
    mine = [lid for lid in league_list
            if shard_of(lid, args.nshards) == args.shard
            and not fresh(progress.get(lid), args.cooldown_days)]
    n_done = 0
    counters = lambda: {"shard": f"{args.shard}/{args.nshards}",
                        "todo": len(mine) - n_done, "done": n_done,
                        "league_seasons": len(rows)}
    hb = make_heartbeat(t0, counters)
    print(f"[outcomes] shard {args.shard}/{args.nshards}: {len(mine)} leagues due "
          f"of {len(league_list)}", file=sys.stderr, flush=True)

    def flush():
        jdump(sd / "progress.json", progress)
        jdump(sd / "rows.json", rows)
        jdump(ROOT / (args.outcomes_out.replace(".json", f"_{args.shard}.json")),
              {"generated": datetime.date.today().isoformat(), "shard": args.shard,
               "nshards": args.nshards, "rows": list(rows.values())})
        jdump(ROOT / (args.outcome_signals_out.replace(".json", f"_{args.shard}.json")),
              summarize_outcomes(rows.values(), args.shard, args.nshards))
        return len(rows)

    deadline = t0 + args.max_minutes * 60 if args.max_minutes else None
    last_log = t0
    rate_limited = None
    for lid in mine:
        if deadline and time.time() >= deadline:
            break
        try:
            # walk back to the founding league, newest first, then reverse
            chain, guard, node = [], set(), lid
            while node and node not in guard and len(chain) < MAX_CHAIN:
                guard.add(node)
                lg = get(f"/league/{node}")
                if not lg:
                    break
                chain.append((node, lg))
                if int(lg.get("season") or 0) <= FIRST_CLASS:
                    break
                node = lg.get("previous_league_id")
            # The FRANCHISE key. A league_id is one season, so a chain's seasons
            # all carry different ids — grouping rows by `lid` gives one season
            # per group and no cross-season sequence can ever form (this is why
            # the first trial reported zero turnarounds in a league that had a
            # 12th-to-1st). The founding id is the oldest node: stable across
            # seasons and across runs, since a new season prepends to the chain.
            founding = chain[-1][0] if chain else lid
            drafted_by = {}                          # pid -> roster_id, chain-wide
            for node, lg in reversed(chain):
                season = int(lg.get("season") or 0)
                # harvest drafts first: they feed this season AND later ones
                for d in (get(f"/league/{node}/drafts") or []):
                    did = d.get("draft_id")
                    if not did or d.get("status") != "complete":
                        continue
                    for pk in (get(f"/draft/{did}/picks") or []):
                        pid, rid = pk.get("player_id"), pk.get("roster_id")
                        if pid and rid:
                            drafted_by.setdefault(pid, rid)
                if lg.get("status") != "complete":
                    continue                         # in-progress: no outcome yet
                rosters = get(f"/league/{node}/rosters") or []
                if not rosters:
                    continue
                rids = [r.get("roster_id") for r in rosters if r.get("roster_id")]
                bracket = get(f"/league/{node}/winners_bracket")
                cw, cl = champ_of(bracket)
                # how many teams made the playoffs, from the bracket's own
                # participants. Needed to say whether a roster made it, which
                # `place` alone cannot: 6th is in a 6-team field and out of a 4.
                n_playoff = len({r for g in (bracket or [])
                                 for r in (g.get("t1"), g.get("t2")) if r})
                rec = {r.get("roster_id"): (r.get("settings") or {}) for r in rosters}
                ranked = sorted(rids, key=lambda i: (-(rec[i].get("wins") or 0),
                                                     -float(rec[i].get("fpts") or 0)))
                place = placements_of(bracket, ranked)
                held, sold1 = pick_holdings(
                    rids, get(f"/league/{node}/traded_picks"), season + 1)
                out = []
                for r in rosters:
                    rid = r.get("roster_id")
                    if not rid:
                        continue
                    st = r.get("settings") or {}
                    players = [p for p in (r.get("players") or [])]
                    own = sum(1 for p in players if drafted_by.get(p) == rid)
                    h = held.get(rid, {})
                    # roster construction: shape and age, both from the cached
                    # player map, so they cost no extra calls
                    pos = defaultdict(int)
                    start = defaultdict(int)
                    elite = defaultdict(int)
                    fran = defaultdict(int)
                    exp_sum = exp_n = 0
                    for p in players:
                        m = pmeta.get(p) or {}
                        if m.get("pos"):
                            pos[m["pos"]] += 1
                        if m.get("exp") is not None:
                            exp_sum += m["exp"]
                            exp_n += 1
                        # THIS season: starter-grade, and elite within that
                        t = tier_idx.get((season, p))
                        if t:
                            tp, w = t
                            if w >= FRANCHISE_BAR[tp]:
                                start[tp] += 1
                                if w >= ELITE_BAR[tp]:
                                    elite[tp] += 1
                        # CAREER: three qualifying seasons, as of this season
                        fs = franchise_from.get(p)
                        if fs is not None and fs <= season and m.get("pos"):
                            fran[m["pos"]] += 1
                    slots = slot_wars(players, tier_idx, season)
                    out.append([rid, st.get("wins", 0), st.get("losses", 0),
                                round(float(st.get("fpts", 0) or 0)),
                                h.get(1, 0), h.get(2, 0), h.get(3, 0), h.get(4, 0),
                                0 if sold1.get(rid) else 1, own, len(players),
                                place.get(rid, 0),
                                pos["QB"], pos["RB"], pos["WR"], pos["TE"],
                                exp_sum, exp_n,
                                start["QB"], start["RB"], start["WR"], start["TE"],
                                elite["QB"], elite["RB"], elite["WR"], elite["TE"],
                                fran["QB"], fran["RB"], fran["WR"], fran["TE"],
                                *slots])
                rows[f"{node}|{season}"] = {
                    "lid": node, "chain": founding, "season": season,
                    "teams": lg.get("total_rosters"),
                    "playoff_teams": n_playoff,
                    "sf": is_superflex(lg), "champ": cw, "runner": cl,
                    "rosters": out,
                }
            progress[lid] = time.time()
            n_done += 1
            if n_done % CHECKPOINT_EVERY == 0:
                flush()
        except RuntimeError as e:
            # see mode_signals: flush + exit 0, or the CI cache save is lost
            rate_limited = e
            break
        except Exception as e:
            print(f"  skip {lid}: {e}", file=sys.stderr, flush=True)
        if time.time() - last_log >= args.log_every:
            hb(); last_log = time.time()
    flush()
    if rate_limited:
        print(f"[outcomes] stopped early: {rate_limited}", file=sys.stderr, flush=True)
    hb("done")
    print(f"[outcomes] shard {args.shard}: {n_done} leagues, {len(rows)} league-seasons",
          file=sys.stderr, flush=True)


# roster row layout, so a consumer never indexes by magic number
ROW_FIELDS = ["rid", "wins", "losses", "fpts",
              "held_r1", "held_r2", "held_r3", "held_r4",
              "kept_own_1st", "homegrown_n", "roster_n", "place",
              "qb", "rb", "wr", "te", "exp_sum", "exp_n",
              # THAT season: cleared the starter bar / the elite bar within it
              "start_qb", "start_rb", "start_wr", "start_te",
              "elite_qb", "elite_rb", "elite_wr", "elite_te",
              # CAREER: already had 3 qualifying seasons by then
              "fran_qb", "fran_rb", "fran_wr", "fran_te"] + SLOT_FIELDS
ELITE_CAP = 3            # 3 means "3 or more" — deeper buckets are too thin
F = {name: i for i, name in enumerate(ROW_FIELDS)}
TURN_HORIZON = 5          # seasons to look ahead from a bottom-third finish
LEAGUE_YEAR_CAP = 8       # year 8+ pooled: chains that deep are a handful


def summarize_outcomes(rows, shard, nshards):
    """The benchmark answers, small enough to commit.

    EVERYTHING here is a count or a sum, never a rate. The four shards are
    merged by adding their counters, and a mean of means is not a mean — so a
    consumer divides at the end. `<x>_sum` over `<x>_n` is the pattern.

    Grouping by league is shard-safe: shard_of() keys on league_id, so every
    season of a league lands in the same shard and no cross-season sequence is
    ever split across two files.
    """
    agg = defaultdict(int)
    # Keyed on the FRANCHISE chain, never `lid` — one league_id is one season.
    by_league = defaultdict(dict)          # chain -> {season: {rid: row}}
    champ_of_season, playoff_teams = {}, {}
    for row in rows:
        rs = row.get("rosters") or []
        champ = row.get("champ")
        # Rows written before a column was added are the wrong width, and
        # indexing one by F[...] reads a neighbouring field or raises. The
        # crawler's state and the CI cache both outlive a schema change, so
        # drop stale rows rather than trusting their shape; the league is
        # re-crawled on its next cooldown and comes back at full width.
        rs = [r for r in rs if len(r) == len(ROW_FIELDS)]
        if not rs:
            continue
        chain = row.get("chain") or row.get("lid")
        by_league[chain][row.get("season")] = {r[F["rid"]]: r for r in rs}
        champ_of_season[(chain, row.get("season"))] = champ
        playoff_teams[(chain, row.get("season"))] = row.get("playoff_teams")
        if champ is None:
            continue
        agg["league_seasons"] += 1
        c = {r[F["rid"]]: r for r in rs}.get(champ)
        if not c:
            continue
        agg["champs"] += 1
        # THE FIELD IS THE REST OF THE PLAYOFF BRACKET — not the league, and not
        # the league including the champion. It used to be `rs`, every roster,
        # champion included, which answered "how does a title team compare to a
        # random team" when the question being asked is "what beat the teams it
        # actually had to beat". Including the champion in its own comparison
        # also damps every edge toward zero, and the damping is worst in the
        # small-slot figures where one roster is a meaningful share of the mean.
        # `place` orders playoff teams first (see placements_of), so a roster
        # made the bracket iff place <= playoff_teams — `place` alone cannot say
        # it, since 6th is in a 6-team field and out of a 4.
        n_pt = playoff_teams.get((chain, row.get("season"))) or 0
        # An empty field (no bracket recorded) contributes nothing to the field
        # counters, but must NOT skip the champion or the position-stacking
        # denominators below — those are league-wide questions.
        field = [r for r in rs
                 if r[F["rid"]] != champ and n_pt and r[F["place"]] <= n_pt]
        agg["champ_kept_own_1st"] += c[F["kept_own_1st"]]
        agg["champ_r1_held"] += c[F["held_r1"]]
        agg["field_r1_held"] += sum(r[F["held_r1"]] for r in field)
        agg["field_rosters"] += len(field)
        picks = sum(c[F["held_r1"]:F["held_r4"] + 1])
        agg["champ_net_picks"] += picks - 4
        agg["champ_bought"] += 1 if picks > 4 else 0
        agg["champ_sold"] += 1 if picks < 4 else 0
        # --- does stacking a position win? -----------------------------------
        # P(champion | k elite players at a position) needs both halves of the
        # fraction, so every roster contributes to a denominator and only the
        # champion to a numerator. Bucketed at ELITE_CAP because "4 elite RBs"
        # is a handful of rosters league-wide.
        for r in rs:
            for tier in ("start", "elite", "fran"):
                for p in ("qb", "rb", "wr", "te"):
                    k = min(r[F[f"{tier}_{p}"]], ELITE_CAP)
                    agg[f"{p}_{tier}{k}_rosters"] += 1
                    if r[F["rid"]] == champ:
                        agg[f"{p}_{tier}{k}_champs"] += 1
        # --- what a title lineup was worth, slot by slot ----------------------
        # Sums and counts so shards add; the consumer divides. Champion and
        # field share the denominator convention so the two are comparable.
        for tag, group in (("champ", [c]), ("field", field)):
            for r in group:
                for i, key in enumerate(SLOT_FIELDS):
                    agg[f"{tag}_{key}_sum"] += round(r[F[key]] * 1000)
                agg[f"{tag}_slot_n"] += 1
        # --- roster construction: champion vs the field it beat ---------------
        for tag, group in (("champ", [c]), ("field", field)):
            for r in group:
                agg[f"{tag}_roster_sum"] += r[F["roster_n"]]
                agg[f"{tag}_roster_n"] += 1
                agg[f"{tag}_homegrown_sum"] += r[F["homegrown_n"]]
                for p in ("qb", "rb", "wr", "te"):
                    agg[f"{tag}_{p}_sum"] += r[F[p]]
                agg[f"{tag}_exp_sum"] += r[F["exp_sum"]]
                agg[f"{tag}_exp_n"] += r[F["exp_n"]]
    # --- league year, playoff persistence, and how rosters are built ---------
    # `chain` groups a franchise's seasons, so year 1 is the founding season.
    # Dynasty rosters start fully drafted (a startup draft) and are traded away
    # from that over time, so the drafted share is only meaningful against the
    # league's OWN age, not the calendar.
    for chain, seasons in by_league.items():
        yrs = sorted(seasons)
        for i, y in enumerate(yrs):
            year = min(i + 1, LEAGUE_YEAR_CAP)
            champ = champ_of_season.get((chain, y))
            pt = playoff_teams.get((chain, y)) or 0
            # Same "field" as the slot and construction blocks above: the rest
            # of the bracket. The Insights table puts these two columns side by
            # side as champion-vs-field, so they have to mean the same thing in
            # both. A season with no bracket contributes neither column.
            for rid, r in seasons[y].items():
                if rid == champ:
                    tag = "champ"
                elif pt and r[F["place"]] <= pt:
                    tag = "field"
                else:
                    continue
                agg[f"y{year}_{tag}_homegrown_sum"] += r[F["homegrown_n"]]
                agg[f"y{year}_{tag}_roster_sum"] += r[F["roster_n"]]
                agg[f"y{year}_{tag}_n"] += 1
            agg[f"y{year}_league_seasons"] += 1
            # playoff persistence needs the NEXT season to exist
            if i + 1 >= len(yrs) or not pt:
                continue
            nxt_pt = playoff_teams.get((chain, yrs[i + 1])) or 0
            if not nxt_pt:
                continue
            for rid, r in seasons[y].items():
                nxt = seasons[yrs[i + 1]].get(rid)
                if not nxt or not r[F["place"]] or not nxt[F["place"]]:
                    continue
                was = r[F["place"]] <= pt
                now = nxt[F["place"]] <= nxt_pt
                agg["made_playoffs" if was else "missed_playoffs"] += 1
                if was and now:
                    agg["playoff_stayed"] += 1
                elif not was and now:
                    agg["missed_then_made"] += 1
                    # how the climbers were built, vs those who stayed out
                    agg["climber_homegrown_sum"] += nxt[F["homegrown_n"]]
                    agg["climber_roster_sum"] += nxt[F["roster_n"]]
                    agg["climber_n"] += 1
                elif not was and not now:
                    agg["stuck_homegrown_sum"] += nxt[F["homegrown_n"]]
                    agg["stuck_roster_sum"] += nxt[F["roster_n"]]
                    agg["stuck_n"] += 1

    # --- turnaround: how long from the bottom third to the top ---------------
    # For every roster-season finishing in the bottom third, look forward up to
    # TURN_HORIZON seasons and record when it first reached a title / the top
    # third. A run that never gets there inside the horizon is censored, not
    # zero — counted separately so a consumer can report "x% within n years"
    # instead of silently averaging away the failures.
    for lid, seasons in by_league.items():
        yrs = sorted(seasons)
        n_teams = max((len(seasons[y]) for y in yrs), default=0)
        # Thirds are meaningless below four teams, so the bottom-third analysis
        # is skipped there — but place movement is not, and used to be skipped
        # with it because both sat under the same guard.
        bottom, top = ((n_teams - n_teams // 3, n_teams // 3) if n_teams >= 4
                       else (n_teams + 1, 0))
        for i, y in enumerate(yrs):
            # How many future seasons this finish actually HAS. Without this the
            # denominator is a lie: in a 34-chain sample, 136 of 348 bottom
            # finishes were the newest season of their league and could not
            # recover even in principle, and only 4 had a full five years ahead.
            # Counting those as failures reported 6% when the answer was
            # unknown. Everything below is keyed by room so a consumer divides
            # like-for-like: rate at k years = to_title_within_<k> / room_<k>.
            room = min(TURN_HORIZON, len(yrs) - 1 - i)
            for rid, r in seasons[y].items():
                pl = r[F["place"]]
                if not pl or pl <= bottom:
                    continue
                agg["bottom_finishes"] += 1
                if not room:
                    agg["bottom_no_room"] += 1
                    continue
                won = topped = 0
                for k in range(1, room + 1):
                    nxt = seasons[yrs[i + k]].get(rid)
                    if not nxt or not nxt[F["place"]]:
                        continue
                    if not topped and nxt[F["place"]] <= top:
                        topped = k
                    if not won and nxt[F["place"]] == 1:
                        won = k
                    if won:
                        break
                for k in range(1, room + 1):
                    agg[f"room_{k}"] += 1
                    if won and won <= k:
                        agg[f"to_title_within_{k}"] += 1
                    if topped and topped <= k:
                        agg[f"to_top_within_{k}"] += 1
                if won:
                    agg["bottom_to_title"] += 1
                    agg["bottom_to_title_years"] += won
                    if won == 1:
                        agg["last_to_first"] += 1
                else:
                    agg["bottom_to_title_censored"] += 1
                if topped:
                    agg["bottom_to_top"] += 1
                    agg["bottom_to_top_years"] += topped
                else:
                    agg["bottom_to_top_censored"] += 1
        # one-year place movement, for the distribution of ordinary swings
        for i in range(len(yrs) - 1):
            a, b = seasons[yrs[i]], seasons[yrs[i + 1]]
            for rid, r in a.items():
                nxt = b.get(rid)
                if not nxt or not r[F["place"]] or not nxt[F["place"]]:
                    continue
                agg["move_n"] += 1
                agg["move_abs_sum"] += abs(r[F["place"]] - nxt[F["place"]])
                agg["move_up_sum"] += max(0, r[F["place"]] - nxt[F["place"]])
    return {
        "generated": datetime.date.today().isoformat(),
        "shard": shard, "nshards": nshards,
        "horizon": TURN_HORIZON,
        "counts": dict(agg),
        "row_fields": ROW_FIELDS,
        "note": "counts and sums only — merge shards by adding, divide last",
    }


def main():
    ap = argparse.ArgumentParser(description="stateful sharded dynasty crawler")
    ap.add_argument("--mode", choices=["signals", "trades", "drafts", "outcomes"],
                    required=True)
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
    ap.add_argument("--commit-every", type=int, default=0,
                    help="signals/drafts: git commit+push outputs every N counted "
                         "leagues (0 = only at end)")
    ap.add_argument("--log-every", type=float, default=10.0)
    ap.add_argument("--signals-out", default="data/league_signals.json")
    ap.add_argument("--leagues-out", default="data/crawl_leagues.json")
    ap.add_argument("--trades-out", default="data/trade_corpus.json")
    ap.add_argument("--drafts-out", default="data/draft_signals.json")
    ap.add_argument("--draft-index-out", default="data/draft_index.json",
                    help="drafts: draft_id -> [league_id, season, kind]")
    # raw rows are artifact-only (large); the signals file is the committed one
    ap.add_argument("--outcomes-out", default="data/outcome_corpus.json")
    ap.add_argument("--outcome-signals-out", default="data/outcome_signals.json")
    # separate flag so a bounded trial run can write somewhere harmless instead
    # of overwriting the committed corpus with a partial sample
    ap.add_argument("--rookie-out", default="data/rookie_pick_corpus.json")
    args = ap.parse_args()
    state = get("/state/nfl") or {}
    args.season = args.season or state.get("season")
    args.season_type = state.get("season_type")     # only "regular" feeds start%
    args.week = (state.get("week") if args.season_type == "regular" else 0) or 0
    if not args.season:
        sys.exit("could not resolve season; pass --season")
    t0 = time.time()
    {"signals": mode_signals, "trades": mode_trades, "drafts": mode_drafts,
     "outcomes": mode_outcomes}[args.mode](args, t0)


if __name__ == "__main__":
    main()
