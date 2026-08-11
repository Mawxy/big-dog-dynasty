import type { ReactNode } from "react";
import { sgnWar, warInk } from "../lib/stats";
import { POS_COLOR } from "../lib/league";
import PosBadge from "./PosBadge";

/**
 * One "best / worst value" table — the titled half of a `.pick-tables` pair.
 *
 * The Draft tab and a single draft's page both rank picks by WAR over what the
 * slot was expected to return, and both drew the same seven-element cell by
 * hand: the condensed slot figure, the two-line `who` block (mini position
 * badge, name, drafting franchise), then Exp / WAR / Vs. They drifted only in
 * their column budget and their labels, never in the markup, so the markup
 * lives here once and the two surfaces keep their own headers.
 *
 * Every figure is `sgnWar` — the 3dp canonical WAR from lib/stats — which is
 * what both call sites already used, so no figure moves.
 *
 * The `.pick-tables` flex wrapper stays at the call site: it is what pairs the
 * two ends of the ranking, and the playoff panel puts a different pair inside
 * the same wrapper.
 */

/** what a value table reads off a pick, whatever built the row */
export interface PickRow {
  pid: string; name: string; pos: string;
  /** the franchise that made the selection */
  drafter: string;
  war: number; expected: number | null; diff: number | null;
}

/**
 * An identity column ahead of Player. The first is the pick's own label and
 * takes the condensed slot figure; any after it are muted sub-text.
 *
 * There is one on a single draft's page ("Pick") and two on the Draft tab
 * ("Slot" and "Yr"), because that table pools every rookie class and the year
 * is the only thing separating 1.01 from 1.01.
 */
export interface PickLead<R> { label: string; w: number; of: (r: R) => ReactNode }

export default function PickTable<R extends PickRow>({
  title, tone, rows, rowKey, lead, w, expLabel, vsLabel,
}: {
  title: string;
  /** which end of the ranking — inks the title --war-pos / --war-neg */
  tone: "best" | "worst";
  rows: readonly R[];
  rowKey: (r: R) => string;
  lead: readonly PickLead<R>[];
  /** percentage widths for the four shared columns (SKILL §3: every column
   *  declares one, on its header cell, never in a colgroup) */
  w: { player: number; exp: number; war: number; vs: number };
  /** "Exp" where a slot expectation exists, "Rd med" where a round's own
   *  median stands in for one */
  expLabel: string;
  /** the matching "Vs exp" / "Vs med" */
  vsLabel: string;
}) {
  return (
    <div>
      <div className={`pick-title ${tone}`}>{title}</div>
      <table>
        <thead><tr>
          {lead.map(c => (
            <th scope="col" key={c.label} className="t" style={{ width: `${c.w}%` }}>{c.label}</th>
          ))}
          <th scope="col" className="t" style={{ width: `${w.player}%` }}>Player</th>
          <th scope="col" className="n" style={{ width: `${w.exp}%` }}>{expLabel}</th>
          <th scope="col" className="n" style={{ width: `${w.war}%` }}>WAR</th>
          <th scope="col" className="n key" style={{ width: `${w.vs}%` }}>{vsLabel}</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={rowKey(r)}>
              {lead.map((c, i) => (i === 0
                ? <td key={c.label} className="t"
                  style={{ font: "600 15px/1 var(--cond)", color: "var(--txt2)" }}>{c.of(r)}</td>
                : <td key={c.label} className="t sub">{c.of(r)}</td>
              ))}
              <td className="who">
                <div className="line">
                  <PosBadge pos={r.pos} size="mini" color={POS_COLOR[r.pos] || "var(--rule)"} />
                  <span className="nm">{r.name}</span>
                </div>
                <div className="by">{r.drafter}</div>
              </td>
              <td className="n sub">{r.expected == null ? "—" : sgnWar(r.expected)}</td>
              <td className="n raw">{sgnWar(r.war)}</td>
              <td className="n vs" style={{ color: warInk(r.diff ?? 0) }}>{sgnWar(r.diff ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
