/**
 * GoatCounter, behind one tiny seam.
 *
 * The script tag in index.html loads the collector async with `no_onload` (a
 * hash-routed SPA's automatic pageview would record every visit as "/"), and
 * this module is the only place that talks to it.
 *
 * THE QUEUE IS LOAD-BEARING. The first pageview fires from the router the
 * moment the app mounts — almost always before the async collector has
 * loaded. Optional-chaining straight into `window.goatcounter` silently
 * dropped that first view, which meant a session that landed on one screen
 * and read it recorded NOTHING — the dashboard stayed empty while real
 * traffic flowed. So: calls made before the collector exists are queued and
 * flushed by a short poll once it arrives. If it never arrives (ad blocker,
 * network), the poll gives up after ~15s and the queue is dropped — analytics
 * must never break the site. GoatCounter ignores localhost on its own, so
 * dev traffic never counts.
 */

interface GoatCounter {
  count: (opts?: { path?: string; title?: string; event?: boolean }) => void;
}

declare global {
  interface Window { goatcounter?: GoatCounter }
}

/** A pageview, which is the only kind of hit this site sends. GoatCounter's
 *  `count` also takes `event: true` for a named feature use; nothing here has
 *  ever called for one, so the queue carries paths and nothing else. */
type Hit = { path: string };

const queue: Hit[] = [];
let poller: ReturnType<typeof setInterval> | null = null;
let tries = 0;

function flush(): void {
  const gc = window.goatcounter;
  if (!gc?.count) return;
  while (queue.length) gc.count(queue.shift());
}

function send(hit: Hit): void {
  if (window.goatcounter?.count) {
    flush();                      // anything queued goes first, in order
    window.goatcounter.count(hit);
    return;
  }
  queue.push(hit);
  if (poller == null) {
    poller = setInterval(() => {
      if (window.goatcounter?.count || ++tries > 30) {   // ~15s, then give up
        flush();
        if (poller != null) clearInterval(poller);
        poller = null;
      }
    }, 500);
  }
}

/** one screen view; `path` is the hash-route path (e.g. "/bigdog/trades") */
export function pageview(path: string): void {
  send({ path });
}
