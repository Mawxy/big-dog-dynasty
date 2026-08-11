#!/usr/bin/env python3
"""Name normalization parity across the joins.

There are two normalizer SHAPES in the pipeline and they are deliberately
different:

  * fetch_values.norm strips every non-letter first, so "Marvin Harrison Jr."
    becomes one token and the suffix is tested with endswith(). fetch_ecr.py
    imports this one, so it decides both KTC and FantasyPros matching.
  * pick_value.norm / project_war.norm / sleeper_crawl._last keep the word
    boundaries and strip the suffix as a trailing WORD via regex.

What they must agree on is the SUFFIX SET. They didn't: fetch_values stripped
(jr, sr, iii, ii, iv) while the other three also stripped `v`, so a player
carrying a V suffix was normalized one way by the market join and another way by
everything else, and silently never matched. These tests pin the set, not the
outputs — the two shapes legitimately return different strings.

  python -m unittest discover -s tests
"""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import fetch_values                                              # noqa: E402
import pick_value                                                # noqa: E402
import project_war                                               # noqa: E402
import sleeper_crawl                                             # noqa: E402
from names import NICK                                           # noqa: E402


# Names long enough that fetch_values' length guard is not in play, so the two
# shapes are directly comparable once the spaces are taken back out.
SUFFIXED = [
    ("Marvin Harrison Jr.", "marvinharrison"),
    ("Travis Etienne Jr.", "travisetienne"),
    ("Kenneth Walker III", "kennethwalker"),
    ("Michael Pittman Jr.", "michaelpittman"),
    ("Cedric Tillman II", "cedrictillman"),
    ("Robert Griffin IV", "robertgriffin"),
    # THE REGRESSION. Every normalizer but fetch_values stripped a V suffix, so
    # this name resolved to "robertgriffinv" on the market side of the join and
    # "robert griffin" on every other side.
    ("Robert Griffin V", "robertgriffin"),
    ("Deebo Samuel Sr.", "deebosamuel"),
]


def squashed(fn, name):
    """A word-boundary normalizer's answer, in the flat form fetch_values uses."""
    return fn(name).replace(" ", "")


class TestSuffixParity(unittest.TestCase):

    def test_fetch_values_strips_every_suffix(self):
        for name, want in SUFFIXED:
            self.assertEqual(fetch_values.norm(name), want, name)

    def test_all_normalizers_agree_on_the_suffix_set(self):
        """The four implementations must strip the same suffixes. Compared in
        flattened form because only the SHAPE differs, never the set."""
        for name, want in SUFFIXED:
            self.assertEqual(fetch_values.norm(name), want, f"fetch_values: {name}")
            self.assertEqual(squashed(pick_value.norm, name), want, f"pick_value: {name}")
            self.assertEqual(squashed(project_war.norm, name), want, f"project_war: {name}")

    def test_crawl_last_name_strips_the_same_suffixes(self):
        """sleeper_crawl._last returns the LAST word, which is the surname only
        when the suffix has been stripped — that is the whole point of it."""
        for name, want in SUFFIXED:
            self.assertTrue(want.endswith(sleeper_crawl._last(name)), name)
        self.assertEqual(sleeper_crawl._last("Robert Griffin V"), "griffin")
        self.assertEqual(sleeper_crawl._last("Kenneth Walker III"), "walker")

    def test_longer_numerals_win_over_the_shorter_ones_they_contain(self):
        """`iii` must not be read as `ii`, and `iv` must not be read as `v` —
        fetch_values tests suffixes in order and breaks on the first hit, so the
        ordering IS the correctness condition."""
        self.assertEqual(fetch_values.norm("Kenneth Walker III"), "kennethwalker")
        self.assertEqual(fetch_values.norm("Robert Griffin IV"), "robertgriffin")

    def test_short_names_are_not_mangled(self):
        """fetch_values has thrown the word boundaries away by the time it looks
        for a suffix, so it cannot tell one from a last syllable. The length
        guard is what keeps it from eating short real names, and it is the one
        place the flat shape deliberately does NOT match the regex shape."""
        for short in ("Bo Jr", "A.V.", "Ali V"):
            n = fetch_values.norm(short)
            self.assertEqual(n, re.sub(r"[^a-z]", "", short.lower()),
                             f"{short} was stripped despite the length guard")
        # ...and the guard really is length, not an accident of these inputs
        self.assertEqual(fetch_values.norm("Aliyah V"), "aliyah")


class TestNickTable(unittest.TestCase):
    """NICK is single-sourced in names.py. It used to be copied into both
    pick_value and project_war, and project_war's copy had grown an entry the
    other lacked — so the same player joined in one file and not the other."""

    def test_both_consumers_use_the_shared_table(self):
        self.assertIs(pick_value.NICK, NICK)
        self.assertIs(project_war.NICK, NICK)

    def test_table_holds_the_union_of_the_old_copies(self):
        for short, legal in {"cam": "cameron", "tank": "nathaniel",
                             "joe": "joseph", "trevor": "william",
                             "matt": "matthew", "josh": "joshua",
                             "ken": "kenneth", "mike": "michael",
                             "gabe": "gabriel",
                             # the entry project_war had and pick_value did not
                             "chig": "chigoziem"}.items():
            self.assertEqual(NICK.get(short), legal, short)

    def test_keys_are_normalized_first_names(self):
        """Lookups are keyed on norm()'s output, so an entry with a capital or a
        period in it could never be hit."""
        for short, legal in NICK.items():
            self.assertEqual(short, project_war.norm(short))
            self.assertEqual(legal, project_war.norm(legal))


if __name__ == "__main__":
    unittest.main()
