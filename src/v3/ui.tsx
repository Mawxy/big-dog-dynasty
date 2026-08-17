import { useCallback, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";

/**
 * An in-app path inside the v3 shell: `v3p("/team")` -> `/big-dog/v3/team`.
 *
 * Every internal link goes through this. A bare `lp("/team")` would land on the
 * classic board's routes and drop the reader out of the shell mid-tap — which
 * is exactly the failure a prototype mounted beside a live site invites.
 */
export function useV3Path() {
  const lp = useLeaguePath();
  return useCallback((p: string) => lp(`/v3${p.startsWith("/") ? p : `/${p}`}`), [lp]);
}

/**
 * The v3 row and band vocabulary.
 *
 * These are deliberately NOT built on components/DataTable. That table is a
 * desktop object: it owns column groups, hidden-column collapsing, per-row
 * drawers and a ten-column budget, none of which survive contact with a 375px
 * screen. v3's tables are four columns wide, have no drawers at all (rows
 * navigate — decision #11's corollary) and stack their identity cell, so
 * reusing DataTable would have meant configuring away everything it does.
 *
 * What IS shared is the design language: the tokens, the spine, the band, the
 * figure strip, tabular numerals, zero radius. Those come from style.css.
 */

/* ---- bands -------------------------------------------------------------- */

/** A section band. Same anatomy as the classic board's — label left, note
 *  right — so a screen reads as one product across the two shells. */
export function Band({ label, note, right }: {
  label: ReactNode;
  /** the methodology note: what the figures under this band are measured
   *  against. Say it here or the table has to say it in a column header. */
  note?: ReactNode;
  /** a control, when the band is also the section's affordance */
  right?: ReactNode;
}) {
  return (
    <div className="band">
      <span className="band-label">{label}</span>
      {right ?? (note ? <span className="band-note">{note}</span> : null)}
    </div>
  );
}

/* ---- figure strip ------------------------------------------------------- */

export interface Figure {
  key: string;
  label: string;
  value: ReactNode;
  /** the sub-label under the figure — a name, a qualifier, a second total */
  sub?: ReactNode;
  /** in-app path; makes the cell a link. "Each figure taps through." */
  to?: string;
  /** the screen's ONE headline figure, if it has one on this strip */
  acc?: boolean;
}

/**
 * The thin figure band. Scrolls sideways on a phone rather than wrapping —
 * see v3.css. Cells with a `to` are anchors, so they are keyboard-reachable and
 * open in a new tab on a modifier click; cells without are plain divs, because
 * a div that looks tappable and is not is worse than one that never did.
 */
export function Strip({ figures }: { figures: Figure[] }) {
  const nav = useNavigate();
  return (
    <div className="v3strip">
      {figures.map(f => {
        const body = (
          <>
            <div className="k">{f.label}</div>
            <div className={`v${f.acc ? " acc" : ""}`}>{f.value}</div>
            {f.sub != null && <div className="s">{f.sub}</div>}
          </>
        );
        return f.to
          ? <a key={f.key} className="cell" href={`#${f.to}`}
            onClick={e => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault(); nav(f.to!);
            }}>{body}</a>
          : <div key={f.key} className="cell">{body}</div>;
      })}
    </div>
  );
}

/* ---- row parts ---------------------------------------------------------- */

/** Em dash, in decorative ink. NEVER a zero: a figure that hasn't happened and
 *  a figure that came back empty are different facts. */
export const NUL = <span className="nul">—</span>;

/**
 * The rank spine cell: a 3px bar coloured by position or status, the ordinal,
 * and optionally the movement since the comparison point.
 *
 * `top` marks the figure in the accent — a leader, or a team above the
 * playoff cutline.
 */
export function Spine({ color, rank, top, move }: {
  color: string; rank: ReactNode; top?: boolean;
  /** signed rank movement; positive is upward. Rendered ▲2 / ▼1, never
   *  coloured — direction is the claim, and green would make it a verdict. */
  move?: number | null;
}) {
  return (
    <td className="sp">
      <span className="spine" style={{ background: color }} />
      <span className={`rank${top ? " top" : ""}`}>{rank}</span>
      {move != null && move !== 0 &&
        <span className="mv">{move > 0 ? "▲" : "▼"}{Math.abs(move)}</span>}
    </td>
  );
}

/**
 * The stacked identity cell — line 1 the name, line 2 `TEAM · POS-rank · tags`.
 *
 * Always two lines, even when the sub-line is thin, so a column of these has
 * one height and the eye tracks straight down the names.
 */
export function IdCell({ name, sub, to }: {
  name: ReactNode; sub?: ReactNode;
  /** where the NAME goes, when that differs from where the row goes */
  to?: string;
}) {
  const nav = useNavigate();
  return (
    <td className="idc t">
      <div className="idc-n">
        {to
          ? <a href={`#${to}`} onClick={e => {
            e.stopPropagation();
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault(); nav(to);
          }}>{name}</a>
          : name}
      </div>
      <div className="idc-s">{sub ?? " "}</div>
    </td>
  );
}

/** The compact ordinals carrying the lenses that are not featured. */
export function Ords({ items }: { items: { k: string; v: number | null }[] }) {
  return (
    <div className="ords">
      {items.map(i => (
        <span key={i.k} className="o">{i.k}<b>{i.v == null ? "—" : i.v}</b></span>
      ))}
    </div>
  );
}

/**
 * A tappable row.
 *
 * A `<tr>` cannot be a `<button>`, so this is the same contract the classic
 * board's clickable rows carry: role, tabIndex, and Enter/Space, so the row is
 * operable from a keyboard as well as a thumb.
 */
export function TapRow({ to, onTap, className = "", children }: {
  /** where the row goes. Rows navigate; there are no drawers on a phone. */
  to?: string;
  onTap?: () => void;
  className?: string; children: ReactNode;
}) {
  const nav = useNavigate();
  const fire = () => { if (onTap) onTap(); else if (to) nav(to); };
  return (
    <tr className={`tap ${className}`} role="button" tabIndex={0}
      onClick={fire}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
      }}>
      {children}
    </tr>
  );
}

/* ---- sorting ------------------------------------------------------------ */

/** Header-click sorting, phone-sized: one sort column, one direction. */
export function useSort<K extends string>(initial: K, initialDir: 1 | -1 = -1) {
  const [sort, setSort] = useState<K>(initial);
  const [dir, setDir] = useState<1 | -1>(initialDir);
  const onSort = useCallback((id: K, asc = false) => {
    setSort(prev => {
      if (prev === id) { setDir(d => (d === 1 ? -1 : 1)); return prev; }
      setDir(asc ? 1 : -1);
      return id;
    });
  }, []);
  return { sort, dir, onSort, setSort };
}

/** A sortable header cell. */
export function Th<K extends string>(
  { id, label, sort, onSort, align = "n", asc, width }: {
    id: K; label: ReactNode; sort: K; onSort: (id: K, asc?: boolean) => void;
    align?: "t" | "n" | "c"; asc?: boolean; width?: string;
  },
) {
  return (
    <th className={`${align} sortable${sort === id ? " sorted" : ""}`}
      style={width ? { width } : undefined}
      tabIndex={0} role="button" aria-pressed={sort === id}
      onClick={() => onSort(id, asc)}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(id, asc); }
      }}>
      {label}
    </th>
  );
}

/** Sort a list by a nullable accessor, nulls always last regardless of
 *  direction — a missing figure is not a small one. */
export function sortBy<T>(rows: T[], key: (r: T) => number | string | null, dir: 1 | -1): T[] {
  return rows.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string" || typeof y === "string")
      return String(x).localeCompare(String(y)) * dir;
    return (x - y) * dir;
  });
}
