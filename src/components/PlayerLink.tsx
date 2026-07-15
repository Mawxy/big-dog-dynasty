import { useNavigate } from "react-router-dom";

/** Player name that navigates to the player's dedicated page. */
export function PlayerLink({ pid, name }: { pid: string; name: string }) {
  const nav = useNavigate();
  return (
    <span className="tlink" onClick={e => { e.stopPropagation(); nav(`/player/${pid}`); }}>
      {name}
    </span>
  );
}
