#!/usr/bin/env python3
"""One Sleeper HTTP client, shared by every script that calls the API.

There were four copies of this loop and they had drifted apart — different
delays, different retry sets, one with no User-Agent and no 429 handling at all
(a 404 or a rate limit there was retried four times and then raised, because
HTTPError subclasses URLError). The differences that MATTER are parameters, not
forks, so they are parameters here:

  delay    seconds slept before each request. The crawler runs at 0.12 because
           it makes six figures of calls a day and paces itself; everything else
           runs at 0.15. Both sit well under Sleeper's ~1000/min limit.
  retry    which exceptions are worth another attempt. BROAD is the historical
           default. NARROW is the crawler's deliberate choice — see its call
           site — and exists so an unexpected bug in the crawl surfaces as a
           skipped league rather than as three silent retries.

Semantics every caller now shares, matching what sleeper_pull.py did:
  * 404 or a literal "null" body -> None. This is Sleeper's "no such thing",
    not an error, and it is the ONLY way None comes back.
  * 429 -> sleep RATE_LIMIT_SLEEP and try again, up to `rate_tries`, then raise
    RuntimeError. Never a silent None: a None here becomes a silently
    incomplete dump that the build and commit steps would happily publish.
  * Any other failure -> exponential backoff, `retries` attempts, then raise.

Standard library only, like the four originals.
"""
import json
import time
import urllib.error
import urllib.request

BASE = "https://api.sleeper.app/v1"
DELAY = 0.15               # default pacing; keeps well under Sleeper's ~1000/min
RETRIES = 3
RATE_LIMIT_TRIES = 10      # 429s get their own budget, separate from error retries
RATE_LIMIT_SLEEP = 30
# Say who we are. urllib's default agent is anonymous and looks exactly like a
# scraper, which is the wrong thing to look like against a free read-only API.
UA = {"User-Agent": "big-dog-dynasty-warboard/2.0 (github.com/Mawxy/big-dog-dynasty)"}

# Retry policies. BROAD retries anything; NARROW retries only transport-shaped
# failures. JSONDecodeError belongs in NARROW because a connection cut mid-body
# reads as a valid HTTP response with unparseable JSON — a transport blip, not a
# reason to give up on the resource.
BROAD = Exception
NARROW = (urllib.error.URLError, TimeoutError, json.JSONDecodeError)


def get(path, delay=DELAY, retry=BROAD, retries=RETRIES,
        rate_tries=RATE_LIMIT_TRIES, timeout=30, on_request=None):
    """GET a Sleeper endpoint, return parsed JSON (None ONLY on 404/null).

    `path` may be an absolute URL (the stats, schedule and projections feeds all
    live off the /v1 base) or a /v1-relative path. `on_request` fires once per
    ATTEMPT, for callers that meter their own call rate.
    """
    url = path if path.startswith("http") else BASE + path
    attempt = rate_hits = 0
    while True:
        try:
            time.sleep(delay)
            if on_request is not None:
                on_request()
            with urllib.request.urlopen(
                    urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                body = r.read().decode("utf-8")
            return json.loads(body) if body and body != "null" else None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:            # rate limited: back off hard
                rate_hits += 1
                if rate_hits >= rate_tries:
                    raise RuntimeError(f"rate-limited {rate_hits}x, giving up: {url}")
                time.sleep(RATE_LIMIT_SLEEP)
                continue
            attempt += 1
            if attempt >= retries:
                raise
            time.sleep(2 ** attempt)
        except retry:
            attempt += 1
            if attempt >= retries:
                raise
            time.sleep(2 ** attempt)
