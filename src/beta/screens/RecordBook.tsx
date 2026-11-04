import type { Franchises } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague, useLook } from "../../lib/context";
import { DataError } from "../ui";
import TeamRecords from "./TeamRecords";

/**
 * THE RECORD BOOK, ITS OWN PAGE (Max, 2026-09-29).
 *
 * The league's book — every franchise's bests and worsts, game and season,
 * each naming its holder — at /records, reachable from More. League ·
 * All-time carries the same book with its lists folded to ten; here they open
 * at twenty-five, because the book is the whole page.
 */
export default function RecordBook() {
  const { meta } = useLeague();
  const frQ = useJson<Franchises>("franchises.json");
  // the lab's hook for this page's own layer (c4-trade.css); the live board
  // renders the bare class, as before
  const look = useLook();
  return (
    <>
      <div className={look === "c4" ? "v3-head c4-rbk" : "v3-head"}><h1>Record book</h1></div>
      {frQ.error
        ? <DataError what="The franchise history didn't load" />
        : <TeamRecords fkey={null} fr={frQ.data} seasons={meta.seasons} fold={25} />}
    </>
  );
}
