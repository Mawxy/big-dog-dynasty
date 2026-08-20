import { useState } from "react";
import type { Team as TeamT } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { rosterSeasonOf } from "../../lib/league";
import { deriveRid, useIdentity } from "../../lib/identity";
import { Band, IdCell, TapRow, useBetaPath } from "../ui";

/**
 * WHO YOU ARE — one screen, reachable from everywhere, always reversible.
 *
 * This started life as a prompt that only rendered when we had no idea who the
 * reader was, which made picking wrong a one-way door: the Team tab then had a
 * franchise, so the prompt never showed again, and the only escape was a
 * "clear" control on More that fell back to the USERNAME's franchise. If your
 * username resolved correctly and you simply wanted to look at the board as
 * someone else, there was nowhere to go.
 *
 * So the claim is a real address (`/beta/claim`), linked from the Team screen's
 * header and from More, and it shows its own current state rather than assuming
 * the reader arrived here empty-handed. Three exits, because there are three
 * different things "wrong" can mean:
 *
 *   - wrong franchise      -> tap another one
 *   - wrong username       -> retype it, or clear it
 *   - not in this league   -> forget me, and go back to reading the board
 *     from nowhere in particular, which is a legitimate way to use the site
 */
export default function Claim() {
  const { league } = useLeague();
  const betaPath = useBetaPath();
  const ident = useIdentity();
  const teams = useJson<TeamT[]>(`${rosterSeasonOf(league)}/teams.json`).data;
  const [typed, setTyped] = useState(ident.user ?? "");

  const derived = deriveRid(teams, ident.user);
  const mine = teams?.find(t => t.roster_id === ident.rid);
  const nameMissed = ident.user != null && derived == null;

  return (
    <>
      <div className="v3-head">
        <h1>Your franchise</h1>
        <span className="sub">{league.name}</span>
      </div>

      <Band label="Right now"
        note="Stored on this device only — it never rides a shared link" />
      <div className="v3-idbox">
        <div className="tnote" style={{ marginTop: 0 }}>
          {mine
            ? <>You are <b style={{ color: "var(--acc)" }}>{mine.team}</b>{" "}
              ({mine.manager}) — {ident.derived
                ? "derived from your Sleeper username."
                : "claimed by hand on this device."}</>
            : "No franchise set. The Team tab will ask, and every other screen works without one."}
        </div>
      </div>

      <Band label="Sleeper username" note="Matched against the manager on each roster" />
      <div className="v3-idbox">
        <div className="row">
          <input id="v3claimuser" value={typed} placeholder="e.g. mawxy" autoCapitalize="off"
            autoCorrect="off" spellCheck={false} aria-label="Sleeper username"
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") ident.setUser(typed); }} />
          <button onClick={() => ident.setUser(typed)}>Save</button>
          {ident.user && (
            <button className="ghost" onClick={() => { ident.setUser(null); setTyped(""); }}>
              Clear
            </button>
          )}
        </div>
        {nameMissed && (
          <div className="tnote">
            No franchise in this league is managed by “{ident.user}”. The match is against the
            manager name in the last data refresh, so a recent rename on Sleeper won't have
            landed yet — pick yours below instead.
          </div>
        )}
      </div>

      <Band label={ident.rid == null ? "Pick a franchise" : "Or pick a different one"}
        note="Tap any row — this is reversible" />
      <table className="v3tbl">
        <tbody>
          {(teams ?? []).map((t, i) => {
            const on = t.roster_id === ident.rid;
            return (
              <TapRow key={t.roster_id} onTap={() => ident.claim(t.roster_id)}
                className={[i % 2 ? "zebra" : "", on ? "on" : ""].filter(Boolean).join(" ")}>
                <IdCell name={t.team}
                  sub={[t.manager, t.roster_id === derived ? "your username" : null]
                    .filter(Boolean).join(" · ")} />
                <td className="n">
                  <span className={`f q${on ? " acc" : ""}`}>{on ? "You" : "Claim"}</span>
                </td>
              </TapRow>
            );
          })}
        </tbody>
      </table>

      <div className="v3-more">
        {/* Only offered when it would actually change something: with no manual
            claim there is nothing to revert TO, and a control that does nothing
            is worse than one that isn't there. */}
        {!ident.derived && ident.rid != null && derived != null && (
          <button className="mrow" onClick={() => ident.claim(null)}>
            <span className="nm">Use my username's franchise instead</span>
            <span className="st">{teams?.find(t => t.roster_id === derived)?.team}</span>
          </button>
        )}
        {(ident.rid != null || ident.user != null) && (
          <button className="mrow" onClick={() => { ident.claim(null); ident.setUser(null); setTyped(""); }}>
            <span className="nm">Forget me on this device</span>
            <span className="st">Clears both</span>
          </button>
        )}
        <a className="mrow" href={`#${betaPath(ident.rid != null ? "/team" : "")}`}>
          <span className="nm">Done</span>
          <span className="st">{ident.rid != null ? "Back to your team" : "Back to the league"}</span>
        </a>
      </div>
    </>
  );
}
