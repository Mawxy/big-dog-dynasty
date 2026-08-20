import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";

/**
 * An in-app path inside the beta shell: `betaPath("/team")` -> `/big-dog/beta/team`.
 *
 * Every internal link goes through this. A bare `lp("/team")` would land on the
 * classic board's routes and drop the reader out of the shell mid-tap — which
 * is exactly the failure a prototype mounted beside a live site invites.
 */
export function useBetaPath() {
  const lp = useLeaguePath();
  return useCallback((p: string) => lp(`/beta${p.startsWith("/") ? p : `/${p}`}`), [lp]);
}

/**
 * The beta shell's row and band vocabulary.
 *
 * These are deliberately NOT built on components/DataTable. That table is a
 * desktop object: it owns column groups, hidden-column collapsing, per-row
 * drawers and a ten-column budget, none of which survive contact with a 375px
 * screen. The beta shell's tables are four columns wide, have no drawers at all (rows
 * navigate — decision #11's corollary) and stack their identity cell, so
 * reusing DataTable would have meant configuring away everything it does.
 *
 * What IS shared is the design language: the tokens, the spine, the band, the
 * figure strip, tabular numerals, zero radius. Those come from style.css.
 */

/* ---- bands -------------------------------------------------------------- */

/** A section band. Same anatomy as the classic board's — label left, note
 *  right — so a screen reads as one product across the two shells. */
export function Band({ label, note, right, total }: {
  label: ReactNode;
  /** the methodology note: what the figures under this band are measured
   *  against. Say it here or the table has to say it in a column header. */
  note?: ReactNode;
  /** a control, when the band is also the section's affordance */
  right?: ReactNode;
  /** THE BAND'S OWN TOTAL, in the accent, beside the label.
   *
   *  A grouped table's total belongs on the band rather than in a footer row:
   *  a footer sits below a list whose length varies, so on a phone it is
   *  usually off-screen while the reader is looking at the group it totals.
   *  Declared as a prop rather than composed into `label` because three screens
   *  were about to write `<span style={{ color: "var(--acc)" }}>` inline, and
   *  the accent has to be spendable in one place to stay one accent. */
  total?: ReactNode;
}) {
  return (
    <div className="band">
      <span className="band-label">
        {label}
        {total != null && <span className="band-total">{total}</span>}
      </span>
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
 * see beta.css. Cells with a `to` are anchors, so they are keyboard-reachable and
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
  /** POSITION COLOUR GOES HERE, never on the name. A coloured name is a link
   *  affordance on every other row of the site, and four position hues fighting
   *  one accent is four accents. Optional: a board with no positional dimension
   *  (standings, franchises) takes the inactive rule and still gets the 3px
   *  column, so every beta table has the same left edge. */
  color?: string;
  rank: ReactNode; top?: boolean;
  /** signed rank movement; positive is upward. Rendered ▲2 / ▼1, never
   *  coloured — direction is the claim, and green would make it a verdict. */
  move?: number | null;
}) {
  return (
    <td className="sp">
      <span className="spine" style={{ background: color ?? "var(--rule-2)" }} />
      <span className={`rank${top ? " top" : ""}`}>{rank}</span>
      {move != null && move !== 0 &&
        <span className="mv">{move > 0 ? "▲" : "▼"}{Math.abs(move)}</span>}
    </td>
  );
}

/**
 * The same 3px spine, OUTSIDE a table.
 *
 * The baskets on the Trade screen and the asset picker are flex rows, not table
 * rows, and both were carrying `style={{ flex: "0 0 3px", alignSelf: "stretch" }}`
 * written out by hand — three copies of a rule, none of which the design system
 * could change. The colour still arrives as a value (POS_COLOR is data, not a
 * class), but the geometry is now the stylesheet's.
 */
export function PosSpine({ color }: { color?: string }) {
  return <span className="v3spine" style={{ background: color ?? "var(--rule-2)" }} />;
}

/**
 * The stacked identity cell — line 1 the name, line 2 `TEAM · POS-rank · tags`.
 *
 * Always two lines, even when the sub-line is thin, so a column of these has
 * one height and the eye tracks straight down the names.
 */
export function IdCell({ name, sub, tags, to }: {
  name: ReactNode; sub?: ReactNode;
  /** SLOT TAGS — FLX, SFLX, TAXI, IR — on the sub-line, after `sub`.
   *
   *  Passed structurally rather than joined into `sub` by the caller, because a
   *  tag is not affiliation: it takes the condensed face, uppercase and tracked,
   *  so it reads as a label rather than as part of the club name beside it, and
   *  IR takes --warn. Every caller that joined them into that string with " · "
   *  was silently rendering them as body text.
   *
   *  A tag whose text repeats the position rank beside it (QB in the QB slot)
   *  is the caller's to omit — this renders what it is given. */
  tags?: IdTag[];
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
      <div className="idc-s">{subLine(sub, tags)}</div>
    </td>
  );
}

/** a slot tag on the identity sub-line. `ir` is the one tone that is not
 *  decorative ink — injured reserve is a fact about availability, and --warn
 *  is the token that already says "caution" everywhere else on the board. */
export type IdTag = string | { label: string; tone?: "ir" };

/** the sub-line's contents, shared by the table cell and the flex-row form */
function subLine(sub: ReactNode, tags?: IdTag[]): ReactNode {
  // The non-breaking space is load-bearing: an empty sub-line still has to
  // occupy a line, or a row with no affiliation collapses to 30px and breaks
  // the column's rhythm.
  if (!tags?.length) return sub ?? " ";
  return (
    <>
      {sub}
      {tags.map((t, i) => {
        const label = typeof t === "string" ? t : t.label;
        const tone = typeof t === "string" ? undefined : t.tone;
        return (
          <span key={`${label}-${i}`}>
            {(sub != null || i > 0) ? " · " : null}
            <span className={`tg${tone ? ` ${tone}` : ""}`}>{label}</span>
          </span>
        );
      })}
    </>
  );
}

/**
 * THE SAME STACKED IDENTITY, outside a table.
 *
 * Decision #11 says "stacked identity cells, always", and "always" has to
 * survive leaving a `<table>`: the Trade baskets, the asset picker and the
 * switcher sheet are all flex rows, and each grew its own two-line block with
 * its own type ramp — `.v3-side .asset .n1` at 13px, `.v3-pick .prow .n1` at
 * 13.5px, `.v3-sheet .lrow .nm` at 15px. Three sizes for one object, and a
 * player who looked like a different kind of thing on each of three screens.
 *
 * This renders the identical `.idc-n` / `.idc-s` pair the table cell does.
 */
export function IdLines({ name, sub, tags }: {
  name: ReactNode; sub?: ReactNode; tags?: IdTag[];
}) {
  return (
    <span className="v3id">
      <span className="idc-n">{name}</span>
      <span className="idc-s">{subLine(sub, tags)}</span>
    </span>
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

/* ---- controls ------------------------------------------------------------ */

/**
 * The full-width lens strip.
 *
 * ONE control, not a chip row. A lens is an exclusive choice over the same
 * population — Rankings prices the same twelve franchises four ways — so it
 * reads edge to edge as a single object with one segment lit. The chip row that
 * `POS_CHIPS` uses is the opposite shape on purpose: those FILTER, they can
 * combine in the reader's head, and they sit in a scrolling row.
 *
 * This is the one place in the beta shell that fills a control with the accent, which is
 * legal because a lens strip is inside a view and there is exactly one per
 * screen. The projection-model picker deliberately does NOT get this treatment
 * (see More): it sits above every view, where an accent competes with each
 * screen's headline figure.
 *
 * Lived in screens/Rankings as a local; Team hand-rolled the same markup with
 * its own two buttons. Promoted so the DVI/CVI toggle and the Rankings lenses
 * are provably the same control.
 */
export function LensStrip<T extends string>({ options, value, onChange, label = "Lens" }: {
  options: readonly { id: T; label: ReactNode }[];
  value: T; onChange: (v: T) => void;
  /** the group's accessible name — "Lens", "Index", "Scope" */
  label?: string;
}) {
  return (
    <div className="v3-lens" role="group" aria-label={label}>
      {options.map(o => (
        <button key={o.id} type="button" className={value === o.id ? "on" : ""}
          aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ---- the ledger ---------------------------------------------------------- */

/**
 * THE LEDGER: a label and N right-aligned figure columns. Nothing else.
 *
 * Decision #14 in component form. There is no winner column, no verdict row and
 * no prose slot, and that is not an omission to be filled in later — DVI and CVI
 * answer different questions and routinely point at different sides, so a single
 * number would be inventing agreement. What the component DOES provide is the
 * guardrail caption, because the design system requires one on this pattern and
 * a caption that each screen writes for itself is a caption that drifts.
 *
 * Composed rather than configured: the Trade screen supplies formatted figures
 * (a market figure carries a thousands separator, an index figure carries one
 * decimal, and no shared formatter should be deciding which). This owns the
 * grammar — column count, alignment, weight, which row is the headline.
 */
export const LEDGER_GUARDRAIL = "DVI and CVI are index points, not value.";

export function Ledger({ title = "Ledger", columns, caption, children }: {
  title?: ReactNode;
  /** the currencies, left to right. Three today (Market · DVI · CVI). */
  columns: ReactNode[];
  /** the guardrail, plus whatever else the reader must not misread. Defaults
   *  to LEDGER_GUARDRAIL alone; pass a fragment to append to it. */
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="v3-ledger">
      <div className="lk">{title}</div>
      <table>
        <thead>
          <tr>
            <th className="t" style={{ width: "30%" }} />
            {columns.map((c, i) => <th key={i}>{c}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      <div className="tnote">{caption ?? LEDGER_GUARDRAIL}</div>
    </div>
  );
}

/**
 * One ledger line: a label, an optional qualifier under it, and one figure per
 * column.
 *
 * `tone` is about WEIGHT, not about who won:
 *   - "sub"  the inputs a total is built from (in / out totals)
 *   - "adj"  an adjustment — the consolidation line. Shown, never smuggled into
 *            the total above it, which is the whole reason it is a row.
 *   - "net"  the headline. One per ledger.
 *
 * There is deliberately no "positive/negative" tone. `.pos` / `.neg` exist in
 * the stylesheet for figures elsewhere on the board; a ledger figure keeps
 * neutral ink because colouring "net to Side A" green is declaring a winner in
 * CSS. The sign already carries the direction.
 */
export function LedgerRow({ label, sub, values, tone = "sub" }: {
  label: ReactNode;
  /** the qualifier under the label — "in 8370 · out 8760" */
  sub?: ReactNode;
  values: ReactNode[];
  tone?: "sub" | "adj" | "net";
}) {
  return (
    <tr className={`lr ${tone}`}>
      <td className="t">
        {label}
        {sub != null && <div className="lsub">{sub}</div>}
      </td>
      {values.map((v, i) => (
        <td key={i}>
          <span className={tone === "net" ? "big" : tone === "adj" ? "adj" : "sm"}>{v}</span>
        </td>
      ))}
    </tr>
  );
}

/* ---- the bottom sheet ---------------------------------------------------- */

/**
 * A bottom sheet — the phone's answer to a menu, and the mechanism the league
 * switcher rides on (decision #6: the sheet IS the user level, which is what
 * lets a whole user-home screen be deleted).
 *
 * Extracted from BetaShell's LeagueSheet so a second sheet — the projection-model
 * picker on More is the obvious next one — is the same object rather than a
 * lookalike. What it owns beyond the markup is the three behaviours a sheet
 * gets wrong when it is hand-rolled: Escape closes it, the page behind it does
 * not scroll while it is up, and the scrim is a real button so a screen reader
 * is told there is a way out.
 */
export function Sheet({ label, title, onClose, children }: {
  /** the dialog's accessible name */
  label: string;
  /** the band across the top */
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // A sheet over a scrolling board: without this the page behind it scrolls
    // under a thumb aiming at the sheet, and closing it leaves the reader
    // somewhere they never navigated to.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <>
      <button className="v3-scrim" aria-label="Close" onClick={onClose} />
      <div className="v3-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <div className="sheet-band">
          <span className="k">{title}</span>
          <button className="x" type="button" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </>
  );
}

/** A row inside a sheet: name over metadata, with a mark on the current one. */
export function SheetRow({ name, meta, mark, on, disabled, onClick }: {
  name: ReactNode; meta?: ReactNode;
  /** the accent word on the row that is already in force — "Here", "In use" */
  mark?: ReactNode;
  on?: boolean; disabled?: boolean; onClick?: () => void;
}) {
  return (
    <button type="button" className={`lrow${on ? " on" : ""}`}
      disabled={disabled} onClick={onClick}>
      <span>
        <span className="nm">{name}</span>
        {meta != null && <span className="mt">{meta}</span>}
      </span>
      {mark != null && <span className="mark">{mark}</span>}
    </button>
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
