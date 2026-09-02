import {
  ChatCircleIcon,
  GearIcon,
  GlobeIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { StubKind } from "../lib/types";

const ICONS: Record<StubKind, Icon> = {
  terminal: TerminalWindowIcon,
  browser: GlobeIcon,
  sidechat: ChatCircleIcon,
  settings: GearIcon,
};

export function StubIcon({ stub, className }: { stub: StubKind; className?: string }) {
  const Glyph = ICONS[stub];
  return <Glyph className={className} />;
}
