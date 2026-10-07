import { Fragment, type ReactNode } from "react";

/**
 * THE RECAP'S MARKDOWN, AND ONLY THAT MUCH OF IT (2026-10-07).
 *
 * recaps.json carries each weekly article as markdown (scripts/add_recap.py).
 * No markdown library ships with this site and one article a week does not
 * earn one, so this renders the subset the recap is written in and nothing
 * else: `##` / `###` headings, paragraphs, `-` bullets, pipe tables, `**bold**`
 * and `*italic*`. It builds React elements, never an HTML string, so nothing in
 * an article can inject markup.
 *
 * Table cells that are figures (a score, a record, a percentage, a signed
 * change) right-align and go tabular, the table rule the rest of the board
 * follows; everything else left-aligns.
 */

/** `**bold**` and `*italic*`, in that order of precedence */
export function inline(s: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0, n = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[1] != null
      ? <strong key={`${key}-${n++}`}>{inline(m[1], `${key}-${n}`)}</strong>
      : <em key={`${key}-${n++}`}>{m[2]}</em>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const FIGURE = /^[\s*]*[+\-−]?[\d.,]+(%|-\d+)?[\s*]*$/;
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
const isRule = (row: string) => /^\|?\s*:?-{2,}/.test(row.trim());

export function RecapBody({ md }: { md: string }) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const t = ln.trim();
    if (!t) { i++; continue; }
    if (t.startsWith("### ")) { blocks.push(<h4 key={k++}>{inline(t.slice(4))}</h4>); i++; continue; }
    if (t.startsWith("## ")) { blocks.push(<h3 key={k++}>{inline(t.slice(3))}</h3>); i++; continue; }
    if (t.startsWith("|")) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      const head = cells(rows[0]);
      const body = rows.slice(1).filter(r => !isRule(r)).map(cells);
      // a column is a figure column when every body cell in it is a figure
      const fig = head.map((_, c) => body.length > 0 && body.every(r => FIGURE.test(r[c] ?? "")));
      blocks.push(
        <div className="rcp-tblwrap" key={k++}>
          <table className="rcp-tbl">
            <thead><tr>{head.map((h, c) => <th key={c} className={fig[c] ? "r" : "t"}>{inline(h)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => (
              <tr key={ri}>{head.map((_, c) => <td key={c} className={fig[c] ? "r" : "t"}>{inline(r[c] ?? "", `${ri}-${c}`)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>);
      continue;
    }
    if (/^[-*]\s+/.test(t) && !/^\*[^*\s]/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].trim().replace(/^[-*]\s+/, ""));
      blocks.push(<ul key={k++}>{items.map((it, n) => <li key={n}>{inline(it, `${k}-${n}`)}</li>)}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{2,3} |\||[-*]\s)/.test(lines[i].trim())) para.push(lines[i++].trim());
    if (!para.length) { para.push(t); i++; }
    blocks.push(<p key={k++}>{inline(para.join(" "), `p${k}`)}</p>);
  }
  return <Fragment>{blocks}</Fragment>;
}
