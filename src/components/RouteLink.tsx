import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";

/**
 * An in-app link that behaves like a link.
 *
 * A real anchor, not a span with an onClick: as a span these were unreachable
 * by keyboard and impossible to open in a new tab. The href is the hash route
 * the HashRouter already uses, so middle-click and ⌘-click work natively; a
 * plain left click is an in-app navigation instead.
 *
 * `stopPropagation` first, always — most of these sit inside a row that opens
 * a drawer on click, and a modifier click that opens a tab must not ALSO
 * toggle the row underneath it. On the handful that have no clickable
 * ancestor (the champion blocks) it is a no-op.
 *
 * Eight sites hand-rolled this same four-line handler before it lived here.
 */
export function RouteLink({ to, className = "tlink", style, title, children }: {
  /** in-app path, already league-scoped by useLeaguePath */
  to: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  children: ReactNode;
}) {
  const nav = useNavigate();
  return (
    <a className={className} href={`#${to}`} style={style} title={title}
      onClick={e => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        nav(to);
      }}>
      {children}
    </a>
  );
}
