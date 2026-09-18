import { memo } from "react";
import * as lucide from "lucide-react";
import type { LucideProps } from "lucide-react";

export type IconName = keyof typeof icons;

/**
 * The only icon surface in the app. One set, one weight rule: 16px at 1.5,
 * 14px at 1.75 so the optical weight matches. Swapping icon libraries later
 * is this file and nothing else.
 */
const icons = {
  activity: lucide.Activity,
  alert: lucide.TriangleAlert,
  archive: lucide.Archive,
  arrowDown: lucide.ArrowDown,
  arrowLeft: lucide.ArrowLeft,
  arrowRight: lucide.ArrowRight,
  arrowUp: lucide.ArrowUp,
  at: lucide.AtSign,
  bell: lucide.Bell,
  bot: lucide.Bot,
  braces: lucide.Braces,
  brain: lucide.Sparkle,
  calendar: lucide.CalendarClock,
  check: lucide.Check,
  checkCircle: lucide.CircleCheck,
  chevronDown: lucide.ChevronDown,
  chevronLeft: lucide.ChevronLeft,
  chevronRight: lucide.ChevronRight,
  chevronUp: lucide.ChevronUp,
  clock: lucide.Clock,
  close: lucide.X,
  code: lucide.Code,
  command: lucide.Command,
  copy: lucide.Copy,
  cpu: lucide.Cpu,
  diff: lucide.GitCompareArrows,
  dot: lucide.Dot,
  download: lucide.Download,
  edit: lucide.PencilLine,
  eraser: lucide.Eraser,
  ellipsis: lucide.Ellipsis,
  external: lucide.ArrowUpRight,
  eye: lucide.Eye,
  file: lucide.File,
  fileCode: lucide.FileCode,
  fileText: lucide.FileText,
  filter: lucide.ListFilter,
  flask: lucide.FlaskConical,
  folder: lucide.Folder,
  folderOpen: lucide.FolderOpen,
  globe: lucide.Globe,
  gripVertical: lucide.GripVertical,
  hash: lucide.Hash,
  image: lucide.Image,
  inbox: lucide.Inbox,
  info: lucide.Info,
  keyboard: lucide.Keyboard,
  layers: lucide.Layers,
  layout: lucide.PanelLeft,
  link: lucide.Link,
  list: lucide.List,
  loader: lucide.LoaderCircle,
  mail: lucide.Mail,
  message: lucide.MessageSquare,
  minus: lucide.Minus,
  moon: lucide.Moon,
  monitor: lucide.Monitor,
  package: lucide.Package,
  palette: lucide.Palette,
  paperclip: lucide.Paperclip,
  pause: lucide.Pause,
  play: lucide.Play,
  plus: lucide.Plus,
  refresh: lucide.RefreshCw,
  repeat: lucide.Repeat,
  reply: lucide.CornerUpLeft,
  robot: lucide.Bot,
  routine: lucide.Repeat2,
  save: lucide.Save,
  search: lucide.Search,
  send: lucide.ArrowUp,
  settings: lucide.Settings,
  sidebar: lucide.PanelLeft,
  sliders: lucide.SlidersHorizontal,
  square: lucide.Square,
  stop: lucide.Square,
  sun: lucide.Sun,
  terminal: lucide.SquareTerminal,
  text: lucide.Type,
  trash: lucide.Trash2,
  user: lucide.User,
  wand: lucide.Wand,
  warning: lucide.TriangleAlert,
  workspace: lucide.Box,
  wrench: lucide.Wrench,
  x: lucide.X,
  zoomIn: lucide.ZoomIn,
  zoomOut: lucide.ZoomOut,
} satisfies Record<string, lucide.LucideIcon>;

export type IconProps = Omit<LucideProps, "size" | "ref"> & {
  name: IconName;
  size?: number;
};

export const Icon = memo(function Icon({ name, size = 16, ...rest }: IconProps) {
  const Glyph = icons[name];
  return (
    <Glyph
      size={size}
      strokeWidth={size <= 14 ? 1.75 : 1.5}
      absoluteStrokeWidth
      aria-hidden
      {...rest}
    />
  );
});
