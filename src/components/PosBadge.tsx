export default function PosBadge({ pos }: { pos: string }) {
  return <span className={`pos ${pos}`}>{pos}</span>;
}
