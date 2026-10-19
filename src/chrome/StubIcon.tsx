import { HistoryIcon, LayersIcon, SquareTerminalIcon, type LucideIcon as Icon } from "lucide-react";
import type { StubKind } from "../lib/types";

const ICONS: Record<StubKind, Icon> = {
  terminal: SquareTerminalIcon,
  history: HistoryIcon,
  commands: LayersIcon,
};

export function StubIcon({ stub, className }: { stub: StubKind; className?: string }) {
  const Glyph = ICONS[stub];
  return <Glyph className={className} />;
}
