#!/usr/bin/env python3
"""Atomic file writes, in one place.

Two scripts had already worked this out independently (build_site_data's
`atomic_write`, sleeper_crawl's `jdump`); eight others were still doing
`path.write_text(...)`, which TRUNCATES FIRST. A crash, a job timeout or a
cancelled workflow run mid-flush therefore leaves a half-written JSON file
sitting exactly where a committed one belongs — and the commit step, which
checks that files exist rather than that they parse, publishes it.

Writing to a temp file and calling os.replace makes the swap atomic. The temp
file has to live in the SAME directory as the target: os.replace is atomic
within a filesystem and not across one, and a same-directory temp guarantees the
former on Windows as well as POSIX.

Callers keep their own serialization — compact separators, trailing newline,
indentation — because those are per-file decisions the site depends on. This
module only guarantees that whatever they produce lands whole or not at all.
"""
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def _atomic(path, newline=""):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline=newline) as f:
            yield f
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def atomic_write(path, text, newline=""):
    """Write `text` to `path` atomically."""
    with _atomic(path, newline) as f:
        f.write(text)


def write_json(path, obj, **dump_kw):
    """Serialize `obj` straight into the temp file, atomically.

    json.dump rather than write(json.dumps(...)): the crawl corpora run to tens
    of megabytes and there is no reason to hold a second copy of one as a string.
    """
    with _atomic(path) as f:
        json.dump(obj, f, **dump_kw)
