import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Hover tooltip rendered position:fixed into document.body, so it overlays
 *  everything — table edges, scroll containers, the works. Opens upward when
 *  there's room above, downward near the top of the viewport. Hover-only by
 *  design: touch devices never see it, so nothing essential should live here. */
export default function HoverTip({ tip, children, align = "right", block }: {
  tip: ReactNode; children: ReactNode;
  /** which edge of the wrapped content the tooltip aligns to */
  align?: "left" | "right";
  /** render the wrapper as a block (for cells with their own ellipsis span) */
  block?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  return (
    <span ref={ref}
      style={{ display: block ? "block" : "inline-block", maxWidth: "100%" }}
      onMouseEnter={() => {
        const r = ref.current!.getBoundingClientRect();
        const up = r.top > 300;   // enough headroom for a tall tip?
        setPos({ x: align === "left" ? r.left : r.right, y: up ? r.top - 6 : r.bottom + 6, up });
      }}
      onMouseLeave={() => setPos(null)}>
      {children}
      {pos && createPortal(
        <div style={{
          position: "fixed", zIndex: 1000, left: pos.x, top: pos.y,
          transform: `translate(${align === "left" ? "0" : "-100%"}, ${pos.up ? "-100%" : "0"})`,
          background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8,
          padding: "6px 10px", fontSize: 12, whiteSpace: "nowrap", textAlign: "left",
          lineHeight: 1.7, boxShadow: "0 6px 20px rgba(0,0,0,.35)", color: "var(--dim)",
          pointerEvents: "none",
        }}>{tip}</div>,
        document.body)}
    </span>
  );
}
