import { createContext, useContext } from "react";

/** Set by App: navigates to a player's dedicated page. */
export const OpenPlayerContext = createContext<(pid: string) => void>(() => {});

export function PlayerLink({ pid, name }: { pid: string; name: string }) {
  const open = useContext(OpenPlayerContext);
  return <span className="tlink" onClick={e => { e.stopPropagation(); open(pid); }}>{name}</span>;
}
