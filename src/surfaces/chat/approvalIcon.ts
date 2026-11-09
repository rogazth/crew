import {
  BotIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListChecksIcon,
  MoveIcon,
  PencilIcon,
  PlugIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
  Trash2Icon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { ApprovalView } from "../../lib/approvals";

/** A card nothing waits on any more: its mark loses the colour an open card's has. */
export const SETTLED_TILE = "bg-canvas text-text-muted";

/** The mark for what a call does, not for being asked: a terminal for a command, a pencil for an edit. */
export function approvalIcon(view: ApprovalView): LucideIcon {
  switch (view.kind) {
    case "shell":
      return TerminalIcon;
    case "edit":
      if (view.headline.startsWith("Delete")) return Trash2Icon;
      if (view.headline.startsWith("Move")) return MoveIcon;
      if (view.headline.startsWith("Write") || view.headline.startsWith("Create")) return FilePlusIcon;
      return PencilIcon;
    case "read":
      return FileTextIcon;
    case "search":
      return SearchIcon;
    case "fetch":
    case "websearch":
      return GlobeIcon;
    case "mcp":
      return PlugIcon;
    case "permissions":
      return ShieldIcon;
    case "outside":
      return FolderOpenIcon;
    case "plan":
      return ListChecksIcon;
    case "subagent":
      return BotIcon;
    default:
      return WrenchIcon;
  }
}
