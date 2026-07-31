import { type ReactNode } from "react";
import { useMobile } from "../lib/useWidth";

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
}

export default function DataTable<T, X>({
  cols, groups, rows, ctx, rowKey, sortId, dir, onSort, homeCol, openKey, onRowClick, renderDrawer,
}: Props<T, X>) {
  const mobile = useMobile();
  // a group spans only the columns actually on screen, so a group whose members
  // are all absent collapses instead of leaving an empty banner cell
  const span = (g: number) => cols.filter(c => c.grp === g && !(mobile && c.hm)).length;
  const lastId = cols.length ? cols[cols.length - 1].id : "";
  return (
    <table>
      <thead>
        <tr className="grp">
          {groups.filter(g => span(g.id) > 0).map(g => (
            <th key={g.id} className={g.cls || undefined} colSpan={span(g.id)}>{g.label}</th>
          ))}
        </tr>
        <tr>
          {cols.map(c => (
            <th key={c.id}
              className={[c.align, c.hm ? "hm" : "", c.edge ? "edge" : "", c.keyCol ? "key" : "",
                (c.id === homeCol || c.sort) ? "sortable" : "", sortId === c.id ? "sorted" : ""]
                .filter(Boolean).join(" ")}
              style={c.w ? { width: `${c.w}%` } : undefined}
              onClick={() => onSort(c)}>
              {c.label}{sortId === c.id ? (dir < 0 ? " ▼" : " ▲") : ""}
            </th>
          ))}
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
                <td colSpan={cols.length}>{renderDrawer(r)}</td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </table>
  );
}
