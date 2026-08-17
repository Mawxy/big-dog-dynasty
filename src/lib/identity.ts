import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Team } from "./types";

/**
 * WHO IS READING — the v3 object model's atomic subject.
 *
 * v2 has no concept of a reader: every screen is the league seen from nowhere.
 * v3's Team tab is "the franchise page pointed at you", which needs an answer to
 * "which of these twelve is you", and the League tab's switcher needs "which
 * leagues are yours". Both come from one Sleeper username, entered once.
 *
 * DERIVED FROM COMMITTED DATA, NOT FROM SLEEPER. The redesign's object model
 * says the claim is auto-derived from the Sleeper user's roster, and its
 * architecture section says the browser will one day call Sleeper directly —
 * but that half is explicitly parked ("agreed, not yet built"), and
 * PROJECT_NOTES holds the front end to `data/*.json` only. It turns out no call
 * is needed for the claim: `teams.json` already carries `manager`, which IS the
 * Sleeper display name. So a typed username resolves to a roster_id off a file
 * the site already fetches, with no network dependency, no CORS, and no
 * behaviour that breaks when Sleeper is down.
 *
 * `claims` is the manual override, per league. It exists because the derivation
 * can miss — a manager who renamed on Sleeper since the last data refresh, or a
 * reader who wants to look at the board as someone else — and because a walk-up
 * visitor with no Sleeper account at all should still be able to pick a team.
 * An explicit claim always beats the derived one; clearing it falls back.
 *
 * Stored client-side and never in the URL. A shared link is a LEAGUE address
 * (decision #6): the sender's identity must not ride along and re-point the
 * recipient's Team tab at the sender's roster.
 */
export interface IdentityState {
  /** Sleeper username as typed, or null if never entered */
  user: string | null;
  /** league key -> explicitly claimed roster_id, overriding the derivation */
  claims: Record<string, number>;
}

const KEY = "warboard.v3.identity";
const EMPTY: IdentityState = { user: null, claims: {} };

function read(): IdentityState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Partial<IdentityState>;
    return {
      user: typeof v.user === "string" && v.user ? v.user : null,
      claims: v.claims && typeof v.claims === "object" ? v.claims : {},
    };
  } catch { return EMPTY; }            // private mode, or a corrupt entry
}

function write(s: IdentityState) {
  try { window.localStorage.setItem(KEY, JSON.stringify(s)); }
  catch { /* private mode — the session still works, it just won't persist */ }
}

/**
 * The username -> roster_id derivation, exported so the More screen can show
 * what it resolved to (and, when it resolves to nothing, say so).
 *
 * Case- and space-insensitive: Sleeper display names are compared by eye, not
 * by byte, and "loadedtoad" vs "LoadedToad" is the same person.
 */
export function deriveRid(teams: Team[] | null, user: string | null): number | null {
  if (!teams || !user) return null;
  const want = user.trim().toLowerCase();
  if (!want) return null;
  return teams.find(t => t.manager.trim().toLowerCase() === want)?.roster_id ?? null;
}

export interface Identity extends IdentityState {
  /** the franchise this reader is, for the league in context */
  rid: number | null;
  /** true when `rid` came from the username rather than from a manual claim —
   *  the More screen words the row differently for the two */
  derived: boolean;
  setUser: (u: string | null) => void;
  /** null clears the manual claim and falls back to the derivation */
  claim: (rid: number | null) => void;
}

export const IdentityContext = createContext<Identity | null>(null);

export function useIdentity(): Identity {
  const v = useContext(IdentityContext);
  if (!v) throw new Error("identity context missing");
  return v;
}

/**
 * The provider's state, held by the v3 shell.
 *
 * `teams` is the roster season's rosters — the same array the Team screen
 * renders — and is null until it lands, which is why `rid` is nullable rather
 * than a number with a sentinel. A screen that renders before the derivation
 * can run shows the claim prompt for one paint otherwise.
 */
export function useIdentityState(leagueKey: string, teams: Team[] | null): Identity {
  const [st, setSt] = useState<IdentityState>(read);

  const setUser = useCallback((u: string | null) => {
    setSt(prev => {
      const next = { ...prev, user: u && u.trim() ? u.trim() : null };
      write(next);
      return next;
    });
  }, []);

  const claim = useCallback((rid: number | null) => {
    setSt(prev => {
      const claims = { ...prev.claims };
      if (rid == null) delete claims[leagueKey]; else claims[leagueKey] = rid;
      const next = { ...prev, claims };
      write(next);
      return next;
    });
  }, [leagueKey]);

  return useMemo(() => {
    const manual = st.claims[leagueKey];
    // A manual claim is only honoured while the roster it names still exists —
    // a stale localStorage entry from another league (or from before a roster
    // was removed) would otherwise point the Team tab at nothing forever.
    const valid = manual != null && (!teams || teams.some(t => t.roster_id === manual));
    const auto = deriveRid(teams, st.user);
    return {
      ...st,
      rid: valid ? manual : auto,
      derived: !valid && auto != null,
      setUser, claim,
    };
  }, [st, leagueKey, teams, setUser, claim]);
}
