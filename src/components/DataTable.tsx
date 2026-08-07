import { type ReactNode } from "react";
import { useMobile } from "../lib/useWidth";
import TScroll from "./TScroll";

/**
 * The site's one sortable table.
 *
 * Columns are identified by `id`, NEVER by position. The version this replaced
 * held integer indices into a COLS array in three separate places — the
 * sortable set, the default sort and the click handler — so a column could
 * only ever be appended and hiding one would have re-pointed every index after
 * it. Keying on `id` is what lets two different pages draw different subsets of
 * columns from their own registries without any of them agreeing on order.
 *
 * The generic X is the per-render context a cell needs beyond its own row:
 * page-wide scales for meters and sparklines, mostly. It is computed once by
 * the page and handed to every cell rather than recomputed per row.
 */
export type Align = "c" | "t" | "n";

export interface Col<T, X> {
  id: string;
  label: string;
  /** which banner group this sits under; must match a Grp id */
  grp: number;
  /** column width as a PERCENTAGE on the header cell (never <colgroup>, never
   *  pixels — see SKILL.md §3); 0 means "let it take the slack" */
  w: number;
  align: Align;
  /** hidden on narrow screens (the `hm` class) */
  hm?: boolean;
  edge?: boolean;
  keyCol?: boolean;
  /** first click on this column sorts ascending — text columns */
  asc?: boolean;
  /** static <td> class list; the trailing `last` class is added dynamically */
  td: string;
  /** absent = not sortable. null/undefined values sort last in BOTH directions */
  sort?: (r: T) => number | string | null | undefined;
  cell: (r: T, x: X, i: number) => ReactNode;
  /** Records mode (≤640px, tables that opt in via `recordsOnMobile`): what
   *  this column becomes on the two-line record. `spine` is the rank cell,
   *  `identity` the subject, `headline` the one big figure (the column the
   *  list is sorted by), `micro` a labeled figure on line two (≤4), `sub`
   *  context joining the identity block. A column with no role — and every
   *  `hm` column — is dropped from the record; it lives on the subject's own
   *  page. */
  role?: "spine" | "identity" | "headline" | "micro" | "sub";
  /** the short label naming the figure on a phone ("Rec", "PPG") — a bare
   *  number on a records line is a bug; falls back to `label` */
  microKey?: string;
}

export interface Grp { id: number; label: string; cls: string }

/**
 * Sort by a column's accessor. Nulls sort last regardless of direction rather
 * than being read as zero: a player with no CVI is unranked, which is not the
 * same claim as "worst", and ascending order should surface the worst ranked
 * player rather than the unmeasured one.
 */
export function applySort<T, X>(rows: T[], col: Col<T, X> | undefined, dir: number): T[] {
  const get = col?.sort;
  if (!get) return rows;
  return rows.slice().sort((a, b) => {
    const av = get(a), bv = get(b);
    if (typeof av === "string" || typeof bv === "string")
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
}

/**
 * Resolve the sort column, tolerating an id that is no longer on screen — a
 * season change or a page switch can strip the column that was sorted. Falls
 * back to the page's resting sort, then to any sortable column, so the table is
 * never silently left in load order.
 */
export function sortCol<T, X>(cols: Col<T, X>[], id: string, home: string) {
  return cols.find(c => c.id === id)
    ?? cols.find(c => c.id === home)
    ?? cols.find(c => c.sort);
}

interface Props<T, X> {
  cols: Col<T, X>[];
  groups: Grp[];
  rows: T[];
  ctx: X;
  rowKey: (r: T) => string;
  sortId: string;
  dir: number;
  onSort: (c: Col<T, X>) => void;
  /** id of the column that resets the sort when clicked (the rank column) */
  homeCol?: string;
  openKey?: string | null;
  onRowClick?: (r: T) => void;
  /** inline drawer: rendered in a full-width row DIRECTLY beneath the open row,
   *  inside the table flow — never after the table (SKILL.md §5) */
  renderDrawer?: (r: T) => ReactNode;
  /** ≤640px, render as two-line records instead of a squeezed table. For the
   *  pages that are a LIST OF SUBJECTS (standings, rosters, feeds) — the one
   *  panning table on the site stays a table (MOBILE.md). */
  recordsOnMobile?: boolean;
  /** per-surface .rec-l2 grid variant ("t3", "t4") — the micro-figure columns
   *  are declared once per surface so they hold the same x-positions down the
   *  whole list */
  recordsClass?: string;
}

export default function DataTable<T, X>({
  cols, groups, rows, ctx, rowKey, sortId, dir, onSort, homeCol, openKey, onRowClick, renderDrawer,
  recordsOnMobile, recordsClass,
}: Props<T, X>) {
  const mobile = useMobile();
  if (mobile && recordsOnMobile) {
    return <Records cols={cols} rows={rows} ctx={ctx} rowKey={rowKey}
      openKey={openKey} onRowClick={onRowClick} renderDrawer={renderDrawer}
      recordsClass={recordsClass} />;
  }
  // a group spans only the columns actually on screen, so a group whose members
  // are all absent collapses instead of leaving an empty banner cell
  const span = (g: number) => cols.filter(c => c.grp === g && !(mobile && c.hm)).length;
  const lastId = cols.length ? cols[cols.length - 1].id : "";
  return (
    // AUTO layout, deliberately: every one of these tables opens with a
    // group-band row whose cells are colSpans, and `table-layout: fixed` takes
    // its widths from the first row — so fixing the layout throws away every
    // percentage hint and splits the board into equal columns (SKILL §3).
    //
    // Which leaves content-driven widths, and a ten-column board can want more
    // than a narrow viewport has. That is what `.tscroll` is for: the table
    // scrolls inside its own box rather than dragging the whole page sideways.
    <TScroll>
    <table>
      <thead>
        <tr className="grp">
          {groups.filter(g => span(g.id) > 0).map(g => (
            <th key={g.id} className={g.cls || undefined} colSpan={span(g.id)}>{g.label}</th>
          ))}
        </tr>
        <tr>
          {cols.map(c => {
            // A header that re-sorts is a control, so it has to be operable
            // from the keyboard and has to announce which way it is sorted.
            // Every leaderboard on the site was mouse-only before this.
            const act = c.id === homeCol || !!c.sort;
            return (
              <th key={c.id}
                className={[c.align, c.hm ? "hm" : "", c.edge ? "edge" : "", c.keyCol ? "key" : "",
                  act ? "sortable" : "", sortId === c.id ? "sorted" : ""]
                  .filter(Boolean).join(" ")}
                style={c.w ? { width: `${c.w}%` } : undefined}
                tabIndex={act ? 0 : undefined}
                aria-sort={sortId === c.id ? (dir < 0 ? "descending" : "ascending") : undefined}
                onClick={act ? () => onSort(c) : undefined}
                onKeyDown={act ? e => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(c); }
                } : undefined}>
                {c.label}{sortId === c.id ? (dir < 0 ? " ▼" : " ▲") : ""}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const k = rowKey(r);
          const open = openKey === k;
          return [
            <tr key={k} className={`click ${open ? "open" : i % 2 ? "zebra" : ""}`}
              onClick={() => onRowClick?.(r)}>
              {cols.map(c => (
                <td key={c.id} className={c.id === lastId ? `${c.td} last` : c.td}>
                  {c.cell(r, ctx, i)}
                </td>
              ))}
            </tr>,
            open && renderDrawer ? (
              <tr key={`${k}-drawer`} className="drawer-row">
                {/* The cell spans the whole table, which on a phone is wider
                    than the screen — so an unwrapped drawer opened half off to
                    the right. `.drawer-fit` is pinned to the left edge and
                    sized to the VISIBLE box, so the drawer lands where the
                    reader is looking however far the board is scrolled. */}
                <td colSpan={cols.length}>
                  <div className="drawer-fit">{renderDrawer(r)}</div>
                </td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </table>
    </TScroll>
  );
}

/**
 * Records mode: the ≤640px rendering of a subjects list. One `.rec` per row —
 * line one is identity plus the headline figure with its name beside it, line
 * two is the rest of the desktop row as labeled micro-figures on a declared
 * grid. No horizontal scroll, no bare numbers (MOBILE.md).
 *
 * Cell renderers are reused verbatim; a renderer that draws a meter must
 * return a bare figure in records mode — the page passes the mode through
 * `ctx`, never branches on `window` inside a renderer.
 */
function Records<T, X>({ cols, rows, ctx, rowKey, openKey, onRowClick, renderDrawer, recordsClass }: {
  cols: Col<T, X>[]; rows: T[]; ctx: X; rowKey: (r: T) => string;
  openKey?: string | null; onRowClick?: (r: T) => void;
  renderDrawer?: (r: T) => ReactNode; recordsClass?: string;
}) {
  // `hm` columns are dropped entirely on mobile, in both modes
  const on = cols.filter(c => !c.hm);
  const spine = on.find(c => c.role === "spine");
  const identity = on.find(c => c.role === "identity");
  const subs = on.filter(c => c.role === "sub");
  const headline = on.find(c => c.role === "headline");
  const micros = on.filter(c => c.role === "micro");
  return (
    <div className={recordsClass ? `records ${recordsClass}` : "records"}>
      {rows.map((r, i) => {
        const k = rowKey(r);
        const open = openKey === k;
        const act = !!onRowClick;
        return [
          // a .rec is the same control the <tr class="click"> was
          <div key={k}
            className={`rec${act ? " click" : ""}${open ? " open" : i % 2 ? " zebra" : ""}`}
            tabIndex={act ? 0 : undefined}
            role={act ? "button" : undefined}
            aria-expanded={act && renderDrawer ? open : undefined}
            onClick={act ? () => onRowClick!(r) : undefined}
            onKeyDown={act ? e => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick!(r); }
            } : undefined}>
            <div className="rec-l1">
              {spine && <span className="rec-rk">{spine.cell(r, ctx, i)}</span>}
              <span className="rec-id">
                {identity?.cell(r, ctx, i)}
                {subs.length > 0 && (
                  <span className="rec-sub">
                    {subs.map((c, j) => <span key={c.id}>{j > 0 ? " · " : ""}{c.cell(r, ctx, i)}</span>)}
                  </span>
                )}
              </span>
              {headline && <>
                <span className="rec-fig">{headline.cell(r, ctx, i)}</span>
                <span className="rec-key">{headline.microKey ?? headline.label}</span>
              </>}
            </div>
            {micros.length > 0 && (
              <div className="rec-l2">
                {micros.map(c => (
                  <span key={c.id} className="mic">
                    <span className="mk">{c.microKey ?? c.label}</span>
                    <span className="mv">{c.cell(r, ctx, i)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>,
          // the drawer still opens inline, immediately after its .rec — the
          // renderer already carries the .drawer accent top rule
          open && renderDrawer ? (
            <div key={`${k}-drawer`} className="rec-drawer">{renderDrawer(r)}</div>
          ) : null,
        ];
      })}
    </div>
  );
}
