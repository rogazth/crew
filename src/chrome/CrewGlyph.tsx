/** The app icon's three faces, drawn small: home's mark, the one on the rail with colour in it. */
export function CrewGlyph({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="22 29 57 45" aria-hidden className={className}>
      <rect x="24.5" y="36.5" width="15" height="29" rx="7.5" fill="#89BBFB" />
      <rect x="41.5" y="31" width="19" height="40" rx="9.5" fill="#F9A964" />
      <rect x="62.5" y="36.5" width="15" height="29" rx="7.5" fill="#84D487" />
      {EYES.map(([x, y, w, h]) => (
        <rect key={x} x={x} y={y} width={w} height={h} rx={w / 2} fill="#0F172A" />
      ))}
    </svg>
  );
}

const EYES: [number, number, number, number][] = [
  [29.5, 46, 2.7, 4.8],
  [35.6, 46, 2.7, 4.8],
  [45.6, 42, 3.4, 6.2],
  [53.5, 42, 3.4, 6.2],
  [64, 46, 2.7, 4.8],
  [70.2, 46, 2.7, 4.8],
];
