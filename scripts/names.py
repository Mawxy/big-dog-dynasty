#!/usr/bin/env python3
"""Name-matching pieces shared across the joins.

NICK is the one table that is genuinely the same question everywhere: Sleeper
carries the name a player goes by, nflverse carries the one on the birth
certificate, and matching them needs the expansion. It lived in two scripts and
they had already drifted — project_war.py knew 'chig' and pick_value.py did not,
so the same player joined in one file and not the other.

The per-script MANUAL / ALIASES override tables are deliberately NOT here. Those
solve different joins (pick_value's is Sleeper->gsis, fetch_ecr's is
FantasyPros->Sleeper) and merging them would mean each script carrying
corrections for a source it never reads.

norm() is likewise not here, and not by accident. There are two normalizers with
two shapes — fetch_values strips every non-letter so "Marvin Harrison Jr."
becomes one token, while pick_value/project_war/sleeper_crawl keep the spaces
and strip the suffix as a trailing WORD. They must strip the SAME SUFFIX SET,
which tests/test_names.py pins, but they are not the same function.
"""

# short first name -> the legal one nflverse files him under
NICK = {'cam': 'cameron', 'tank': 'nathaniel', 'joe': 'joseph',
        'trevor': 'william', 'matt': 'matthew', 'josh': 'joshua',
        'ken': 'kenneth', 'mike': 'michael', 'gabe': 'gabriel',
        'chig': 'chigoziem'}
