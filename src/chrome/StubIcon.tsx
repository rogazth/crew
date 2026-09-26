import { HistoryIcon, SquareTerminalIcon, type LucideIcon as Icon } from "lucide-react";
import type { StubKind } from "../lib/types";

const ICONS: Record<StubKind, Icon> = {
  terminal: SquareTerminalIcon,
  history: HistoryIcon,
};

export function StubIcon({ stub, className }: { stub: StubKind; className?: string }) {
  const Glyph = ICONS[stub];
  return <Glyph className={className} />;
}
