import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { PicksOwned, PickValues, ProjectionsFile, Values } from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi, useProjWar } from "../lib/useIndices";
import { fmt, sgn, sgnWar, warInk, WAR_DP } from "../lib/stats";
import { pickStream, ROUND_ORD } from "../lib/rosterModel";
import { LEAGUE_TEAMS, POS_COLOR } from "../lib/league";
import { useMobile } from "../lib/useWidth";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

/**
 * Trade machine: one outgoing basket, many competing offers for it, each line
 * priced in every currency the site keeps — DVI, CVI, and 3-year WAR, all three
 * following the masthead's projection model.
 *
 * SHOPPING ONE PLAYER IS THE SHAPE. You are almost never comparing two
 * unrelated trades; you are asking what five teams will give you for Josh
 * Allen. So the outgoing side is pinned and edited once, and each offer is a
 * return basket against it. That makes the comparison table honest — every row
 * shares a denominator — where independent two-sided scenarios would leave the
 * reader diffing rows whose outgoing halves also differ.
 *
 * SIGNED ON BOTH SIDES, PER CURRENCY, NEVER OVERALL. The design system calls
 * colouring the two halves of a trade an anti-pattern, and it is right about
 * the surface it was written for: a Ledger card records what happened, and
 * inking a winner there editorialises a settled fact. This screen is the other
 * case — it exists to evaluate a hypothetical, and refusing to say who gains is
 * refusing to do the job.
 *
 * What is still refused is a SINGLE verdict. DVI and CVI answer different
 * questions and routinely point at different sides; averaging them into one
 * number would invent a composite the data does not support. So each currency
 * carries its own signed pair, and when they disagree the reader sees the
 * disagreement rather than its mean.
 */
interface Asset {
  key: string; label: string; kind: "player" | "pick";
  pid?: string; pos?: string; age: number | null;
  dvi: number | null; cvi: number | null;
  /** KeepTradeCut's market price. The one currency here the projection model
   *  does NOT touch — it is what the market says, not what we project, which is
   *  exactly why it earns a column beside three figures that all descend from
   *  one projection. Picks have one too, by tier. */
  ktc: number | null;
  /** players: 3-yr composite; picks: Bridge A slot/tier stream, summed */
  war: number;
}

/** One competing return for the pinned outgoing basket. Ids are stable and
 *  monotonic so removing the middle offer never renumbers the others under the
 *  reader's cursor. */
interface Offer { id: number; keys: string[] }

const TIERS = ["Early", "Mid", "Late"];

/** A signed figure in a currency, inked pos/neg and neutral inside the dead
 *  band. Both halves of a trade get one, so neither side is the implied
 *  subject — the design system's objection to colouring a trade is about
 *  implying a WINNER, and a pair of mirrored signs states a difference. */
function Delta({ v, dp }: { v: number; dp: number }) {
  const dead = dp === WAR_DP ? 0.0005 : 0.05;
  return <span style={{ color: Math.abs(v) < dead ? "var(--dim)" : warInk(v) }}>
    {dp === WAR_DP ? sgnWar(v) : sgn(v, dp)}
  </span>;
}

export default function TradeCalc() {
  // MOBILE.md M7 — baskets stack and each asset is a two-line record with its
  // figures named; each basket closes with its own labeled total band
  const mobile = useMobile();
  // keys, not Asset snapshots: an asset added before the index files resolve
  // re-resolves against the live options each render, so late loads fill in.
  // `out` is the pinned side — what you are shopping — and every offer is a
  // return against it.
  const [outKeys, setOutKeys] = useState<string[]>([]);
  const [offers, setOffers] = useState<Offer[]>([{ id: 1, keys: [] }]);
  const [active, setActive] = useState(1);
  const nextId = useRef(2);

  const proj = useJson<ProjectionsFile>("projections.json").data;
  // the daily scope, NOT the plain one: Draft.tsx reads this file on the daily
  // cache-bust and the cache keys on the finished path — a mismatch here made
  // two 1.4 MB downloads
  const pv = useJson<PickValues>("pick_values.json", "leagueDaily").data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  // global, not league-scoped: a market price is a property of the format
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  // model-aware: these follow the masthead's projection-model control
  const dvi = useDvi();
  const cvi = useCvi();
  // the third currency. Without it the masthead would reprice two of the
  // three columns and leave WAR still, which reads as a broken control.
  const projWar = useProjWar();

  const options = useMemo<Asset[]>(() => {
    if (!proj) return [];
    // KTC prices picks by TIER ("2027 Early 1st"), which is exactly the label
    // shape the future-pick assets below already carry, so the join is the
    // label itself. Current-year picks are named by exact slot, so they map
    // through the same tier the Bridge A stream uses.
    const pickKtc = new Map(vals?.picks?.ktc ?? []);
    const out: Asset[] = [];
    for (const p of proj.players) {
      out.push({
        key: `p${p.pid}`, label: p.name, kind: "player", pid: p.pid, pos: p.pos,
        age: p.age ?? null,
        dvi: dvi?.players[p.pid]?.dvi ?? null,
        cvi: cvi?.players[p.pid]?.cvi ?? null,
        ktc: vals?.players[p.pid]?.ktc ?? null,
        war: projWar?.[p.pid] ?? p.total_comp,
      });
    }
    if (pv) {
      const cur = pv.meta.generated_for_season + 1;   // current rookie class
      const sum = (s: number[]) => s.reduce((a, x) => a + x, 0);
      // current-year picks: every exact slot; Bridge A knows each one
      for (let r = 0; r < 4; r++)
        for (let s = 1; s <= LEAGUE_TEAMS; s++) {
          const bucket = `${r + 1}.${String(s).padStart(2, "0")}`;
          const tier = TIERS[Math.min(2, Math.floor((s - 1) / 4))];
          out.push({
            key: `k${cur} Pick ${bucket}`, label: `${cur} Pick ${bucket}`, kind: "pick",
            age: null, dvi: null, cvi: null,
            ktc: pickKtc.get(`${cur} ${tier} ${ROUND_ORD[r]}`) ?? null,
            war: sum(pickStream(pv, tier, r + 1)),
          });
        }
      // future years: Early/Mid/Late tiers, out to every season picks are owned
      const lastYear = Math.max(cur + 2, ...(owned?.meta?.seasons ?? []));
      for (let y = cur + 1; y <= lastYear; y++)
        for (let r = 0; r < 4; r++)
          for (const tier of TIERS)
            out.push({
              key: `k${y} ${tier} ${ROUND_ORD[r]}`, label: `${y} ${tier} ${ROUND_ORD[r]}`, kind: "pick",
              age: null, dvi: null, cvi: null,
              ktc: pickKtc.get(`${y} ${tier} ${ROUND_ORD[r]}`) ?? null,
              war: sum(pickStream(pv, tier, r + 1)),
            });
    }
    return out;
  }, [proj, pv, owned, dvi, cvi, projWar, vals]);

  const optByKey = useMemo(() => new Map(options.map(o => [o.key, o])), [options]);
  const resolve = useCallback(
    (keys: string[]) => keys.map(k => optByKey.get(k)).filter((a): a is Asset => !!a),
    [optByKey]);

  const outgoing = useMemo(() => resolve(outKeys), [resolve, outKeys]);
  const offer = offers.find(o => o.id === active) ?? offers[0];
  const incoming = useMemo(() => resolve(offer?.keys ?? []), [resolve, offer]);

  /** An asset can sit in the outgoing basket or in THIS offer, never both — but
   *  the same player may headline two competing offers, which is the whole
   *  point of comparing them. So the taken-set is per offer, not global. */
  const add = (side: "out" | "in", a: Asset) => {
    if (side === "out") {
      setOutKeys(p => (p.includes(a.key) ? p : [...p, a.key]));
    } else {
      setOffers(p => p.map(o => (o.id !== active || o.keys.includes(a.key)
        ? o : { ...o, keys: [...o.keys, a.key] })));
    }
  };
  const remove = (side: "out" | "in", key: string) => {
    if (side === "out") setOutKeys(p => p.filter(k => k !== key));
    else setOffers(p => p.map(o => (o.id !== active ? o : { ...o, keys: o.keys.filter(k => k !== key) })));
  };

  const addOffer = () => {
    const id = nextId.current++;
    setOffers(p => [...p, { id, keys: [] }]);
    setActive(id);
  };
  const dropOffer = (id: number) => setOffers(p => {
    const next = p.filter(o => o.id !== id);
    const kept = next.length ? next : [{ id: nextId.current++, keys: [] }];
    if (id === active) setActive(kept[0].id);
    return kept;
  });

  const tot = useCallback((s: Asset[]) => ({
    dvi: s.reduce((a, x) => a + (x.dvi ?? 0), 0),
    cvi: s.reduce((a, x) => a + (x.cvi ?? 0), 0),
    ktc: s.reduce((a, x) => a + (x.ktc ?? 0), 0),
    war: s.reduce((a, x) => a + x.war, 0),
    picks: s.filter(x => x.kind === "pick").length,
  }), []);
  const tOut = tot(outgoing), tIn = tot(incoming);
  const any = outgoing.length + incoming.length > 0;

  /** Every offer scored against the same outgoing basket, for the table. The
   *  shared denominator is what makes the rows comparable at a glance. */
  const scored = useMemo(() => offers.map(o => {
    const got = resolve(o.keys);
    const t = tot(got);
    return {
      id: o.id, got, n: got.length,
      dvi: t.dvi - tOut.dvi, cvi: t.cvi - tOut.cvi,
      ktc: t.ktc - tOut.ktc, war: t.war - tOut.war,
      picks: t.picks,
    };
  }), [offers, resolve, tot, tOut]);
  /** the leader per currency — marked per column, never combined into one
   *  "best offer", because the columns disagree and that disagreement is the
   *  information */
  const bestOf = (k: "dvi" | "cvi" | "ktc" | "war") => {
    const live = scored.filter(s => s.n > 0);
    if (live.length < 2) return null;
    return live.reduce((a, b) => (b[k] > a[k] ? b : a)).id;
  };
  const best = { dvi: bestOf("dvi"), cvi: bestOf("cvi"), ktc: bestOf("ktc"), war: bestOf("war") };

  /* NO PROSE UNDER THE DELTAS. It used to restate every figure in the table
     directly above it — "you give up 100.0 dynasty index points" next to a cell
     reading −100.0 — which is the table failing to be read, not the reader
     needing help. The only sentence kept is the empty state, where there are no
     figures to restate. Column headers and the row keys carry the units. */
  const empty = "Pin what you're shopping on the left, then build an offer on the right. Add more offers to compare them against the same outgoing side.";

  if (!proj) return <div className="empty">Loading…</div>;

  const basket = (i: "out" | "in") => {
    const t = i === "out" ? tOut : tIn;
    const rows = i === "out" ? outgoing : incoming;
    return (
      <div className="basket" key={i}>
        <div className="basket-head">
          <span>{i === "out" ? "You send" : "You receive"}</span>
          <span className="n">{rows.length ? `${rows.length} asset${rows.length === 1 ? "" : "s"}` : "empty"}</span>
        </div>
        {rows.length > 0 && mobile && (
          <div className="records flat t3">
            {rows.map((a, k) => (
              <div key={a.key} className={`rec${k % 2 ? " zebra" : ""}`}>
                <div className="rec-l1">
                  <span className="spine" style={{
                    background: a.kind === "player" ? POS_COLOR[a.pos!] ?? "var(--rule-2)" : "var(--rule-2)",
                  }} />
                  <span className="rec-id">
                    {a.kind === "player" ? <PlayerLink pid={a.pid!} name={a.label} /> : a.label}
                    <span className="rec-sub">
                      {a.kind === "player"
                        ? <>{a.pos}{a.age != null && <> · age {a.age}</>}</>
                        : "rookie pick · no index until it converts"}
                    </span>
                  </span>
                  <span className="rec-fig">{sgnWar(a.war)}</span>
                  <span className="rec-key">3yr WAR</span>
                  <button type="button" className="rec-x" title="remove"
                    onClick={() => remove(i, a.key)}>×</button>
                </div>
                <div className="rec-l2">
                  <span className="mic"><span className="mk">KTC</span>
                    <span className="mv">{a.ktc == null ? <span className="quiet">—</span> : a.ktc.toLocaleString()}</span></span>
                  <span className="mic"><span className="mk">DVI</span>
                    <span className="mv">{a.dvi == null ? <span className="quiet">—</span> : fmt(a.dvi, 1)}</span></span>
                  <span className="mic"><span className="mk">CVI</span>
                    <span className="mv">{a.cvi == null ? <span className="quiet">—</span> : fmt(a.cvi, 1)}</span></span>
                </div>
              </div>
            ))}
            {/* the basket's own total band — every figure labeled */}
            <div className="band">
              <span className="band-label">Total</span>
              <span className="band-note">
                DVI {fmt(t.dvi, 1)} · CVI {fmt(t.cvi, 1)} · 3yr WAR {sgnWar(t.war)}
              </span>
            </div>
          </div>
        )}
        {rows.length > 0 && !mobile && (
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th scope="col" className="c" style={{ width: "10%" }}>Pos</th>
                <th scope="col" className="t" style={{ width: "31%" }}>Asset</th>
                <th scope="col" className="n edge" style={{ width: "15%" }}>3yr WAR</th>
                <th scope="col" className="n" style={{ width: "13%" }}>KTC</th>
                <th scope="col" className="n edge" style={{ width: "13%" }}>DVI</th>
                <th scope="col" className="n" style={{ width: "13%" }}>CVI</th>
                <th scope="col" className="c" style={{ width: "5%" }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, k) => (
                <tr key={a.key} className={k % 2 ? "zebra" : ""}>
                  <td className="c">{a.kind === "player"
                    ? <PosBadge pos={a.pos!} />
                    : <PosBadge pos="PICK" />}</td>
                  <td className="t name" style={{ whiteSpace: "normal" }}>
                    {a.kind === "player" ? <PlayerLink pid={a.pid!} name={a.label} /> : a.label}
                  </td>
                  <td className="n fig strong edge">{sgnWar(a.war)}</td>
                  <td className="n fig">{a.ktc == null ? "—" : a.ktc.toLocaleString()}</td>
                  <td className="n fig edge">{a.dvi == null ? "—" : fmt(a.dvi, 1)}</td>
                  <td className="n fig">{a.cvi == null ? "—" : fmt(a.cvi, 1)}</td>
                  <td className="c">
                    <span style={{ color: "var(--dim)", cursor: "pointer" }} title="remove"
                      onClick={() => remove(i, a.key)}>×</span>
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: "1px solid var(--rule)" }}>
                <td className="c"></td>
                <td className="t name">Total</td>
                <td className="n edge"><span className="head-fig sm">{sgnWar(t.war)}</span></td>
                <td className="n"><span className="head-fig sm">{t.ktc.toLocaleString()}</span></td>
                <td className="n edge"><span className="head-fig sm">{fmt(t.dvi, 1)}</span></td>
                <td className="n"><span className="head-fig sm">{fmt(t.cvi, 1)}</span></td>
                <td className="c"></td>
              </tr>
            </tbody>
          </table>
        )}
        <div style={{ padding: "10px 14px 14px" }}>
          <AssetSearch options={options}
            taken={new Set([...outgoing, ...incoming].map(a => a.key))}
            onPick={a => add(i, a)}
            placeholder="+ Add player or pick (e.g. 2027 Early 1st)…" />
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="band">
        <span className="band-label">What you're shopping</span>
        <span className="band-note">Pinned across every offer</span>
      </div>
      <div className="baskets" style={{ marginTop: 14 }}>
        {basket("out")}
        {basket("in")}
      </div>

      {/* The offer strip. Chips rather than a segmented control: the set grows,
          and a segmented control that gains a segment every time you add one
          stops reading as a fixed set of choices. */}
      <div className="offerbar">
        {offers.map((o, i) => (
          <button key={o.id} type="button"
            className={`chip${o.id === active ? " on" : ""}`}
            onClick={() => setActive(o.id)}>
            Offer {i + 1}
            {offers.length > 1 && (
              <span className="x" role="button" tabIndex={-1} aria-label={`Remove offer ${i + 1}`}
                onClick={e => { e.stopPropagation(); dropOffer(o.id); }}>×</span>
            )}
          </button>
        ))}
        <button type="button" className="chip add" onClick={addOffer}>+ Offer</button>
      </div>

      {/* Both sides signed, in every currency, mirrored. Reading down a column
          answers "who gains on this axis"; reading across answers "do the axes
          agree". Neither is summed into a verdict. */}
      <div className="verdict-band">
        <table className="deltas">
          <thead><tr>
            <th scope="col" className="t" style={{ width: "34%" }}></th>
            <th scope="col" className="n" style={{ width: "22%" }}>You</th>
            <th scope="col" className="n" style={{ width: "22%" }}>Them</th>
            <th scope="col" className="t" style={{ width: "22%" }}></th>
          </tr></thead>
          <tbody>
            {([
              ["3yr WAR", tIn.war - tOut.war, WAR_DP, ""],
              ["KTC", tIn.ktc - tOut.ktc, 0, "market price"],
              ["DVI", tIn.dvi - tOut.dvi, 1, "index points, not value"],
              ["CVI", tIn.cvi - tOut.cvi, 1, "index points, not value"],
            ] as const).map(([label, d, dp, note]) => (
              <tr key={label}>
                <td className="t k">{label}</td>
                <td className="n fig">{any ? <Delta v={d} dp={dp} /> : <span className="quiet">—</span>}</td>
                <td className="n fig">{any ? <Delta v={-d} dp={dp} /> : <span className="quiet">—</span>}</td>
                <td className="t sub">{note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!any && <div className="prose">{empty}</div>}
      </div>

      {/* Every offer against the one outgoing basket. The shared denominator is
          what makes a five-row scan mean anything. */}
      {offers.length > 1 && (
        <>
          <div className="band" style={{ marginTop: 22 }}>
            <span className="band-label">Offers side by side</span>
            <span className="band-note">
              What you gain · best per column marked
            </span>
          </div>
          {/* MOBILE.md M7 — five numeric columns cannot hold at 375px, and a
              sideways-scrolling comparison defeats the point of a comparison.
              Same two-line record the baskets use: identity on line one, every
              figure NAMED on line two, so a delta is never an unlabeled number. */}
          {mobile ? (
            <div className="records flat" style={{ padding: "0 var(--pad)" }}>
              {scored.map((sc, i) => (
                <div key={sc.id} className={`rec${sc.id === active ? " on" : i % 2 ? " zebra" : ""}`}
                  onClick={() => setActive(sc.id)}>
                  <div className="rec-l1">
                    <span className="rec-id">
                      Offer {i + 1}
                      <span className="rec-sub">
                        {sc.n === 0 ? "empty" : sc.got.map(a => a.label).join(" · ")}
                      </span>
                    </span>
                    <span className="rec-fig">
                      {sc.n ? <Delta v={sc.war} dp={WAR_DP} /> : <span className="quiet">—</span>}
                    </span>
                    <span className="rec-key">3yr WAR</span>
                  </div>
                  <div className="rec-l2 three">
                    <span className="mic"><span className="mk">KTC</span>
                      <span className="mv">{sc.n ? <Delta v={sc.ktc} dp={0} /> : <span className="quiet">—</span>}</span></span>
                    <span className="mic"><span className="mk">DVI</span>
                      <span className="mv">{sc.n ? <Delta v={sc.dvi} dp={1} /> : <span className="quiet">—</span>}</span></span>
                    <span className="mic"><span className="mk">CVI</span>
                      <span className="mv">{sc.n ? <Delta v={sc.cvi} dp={1} /> : <span className="quiet">—</span>}</span></span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
          <div className="tscroll">
            <table className="offers">
              <thead><tr>
                <th scope="col" className="t" style={{ width: "9%" }}>Offer</th>
                <th scope="col" className="t" style={{ width: "37%" }}>You receive</th>
                <th scope="col" className="n edge" style={{ width: "15%" }}>3yr WAR</th>
                <th scope="col" className="n" style={{ width: "13%" }}>KTC</th>
                <th scope="col" className="n edge" style={{ width: "13%" }}>DVI</th>
                <th scope="col" className="n" style={{ width: "13%" }}>CVI</th>
              </tr></thead>
              <tbody>
                {scored.map((sc, i) => (
                  <tr key={sc.id} className={sc.id === active ? "on" : i % 2 ? "zebra" : ""}
                    onClick={() => setActive(sc.id)} style={{ cursor: "pointer" }}>
                    <td className="t k">Offer {i + 1}</td>
                    <td className="t name" style={{ whiteSpace: "normal" }}>
                      {sc.n === 0 ? <span className="quiet">empty</span>
                        : sc.got.map((a, j) => (
                          <span key={a.key}>{j > 0 && <span className="quiet"> · </span>}{a.label}</span>
                        ))}
                    </td>
                    <td className={`n fig strong edge${best.war === sc.id ? " lead" : ""}`}>
                      {sc.n ? <Delta v={sc.war} dp={WAR_DP} /> : <span className="quiet">—</span>}
                    </td>
                    <td className={`n fig${best.ktc === sc.id ? " lead" : ""}`}>
                      {sc.n ? <Delta v={sc.ktc} dp={0} /> : <span className="quiet">—</span>}
                    </td>
                    <td className={`n fig edge${best.dvi === sc.id ? " lead" : ""}`}>
                      {sc.n ? <Delta v={sc.dvi} dp={1} /> : <span className="quiet">—</span>}
                    </td>
                    <td className={`n fig${best.cvi === sc.id ? " lead" : ""}`}>
                      {sc.n ? <Delta v={sc.cvi} dp={1} /> : <span className="quiet">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </>
  );
}

/** typeahead over players + picks — the basket's add control */
function AssetSearch({ options, taken, onPick, placeholder }: {
  options: Asset[]; taken: Set<string>; onPick: (a: Asset) => void; placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const score = (label: string): number => {
      const n = label.toLowerCase();
      return n.startsWith(s) ? 0
        : n.split(/\s+/).some(w => w.startsWith(s)) ? 1
          : n.includes(s) ? 2 : -1;
    };
    return options
      .map(o => [score(o.label), o] as const)
      .filter(([sc, o]) => sc >= 0 && !taken.has(o.key))
      .sort((a, b) => a[0] - b[0])
      .slice(0, 8).map(([, o]) => o);
  }, [q, options, taken]);
  const pick = (a: Asset) => { onPick(a); setQ(""); setOpen(false); };
  /* the same combobox contract QuickJump uses — the arrow-key highlight is
   * only a highlight until something says which option it is on */
  const listId = useId();
  const optId = (i: number) => `${listId}-o${i}`;
  const shown = open && hits.length > 0;
  return (
    <div style={{ position: "relative" }}>
      <input type="search" placeholder={placeholder} value={q}
        style={{ width: "100%", boxSizing: "border-box" }}
        role="combobox" aria-label={placeholder}
        aria-expanded={shown} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={shown && hits[sel] ? optId(sel) : undefined}
        onChange={e => { setQ(e.target.value); setSel(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => Math.min(i + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && hits[sel]) pick(hits[sel]);
          else if (e.key === "Escape") setOpen(false);
        }} />
      {shown && (
        <div id={listId} role="listbox" aria-label="Matches" style={{
          position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 30,
          background: "var(--band)", border: "1px solid var(--rule)",
          overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,.35)",
        }}>
          {hits.map((o, i) => (
            <div key={o.key} id={optId(i)} role="option" aria-selected={i === sel}
              onMouseDown={e => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setSel(i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
                background: i === sel ? "var(--rule)" : "transparent",
              }}>
              <span style={{ color: "var(--dim)", fontSize: 10.5, letterSpacing: .5, width: 30, flexShrink: 0 }}>
                {o.kind === "player" ? o.pos : "PICK"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
              <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 12 }}>{sgnWar(o.war)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
