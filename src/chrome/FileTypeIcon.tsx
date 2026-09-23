import { extensionOf } from "../lib/attachments";

/** Extension-coloured file glyph. A dot keeps the palette readable at 14px. */
const COLORS: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#f0db4f", jsx: "#f0db4f",
  rs: "#dea584", py: "#3572a5", go: "#00add8", rb: "#cc342d",
  php: "#777bb4", java: "#b07219", swift: "#f05138", kt: "#a97bff",
  css: "#563d7c", scss: "#c6538c", html: "#e34c26", vue: "#41b883",
  json: "#8a8a8f", yml: "#8a8a8f", yaml: "#8a8a8f", toml: "#8a8a8f",
  md: "#519aba", sql: "#e38c00", sh: "#89e051", lock: "#8a8a8f",
  png: "#a074c4", jpg: "#a074c4", jpeg: "#a074c4", svg: "#ffb13b",
};

export function FileTypeIcon({
  name,
  className = "size-3.5",
}: {
  name: string;
  className?: string;
}) {
  const ext = extensionOf(name);
  const color = COLORS[ext] ?? "#9a9aa0";
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} shrink-0`}
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 3v5h5" />
      <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" />
      <circle cx="12" cy="15" r="2" fill={color} stroke="none" />
    </svg>
  );
}
