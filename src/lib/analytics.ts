/**
 * GoatCounter, behind one tiny seam.
 *
 * The script tag in index.html loads the collector with `no_onload` (a
 * hash-routed SPA's automatic pageview would record every visit as "/"), and
 * this module is the only place that talks to it — every call is optional-
 * chained, so an ad-blocked or failed collector load costs nothing and breaks
 * nothing. GoatCounter itself ignores localhost, so dev traffic never counts.
 *
 * `pageview` fires once per route change from the <Track /> component in
 * App.tsx. `track` is for named feature events ("trade-machine-eval" and
 * friends) — they land in the dashboard alongside paths, flagged as events.
 */

interface GoatCounter {
  count: (opts?: { path?: string; title?: string; event?: boolean }) => void;
}

declare global {
  interface Window { goatcounter?: GoatCounter }
}

/** one screen view; `path` is the hash-route path (e.g. "/bigdog/trades") */
export function pageview(path: string): void {
  window.goatcounter?.count({ path });
}

/** one named feature use, e.g. track("ledger-team-filter") */
export function track(name: string): void {
  window.goatcounter?.count({ path: name, event: true });
}
