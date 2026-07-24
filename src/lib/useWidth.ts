import { useEffect, useRef, useState, type RefObject } from "react";

/** Track a container's pixel width (clamped), so SVG charts can size to their
 *  parent. Returns the ref to attach and the current width. */
export function useWidth<T extends HTMLElement>(
  initial: number, min = 0, max = Infinity,
): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(min, Math.min(max, el.clientWidth)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min, max]);
  return [ref, w];
}

/** True when the viewport is at or below the phone breakpoint (≤640px), so
 *  grouped-header colspans can drop the columns hidden by `.hm`. */
export function useMobile(query = "(max-width: 640px)"): boolean {
  const [m, setM] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}
