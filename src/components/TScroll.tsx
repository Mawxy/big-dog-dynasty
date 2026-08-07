import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * The box a wide table scrolls inside, plus the two things that make it
 * readable on a phone.
 *
 * `.tscroll` on its own already stops a ten-column board dragging the whole
 * page sideways. What it did not do was tell the reader the board scrolls, or
 * keep hold of the subject while it did: the rank spine and the name scrolled
 * away with everything else, so a row on a phone became figures with nothing
 * saying whose they were.
 *
 * Two behaviors, both conditional on the table ACTUALLY being wider than its
 * box rather than on a breakpoint — a desktop board that fits is untouched,
 * and one that doesn't gets the same treatment a phone gets:
 *
 *   pinning — the first two cells hold at the left edge. Only where the table
 *     opens with the identity block every board on this site shares (a
 *     `spine-cell` rank, then a `.name`); the tables that don't have it, like
 *     the player projection and the franchise roster, get the scroll box and
 *     the fade without a pinned column that would mean nothing.
 *
 *   the fade — a right edge saying the columns continue, dropped the moment
 *     the last one is reached, because a fade that never goes away stops
 *     meaning anything.
 *
 * The pin offset is MEASURED, never declared: the rank column is auto-width
 * and comes out at 25px on the league board and 47px on the weekly one, so any
 * constant would misplace the name on most screens.
 */
export default function TScroll(
  /** `box` names the scroll container's own class, so the draft board
   *  (`dscroll`) and the strengths grid (`rankwrap`) — the two widest
   *  scrollers on the site, and the two that keep their own padding rules —
   *  get the affordance without being re-styled as tables. */
  { children, box: boxCls = "tscroll", hint }: {
    children: ReactNode; box?: string; hint?: string;
  },
) {
  const boxRef = useRef<HTMLDivElement>(null);
  /** measured width of the rank column, or 0 when the board is not pinned */
  const [stick, setStick] = useState(0);
  /** the visible width, so an open drawer can be sized to the phone rather
   *  than to the table it hangs under */
  const [boxW, setBoxW] = useState(0);
  const [over, setOver] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const wide = box.scrollWidth > box.clientWidth + 1;
      // the identity block is what makes a pin meaningful — no spine, no pin
      const head = box.querySelector<HTMLElement>("thead tr:not(.grp) th");
      const spine = box.querySelector("tbody td.spine-cell");
      setOver(wide);
      // sticky positioning changes no box on the table, so this cannot feed
      // back into the observer that triggered it
      setStick(wide && head && spine ? head.offsetWidth : 0);
      setBoxW(box.clientWidth);
      setMore(wide && box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    // `table { width: 100% }` means the table's own border box never changes
    // when its CONTENT outgrows the viewport, so observing the table alone
    // misses exactly the case this component exists for. The row group does
    // resize, and is what the observer has to watch.
    const body = box.querySelector("tbody");
    if (body) ro.observe(body);
    box.addEventListener("scroll", measure, { passive: true });
    return () => { ro.disconnect(); box.removeEventListener("scroll", measure); };
  }, []);

  return (
    <>
      {over && (
        <p className="tnote tscroll-hint">
          {hint ?? (stick
            ? "The table scrolls sideways — the rank and the name stay pinned to the left edge."
            : "The table scrolls sideways.")}
        </p>
      )}
      <div className={`tscroll-wrap${more ? " more" : ""}`}>
        <div ref={boxRef} className={`${boxCls}${stick ? " stuck" : ""}`}
          style={stick
            ? ({ "--stick": `${stick}px`, "--boxw": `${boxW}px` } as CSSProperties)
            : undefined}>
          {children}
        </div>
      </div>
    </>
  );
}
