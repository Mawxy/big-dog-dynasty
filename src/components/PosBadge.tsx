export default function PosBadge({ pos, rank }: { pos: string; rank?: number }) {
  return <span className={`pos ${pos}`}>{pos}{rank ?? ""}</span>;
}
