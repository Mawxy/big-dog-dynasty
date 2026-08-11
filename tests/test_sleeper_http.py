#!/usr/bin/env python3
"""The shared Sleeper client's contract. No network — urlopen is stubbed.

sleeper_pull, sleeper_crawl, pull_rookie_drafts and fetch_projections all call
this one function now, and its semantics are load-bearing in a way that never
shows up locally: the only machines that exercise a 429 or a mid-body cut are
CI and Max's daily run. The rules being pinned here are the ones the four
divergent copies disagreed about.

  * 404 / a literal "null" body is Sleeper saying "no such thing" -> None, and
    that is the ONLY way None comes back. Anything else that fails, raises.
  * a 429 budget that RAISES when exhausted. A silent None there becomes a
    silently incomplete dump, which the build and commit steps would publish.
  * BROAD vs NARROW retry: the crawler deliberately does not retry surprises.

  python -m unittest discover -s tests
"""
import json
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sleeper_http                                              # noqa: E402


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code):
    return urllib.error.HTTPError("http://x", code, "boom", {}, None)


class ClientTest(unittest.TestCase):
    """Each test hands `get` a script of outcomes, one per attempt."""

    def setUp(self):
        self.calls = []          # (url, headers) per attempt
        self.slept = []
        self._urlopen = sleeper_http.urllib.request.urlopen
        self._sleep = sleeper_http.time.sleep
        sleeper_http.time.sleep = self.slept.append

    def tearDown(self):
        sleeper_http.urllib.request.urlopen = self._urlopen
        sleeper_http.time.sleep = self._sleep

    def script(self, *outcomes):
        seq = list(outcomes)

        def fake(req, timeout=None):
            self.calls.append((req.full_url, dict(req.headers)))
            out = seq.pop(0) if seq else seq_exhausted()
            if isinstance(out, BaseException):
                raise out
            return FakeResponse(out)

        def seq_exhausted():
            raise AssertionError("more attempts than the test scripted")

        sleeper_http.urllib.request.urlopen = fake

    # --- the None contract ------------------------------------------------
    def test_parses_json_body(self):
        self.script('{"a": 1}')
        self.assertEqual(sleeper_http.get("/league/1"), {"a": 1})

    def test_404_is_none_and_is_not_retried(self):
        self.script(http_error(404))
        self.assertIsNone(sleeper_http.get("/league/nope"))
        self.assertEqual(len(self.calls), 1)

    def test_literal_null_body_is_none(self):
        self.script("null")
        self.assertIsNone(sleeper_http.get("/league/1"))

    def test_empty_body_is_none(self):
        self.script("")
        self.assertIsNone(sleeper_http.get("/league/1"))

    # --- rate limiting ----------------------------------------------------
    def test_429_backs_off_then_succeeds(self):
        self.script(http_error(429), http_error(429), '{"ok": true}')
        self.assertEqual(sleeper_http.get("/x"), {"ok": True})
        self.assertEqual(self.slept.count(sleeper_http.RATE_LIMIT_SLEEP), 2)

    def test_exhausted_429_budget_raises_rather_than_returning_none(self):
        """THE important one. A None here is an incomplete dump that looks
        complete, and the commit step would ship it."""
        self.script(*[http_error(429)] * sleeper_http.RATE_LIMIT_TRIES)
        with self.assertRaises(RuntimeError) as cm:
            sleeper_http.get("/x", rate_tries=3)
        self.assertIn("rate-limited", str(cm.exception))

    def test_429_budget_is_separate_from_the_error_budget(self):
        """Rate limits must not consume retries: a long throttle followed by a
        real error should still get its full error budget."""
        self.script(http_error(429), http_error(429), http_error(429),
                    '{"a": 1}')
        self.assertEqual(sleeper_http.get("/x", retries=2), {"a": 1})

    # --- retry policies ---------------------------------------------------
    def test_server_error_retries_then_raises(self):
        self.script(*[http_error(500)] * 3)
        with self.assertRaises(urllib.error.HTTPError):
            sleeper_http.get("/x", retries=3)
        self.assertEqual(len(self.calls), 3)

    def test_broad_policy_retries_an_unexpected_exception(self):
        self.script(ValueError("surprise"), '{"a": 1}')
        self.assertEqual(sleeper_http.get("/x", retry=sleeper_http.BROAD), {"a": 1})

    def test_narrow_policy_does_not_retry_an_unexpected_exception(self):
        """The crawler's choice: a surprise should surface as a skipped league,
        not as three silent retries of a bug."""
        self.script(ValueError("surprise"))
        with self.assertRaises(ValueError):
            sleeper_http.get("/x", retry=sleeper_http.NARROW)
        self.assertEqual(len(self.calls), 1)

    def test_narrow_policy_retries_a_mid_body_cut(self):
        """Valid HTTP, unparseable JSON — a transport blip, and the reason
        JSONDecodeError is in NARROW at all."""
        self.script("{ truncated", '{"a": 1}')
        self.assertEqual(sleeper_http.get("/x", retry=sleeper_http.NARROW), {"a": 1})

    def test_narrow_policy_retries_a_timeout(self):
        self.script(TimeoutError(), '{"a": 1}')
        self.assertEqual(sleeper_http.get("/x", retry=sleeper_http.NARROW), {"a": 1})

    # --- request shape ----------------------------------------------------
    def test_relative_path_gets_the_v1_base(self):
        self.script('{}')
        sleeper_http.get("/league/1")
        self.assertEqual(self.calls[0][0], sleeper_http.BASE + "/league/1")

    def test_absolute_url_is_used_as_given(self):
        """The stats, schedule and projections feeds all live off the /v1 base."""
        url = "https://api.sleeper.app/stats/nfl/2025/1"
        self.script('{}')
        sleeper_http.get(url)
        self.assertEqual(self.calls[0][0], url)

    def test_identifies_itself(self):
        """urllib's default agent is anonymous and looks exactly like a scraper.
        fetch_projections was sending it until this client replaced its copy."""
        self.script('{}')
        sleeper_http.get("/x")
        agent = {k.lower(): v for k, v in self.calls[0][1].items()}["user-agent"]
        self.assertIn("big-dog-dynasty", agent)

    def test_on_request_fires_once_per_attempt(self):
        """sleeper_crawl meters its own call rate off this hook, and a retried
        request really did hit Sleeper twice."""
        seen = []
        self.script(TimeoutError(), TimeoutError(), '{"a": 1}')
        sleeper_http.get("/x", retry=sleeper_http.NARROW,
                         on_request=lambda: seen.append(1))
        self.assertEqual(len(seen), 3)

    def test_pacing_delay_is_honoured(self):
        self.script('{}')
        sleeper_http.get("/x", delay=0.12)
        self.assertEqual(self.slept, [0.12])


class CallSitePolicyTest(unittest.TestCase):
    """The four callers were merged into one client; these are the differences
    that were deliberate and had to survive the merge."""

    def test_crawler_keeps_its_own_pacing_and_narrow_retry(self):
        import sleeper_crawl
        self.assertEqual(sleeper_crawl.DELAY, 0.12)
        seen = {}

        def fake(path, delay=None, retry=None, on_request=None, **kw):
            seen.update(path=path, delay=delay, retry=retry)
            on_request()
            return {"ok": 1}

        real, sleeper_crawl._calls = sleeper_crawl.sleeper_http.get, 0
        sleeper_crawl.sleeper_http.get = fake
        try:
            self.assertEqual(sleeper_crawl.get("/league/1"), {"ok": 1})
        finally:
            sleeper_crawl.sleeper_http.get = real
        self.assertEqual(seen["delay"], 0.12)
        self.assertIs(seen["retry"], sleeper_http.NARROW)
        self.assertEqual(sleeper_crawl._calls, 1)

    def test_one_shot_scripts_share_the_defaults(self):
        import sleeper_pull, pull_rookie_drafts, fetch_projections
        for mod in (sleeper_pull, pull_rookie_drafts, fetch_projections):
            self.assertIs(mod.get, sleeper_http.get, mod.__name__)
        self.assertEqual(sleeper_http.DELAY, 0.15)
        self.assertIs(sleeper_http.BROAD, Exception)


if __name__ == "__main__":
    unittest.main()
