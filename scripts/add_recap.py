#!/usr/bin/env python3
"""
Publish a weekly recap article to the League page.

    python scripts/add_recap.py recaps/2026-w04.md

The markdown file is the source of truth and lives under recaps/ in the repo.
Its first line is the title, `# Week <W> Recap: <headline>`, and its second
non-blank line is the italic subtitle `*Big Dog Dynasty · <season> Week <W>*`.
Everything after that is the article body.

This packs it into data/leagues/<key>/recaps.json, newest first, one entry per
(season, week). Re-running for the same week replaces that week's entry, so a
corrected article is just an edit and a re-run.

Entry: {id, season, week, headline, dek, body, published}
  dek   the first paragraph of the body: the line under the headline on the
        League page before the article is opened
  body  the markdown after the title and subtitle, rendered by
        src/lib/recapMd.tsx (headings, paragraphs, bullets, tables, bold,
        italic; nothing else)
"""
import argparse, datetime as dt, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_KEY = "814608002207334400"   # Big Dog Dynasty's founding league_id

TITLE = re.compile(r"^#\s+Week\s+(\d+)\s+Recap:\s*(.+?)\s*$")
SUB = re.compile(r"^\*.*?(\d{4})\s+Week\s+(\d+)\s*\*$")


def parse(md: str):
    lines = md.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    m = TITLE.match(lines[i]) if i < len(lines) else None
    if not m:
        sys.exit("first line must be '# Week <W> Recap: <headline>'")
    week, headline = int(m.group(1)), m.group(2)
    i += 1
    while i < len(lines) and not lines[i].strip():
        i += 1
    s = SUB.match(lines[i].strip()) if i < len(lines) else None
    if not s:
        sys.exit("second line must be '*Big Dog Dynasty · <season> Week <W>*'")
    season = int(s.group(1))
    if int(s.group(2)) != week:
        sys.exit(f"title says week {week}, subtitle says week {s.group(2)}")
    body = "\n".join(lines[i + 1:]).strip() + "\n"
    dek = ""
    for para in re.split(r"\n\s*\n", body):
        p = para.strip()
        if p and not p.startswith(("#", "|", "-", "*Big")):
            dek = " ".join(p.split())
            break
    return {"id": f"{season}-w{week:02d}", "season": season, "week": week,
            "headline": headline, "dek": dek, "body": body}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("md", help="the recap markdown file")
    ap.add_argument("--league", default=DEFAULT_KEY, help="founding league_id")
    a = ap.parse_args()
    ent = parse(Path(a.md).read_text(encoding="utf-8"))
    ent["published"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    out = ROOT / "data" / "leagues" / a.league / "recaps.json"
    cur = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {"recaps": []}
    keep = [r for r in cur["recaps"] if r["id"] != ent["id"]]
    keep.append(ent)
    keep.sort(key=lambda r: (r["season"], r["week"]), reverse=True)
    out.write_text(json.dumps({"recaps": keep}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{ent['id']}: {ent['headline']} -> {out.relative_to(ROOT)} ({len(keep)} recaps)")


if __name__ == "__main__":
    main()
