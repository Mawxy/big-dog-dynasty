import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Hover tooltip rendered position:fixed into document.body, so it overlays
 *  everything — table edges, scroll containers, the works. It measures its own
 *  size and clamps into the viewport on both axes, opening above or below by
 *  whichever side actually has room. Hover-only by design: touch devices never
 *  see it, so nothing essential should live here. */
export default function HoverTip({ tip, children, align = "right", block }: {
  tip: ReactNode; children: ReactNode;
  /** which edge of the wrapped content the tooltip aligns to */
  align?: "left" | "right";
  /** render the wrapper as a block (for cells with their own ellipsis span) */
  block?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // measure the rendered tip and clamp it inside the viewport
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const t = tipRef.current.getBoundingClientRect();
    const M = 8;                                   // keep this far off every edge
    const vw = window.innerWidth, vh = window.innerHeight;
    // vertical: open upward if it fits above (or there's more room there)
    const roomAbove = anchor.top, roomBelow = vh - anchor.bottom;
    let top = (roomAbove >= t.height + M || roomAbove >= roomBelow)
      ? anchor.top - 6 - t.height
      : anchor.bottom + 6;
    top = Math.max(M, Math.min(top, vh - t.height - M));
    // horizontal: anchor to the chosen edge, then clamp fully on-screen
    let left = align === "left" ? anchor.left : anchor.right - t.width;
    left = Math.max(M, Math.min(left, vw - t.width - M));
    setPos({ left, top });
  }, [anchor, align]);

  // a fixed-position tip captured on enter would drift out of place if the page
  // scrolls under it — just dismiss it instead (capture=true catches inner
  // scroll containers too)
  useEffect(() => {
    if (!anchor) return;
    const close = () => { setAnchor(null); setPos(null); };
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, [anchor]);

  return (
    <span ref={ref}
      style={{ display: block ? "block" : "inline-block", maxWidth: "100%" }}
      onMouseEnter={() => setAnchor(ref.current!.getBoundingClientRect())}
      onMouseLeave={() => { setAnchor(null); setPos(null); }}>
      {children}
      {anchor && createPortal(
        <div ref={tipRef} style={{
          position: "fixed", zIndex: 1000,
          left: pos?.left ?? anchor.right, top: pos?.top ?? anchor.top,
          visibility: pos ? "visible" : "hidden",   // hide for the pre-clamp frame
          maxWidth: "calc(100vw - 16px)",
          background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8,
          padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap", textAlign: "left",
          lineHeight: 1.7, boxShadow: "0 6px 20px rgba(0,0,0,.35)", color: "var(--dim)",
          pointerEvents: "none",
        }}>{tip}</div>,
        document.body)}
    </span>
  );
}
