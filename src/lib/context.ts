import { createContext, useContext } from "react";
import type { Meta, PlayersMin } from "./types";

export const LeagueContext = createContext<{ meta: Meta; players: PlayersMin } | null>(null);

export function useLeague() {
  const v = useContext(LeagueContext);
  if (!v) throw new Error("league context missing");
  return v;
}
