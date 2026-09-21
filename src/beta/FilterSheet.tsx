import { Sheet } from "./ui";
import {
  FILTER_FIELDS, newFilter, type Filter, type FilterField, type FilterOp,
} from "./filters";

/**
 * THE FILTER SHEET — the Players board's advanced search (Max, 2026-09-16).
 *
 * One row per criterion: the field, at-least or at-most, the number. Edits
 * apply as they are made — the board behind the sheet re-counts on every
 * keystroke, which is the feedback a threshold needs ("2500 leaves 41, 3000
 * leaves 19"). The same `Sheet` the season picker uses: bottom sheet on a
 * phone, centered dialog on a desktop, Escape and the scrim to close.
 */
export default function FilterSheet({ filters, fields, onChange, onClose, count }: {
  filters: Filter[];
  /** the criteria this league can answer, in sheet order — `filterFieldsFor`.
   *  A league whose pipeline writes no indices, no projections and no market
   *  would otherwise be offered six thresholds that can only empty the board. */
  fields: FilterField[];
  onChange: (fs: Filter[]) => void;
  onClose: () => void;
  /** how many rows the board shows under the current criteria */
  count: number | null;
}) {
  const set = (i: number, patch: Partial<Filter>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i: number) => onChange(filters.filter((_, j) => j !== i));
  /** a new criterion takes the first field not already in use, and OPENS ON
   *  THAT FIELD'S OWN DEFAULT (filters.ts) — every one used to open at 0,
   *  so the first tap on "+ Add criterion" read "Age ≤ 0" and emptied the
   *  board */
  const add = () => {
    const used = new Set(filters.map(f => f.field));
    onChange([...filters, newFilter(fields.find(k => !used.has(k)) ?? fields[0] ?? "age")]);
  };
  /** CHANGING THE FIELD RE-OPENS THE CRITERION, comparison and number both:
   *  "Age ≤ 25" switched to KTC kept the 25 and became "KTC ≤ 25", which is
   *  the same empty board by another road. A threshold only means something
   *  next to the quantity it is a threshold on. */
  const setField = (i: number, field: FilterField) =>
    onChange(filters.map((f, j) => (j === i ? newFilter(field) : f)));
  const groups: { id: "now" | "seasons"; label: string }[] = [
    { id: "now", label: "Now" }, { id: "seasons", label: "League seasons" },
  ];
  return (
    <Sheet label="Advanced search"
      title={<>Advanced search{count != null && <span className="fsx-count"> · {count} match</span>}</>}
      onClose={onClose}>
      <div className="fsx">
        {filters.length === 0 && (
          <div className="fsx-empty">No criteria yet. Add one below — every player on the board has to pass all of them.</div>
        )}
        {filters.map((f, i) => (
          <div className="fsx-row" key={i}>
            {/* a criterion already in the URL keeps its own field in the list
                even where this league cannot answer it — a select whose value
                is not among its options renders as some other field, which
                would silently rewrite what the reader shared */}
            <select className="fsx-field" value={f.field} aria-label="Field"
              onChange={e => setField(i, e.target.value as FilterField)}>
              {groups.map(g => {
                const ks = fields.filter(k => FILTER_FIELDS[k].group === g.id)
                  .concat(fields.includes(f.field) || FILTER_FIELDS[f.field].group !== g.id
                    ? [] : [f.field]);
                return ks.length === 0 ? null : (
                  <optgroup key={g.id} label={g.label}>
                    {ks.map(k => (
                      <option key={k} value={k}>{FILTER_FIELDS[k].label}</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            {/* at-least / at-most as one two-state control, never a dropdown:
                there are two answers and a reader should see both */}
            <div className="fsx-op" role="group" aria-label="Comparison">
              {(["<", ">"] as FilterOp[]).map(op => (
                <button key={op} type="button" className={f.op === op ? "on" : ""}
                  aria-pressed={f.op === op} onClick={() => set(i, { op })}>
                  {op === ">" ? "≥" : "≤"}
                </button>
              ))}
            </div>
            <input className="fsx-val" type="number" inputMode="decimal" value={f.value}
              step={FILTER_FIELDS[f.field].step} aria-label="Value"
              onChange={e => set(i, { value: e.target.value === "" ? 0 : Number(e.target.value) })} />
            <button type="button" className="fsx-x" aria-label="Remove" onClick={() => remove(i)}>×</button>
            <div className="fsx-def">{FILTER_FIELDS[f.field].def}</div>
          </div>
        ))}
        <div className="fsx-foot">
          <button type="button" className="fsx-add" onClick={add}>+ Add criterion</button>
          {filters.length > 0 && (
            <button type="button" className="fsx-clear" onClick={() => onChange([])}>Clear all</button>
          )}
        </div>
        <div className="fsx-note">
          Filters apply on top of the position chips and the search box, in both the Value and Stats tenses.
          A player the site has no figure for fails that criterion: "under 25" cannot admit a player with no age.
          They live in the address, so the board can be shared as filtered.
        </div>
      </div>
    </Sheet>
  );
}
