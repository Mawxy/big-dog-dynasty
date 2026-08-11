#!/usr/bin/env python3
"""fetch_ecr.py's pure logic, on synthetic payloads. No network.

Everything here is testable without FantasyPros: the page is scraped by finding
one `ecrData` assignment and balancing brackets over it, and the hard part after
that is deciding which of two identically-named ranked players is the one this
league's sleeper id refers to. That decision is silent when it goes wrong — the
wrong twin's rank lands on the right player's id and nothing anywhere says so —
which is why it is pinned here rather than left to a console line nobody reads.

  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_ecr                                                 # noqa: E402


def page(payload, prefix="var ecrData = ", suffix=";</script>"):
    """A FantasyPros-shaped page with the payload embedded the way theirs is."""
    return f"<html><script>{prefix}{json.dumps(payload)}{suffix}</html>"


def row(name, pos, team, rank, **kw):
    r = {"player_name": name, "player_position_id": pos, "player_team_id": team,
         "rank_ecr": rank, "pos_rank": f"{pos}{rank}", "rank_min": rank,
         "rank_max": rank, "rank_ave": float(rank), "rank_std": 0.0,
         "tier": 1, "player_ecr_delta": 0}
    r.update(kw)
    return r


class TestBalanced(unittest.TestCase):
    """The capture has to be depth- and string-aware. A regex to the next `}`
    ends the payload at the first brace inside a player's name."""

    def cut(self, src, start=0):
        return fetch_ecr.balanced(src, start)

    def test_flat_object(self):
        self.assertEqual(self.cut('{"a":1}'), '{"a":1}')

    def test_nested_objects_and_arrays(self):
        s = '{"a":{"b":[1,{"c":2}]},"d":3}'
        self.assertEqual(self.cut(s), s)

    def test_trailing_content_is_not_captured(self):
        self.assertEqual(self.cut('{"a":1}; var other = 9;'), '{"a":1}')

    def test_brace_inside_a_string_does_not_close_the_capture(self):
        s = '{"name":"Odd }} Name","rank":1}'
        self.assertEqual(self.cut(s), s)
        self.assertEqual(json.loads(self.cut(s))["rank"], 1)

    def test_escaped_quote_does_not_end_the_string(self):
        s = '{"name":"He said \\"hi\\" }","rank":2}'
        self.assertEqual(self.cut(s), s)
        self.assertEqual(json.loads(self.cut(s))["rank"], 2)

    def test_array_payload(self):
        s = '[{"a":1},{"b":[2,3]}]'
        self.assertEqual(self.cut(s), s)

    def test_starts_at_the_given_offset(self):
        s = 'ecrData = {"a":1};'
        self.assertEqual(self.cut(s, s.index("{")), '{"a":1}')

    def test_unbalanced_returns_none(self):
        self.assertIsNone(self.cut('{"a":1'))


class TestPayload(unittest.TestCase):

    def test_extracts_the_assignment(self):
        got = fetch_ecr.payload(page({"scoring": "PPR", "players": []}))
        self.assertEqual(got["scoring"], "PPR")

    def test_missing_marker_returns_none(self):
        self.assertIsNone(fetch_ecr.payload("<html>nothing here</html>"))

    def test_unparseable_payload_returns_none(self):
        self.assertIsNone(fetch_ecr.payload("var ecrData = {broken;"))

    def test_survives_a_brace_in_a_player_name(self):
        data = {"scoring": "PPR", "players": [row("Odd } Name", "WR", "LAC", 1)]}
        got = fetch_ecr.payload(page(data))
        self.assertEqual(len(got["players"]), 1)
        self.assertEqual(got["players"][0]["player_name"], "Odd } Name")


class TestFit(unittest.TestCase):
    """2 = both teams known and equal, 1 = at least one unknown, 0 = known and
    different. FA scoring 1 rather than 0 is the load-bearing part: FantasyPros
    leaves departed players parked at FA, so reading FA as "not him" hands the
    id to the wrong twin exactly when the real player is the one with the stale
    row."""

    def test_agreement_scores_two(self):
        self.assertEqual(fetch_ecr.fit("LAC", "LAC"), 2)
        self.assertEqual(fetch_ecr.fit("lac", "LAC"), 2)     # case-insensitive

    def test_conflict_scores_zero(self):
        self.assertEqual(fetch_ecr.fit("NYJ", "LAC"), 0)

    def test_unknown_on_either_side_scores_one(self):
        self.assertEqual(fetch_ecr.fit("", "LAC"), 1)
        self.assertEqual(fetch_ecr.fit("LAC", ""), 1)
        self.assertEqual(fetch_ecr.fit(None, "LAC"), 1)
        self.assertEqual(fetch_ecr.fit("LAC", None), 1)

    def test_free_agent_is_absence_of_evidence_not_evidence(self):
        self.assertEqual(fetch_ecr.fit("FA", "LAC"), 1)
        self.assertEqual(fetch_ecr.fit("LAC", "FA"), 1)
        # ...and never beats a real agreement
        self.assertGreater(fetch_ecr.fit("LAC", "LAC"), fetch_ecr.fit("FA", "LAC"))


# players_min.json shape: pid -> [name, pos, nfl team]
PLAYERS = {
    "100": ["Mike Williams", "WR", "LAC"],
    "200": ["Josh Allen", "QB", "BUF"],
    "300": ["Chris Godwin", "WR", ""],       # team unknown to us: unresolvable
}
SLUG = "ppr-superflex"


class TestTwinResolution(unittest.TestCase):
    """Two RANKED FantasyPros players can normalize onto one sleeper id. Only
    one of them is ours, and team is the only field that separates them."""

    def run_main(self, rows, scoring="PPR"):
        """Drive main() end to end with the network stubbed out."""
        data = {"scoring": scoring, "year": 2026, "week": 0, "type": "Draft PPR",
                "total_experts": 10, "last_updated": "2026-08-11", "players": rows}
        tmp = Path(tempfile.mkdtemp())
        pfile, ofile = tmp / "players_min.json", tmp / "ecr.json"
        pfile.write_text(json.dumps(PLAYERS), encoding="utf-8")

        real_get, real_argv = fetch_ecr.get, sys.argv
        fetch_ecr.get = lambda url: (page(data), url)     # no redirect
        sys.argv = ["fetch_ecr.py", "--formats", SLUG,
                    "--players", str(pfile), "--out", str(ofile)]
        try:
            fetch_ecr.main()
        finally:
            fetch_ecr.get, sys.argv = real_get, real_argv
        return json.loads(ofile.read_text(encoding="utf-8"))

    def ecr_of(self, out, pid):
        return (out["players"].get(pid) or {}).get(SLUG, {}).get("ecr")

    def assert_matched_invariant(self, out):
        """validate_data.check_ecr's rule: the format's `matched` must equal the
        number of players actually carrying the slug. The eviction path adjusts
        the counter by hand, so this is where that arithmetic gets checked."""
        carriers = sum(1 for rec in out["players"].values() if SLUG in rec)
        self.assertEqual(carriers, out["formats"][SLUG]["matched"])

    def test_team_agreement_beats_rank_when_the_wrong_twin_is_first(self):
        """The higher-ranked row is the OTHER Mike Williams. Ours ranks worse
        and must still win, because his team agrees and the other's conflicts."""
        out = self.run_main([row("Mike Williams", "WR", "NYJ", 10),
                             row("Mike Williams", "WR", "LAC", 40)])
        self.assertEqual(self.ecr_of(out, "100"), 40)
        self.assert_matched_invariant(out)

    def test_team_agreement_holds_when_the_right_twin_is_first(self):
        """Same decision, opposite order: the already-claimed row is the better
        one, so the challenger is dropped rather than allowed to overwrite."""
        out = self.run_main([row("Mike Williams", "WR", "LAC", 10),
                             row("Mike Williams", "WR", "NYJ", 40)])
        self.assertEqual(self.ecr_of(out, "100"), 10)
        self.assert_matched_invariant(out)

    def test_true_ambiguity_keeps_the_higher_ranked(self):
        """Nothing separates them — we don't know our own player's team — so the
        tie breaks to consensus rank, and only one record is written."""
        out = self.run_main([row("Chris Godwin", "WR", "TB", 15),
                             row("Chris Godwin", "WR", "CAR", 60)])
        self.assertEqual(self.ecr_of(out, "300"), 15)
        self.assert_matched_invariant(out)

    def test_a_stale_fa_row_does_not_lose_to_a_conflicting_one(self):
        """FantasyPros parks departed players at FA. Our man is the FA row; the
        other twin's team actively disagrees with ours, so FA (1) beats it (0)."""
        out = self.run_main([row("Mike Williams", "WR", "NYJ", 10),
                             row("Mike Williams", "WR", "FA", 40)])
        self.assertEqual(self.ecr_of(out, "100"), 40)
        self.assert_matched_invariant(out)

    def test_suffixed_and_unmatched_rows(self):
        """A ranked player this league has never rostered is simply unmatched —
        not an error, and it must not disturb anyone else's record."""
        out = self.run_main([row("Josh Allen", "QB", "BUF", 1),
                             row("Nobody Here", "TE", "SEA", 2)])
        self.assertEqual(self.ecr_of(out, "200"), 1)
        self.assertEqual(out["formats"][SLUG]["ranked"], 2)
        self.assert_matched_invariant(out)

    def test_full_record_is_carried_through(self):
        out = self.run_main([row("Josh Allen", "QB", "BUF", 3, rank_min=1,
                                 rank_max=9, rank_ave=3.4, rank_std=1.2, tier=2)])
        rec = out["players"]["200"][SLUG]
        self.assertEqual((rec["ecr"], rec["best"], rec["worst"], rec["tier"]),
                         (3, 1, 9, 2))
        self.assertEqual(rec["posRank"], "QB3")


if __name__ == "__main__":
    unittest.main()
