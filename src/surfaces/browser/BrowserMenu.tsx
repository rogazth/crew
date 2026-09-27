import { Menu } from "@base-ui/react/menu";
import {
  AppWindowIcon,
  CheckIcon,
  CodeXmlIcon,
  ChevronRightIcon,
  HistoryIcon,
  CookieIcon,
  EllipsisIcon,
  PanelBottomIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SettingsIcon,
  SearchIcon,
  ZoomInIcon,
  MinusIcon,
  PlusIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { browserCookieSources } from "../../lib/api";
import { DEVTOOLS_DOCKS, type DevToolsDock } from "../../lib/browserPrefs";
import { cookieSourceLabel } from "../../lib/browser/cookies";
import { zoomLabel, ZOOM_STEPS } from "../../lib/browser/zoom";
import { commandKeys, type CommandId } from "../../lib/commands";
import type { CookieSource } from "../../lib/protocol";

const PANEL =
  "max-h-[70vh] w-60 origin-(--transform-origin) overflow-y-auto overscroll-none rounded-xl bg-surface p-1 text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

const ROW =
  "flex h-8 w-full cursor-default items-center gap-2 whitespace-nowrap rounded-md px-2 text-left outline-none select-none data-disabled:opacity-40 data-highlighted:bg-hover data-popup-open:bg-hover";

const STEP =
  "grid size-6 cursor-default place-items-center rounded-md outline-none select-none data-disabled:opacity-40 data-highlighted:bg-hover";

const DOCKS: Record<DevToolsDock, { label: string; icon: Icon }> = {
  right: { label: "Dock to Right", icon: PanelRightIcon },
  bottom: { label: "Dock to Bottom", icon: PanelBottomIcon },
  left: { label: "Dock to Left", icon: PanelLeftIcon },
  window: { label: "Separate Window", icon: AppWindowIcon },
};

const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? ZOOM_MIN;

/** Submenus open beside their trigger, so they overlap the parent by the popup's own padding. */
function submenuOffset({ side }: { side: Menu.Positioner.Props["side"] }) {
  return side === "top" || side === "bottom" ? 4 : -4;
}

type Props = {
  zoom: number;
  onZoom: (direction: -1 | 0 | 1) => void;
  onFind: () => void;
  onDevTools: () => void;
  devtoolsDock: DevToolsDock;
  onDevToolsDock: (dock: DevToolsDock) => void;
  onHistory: () => void;
  onSettings: () => void;
  onImportCookies: (source: CookieSource) => void;
  /** False outside Electron, where nothing can write the cookies. */
  canImport: boolean;
};

/** The page's ⋯ menu, like a browser's: zoom, find, and what doesn't earn a toolbar button. */
export function BrowserMenu({
  zoom,
  onZoom,
  onFind,
  onDevTools,
  devtoolsDock,
  onDevToolsDock,
  onHistory,
  onSettings,
  onImportCookies,
  canImport,
}: Props) {
  // Read each time the menu opens: a browser installed meanwhile shows up without a restart.
  const [sources, setSources] = useState<CookieSource[] | null>(null);

  const load = (open: boolean) => {
    if (!open || !canImport) return;
    browserCookieSources()
      .then(setSources)
      .catch(() => setSources([]));
  };

  return (
    <Menu.Root modal={false} onOpenChange={load}>
      <Menu.Trigger
        aria-label="More"
        title="More"
        // A toolbar click keeps the keyboard where it was: in the page or in the bar.
        onMouseDown={(event) => event.preventDefault()}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-selected data-popup-open:text-text"
      >
        <EllipsisIcon className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            <div className="flex h-8 items-center gap-2 pr-1 pl-2">
              <ZoomInIcon className="size-4 shrink-0 text-icon" />
              <span className="flex-1">Zoom</span>
              <Menu.Item
                aria-label="Zoom out"
                closeOnClick={false}
                disabled={zoom <= ZOOM_MIN}
                onClick={() => onZoom(-1)}
                className={STEP}
              >
                <MinusIcon className="size-3.5" />
              </Menu.Item>
              <Menu.Item
                aria-label="Reset zoom"
                closeOnClick={false}
                onClick={() => onZoom(0)}
                className="min-w-11 cursor-default rounded-md py-0.5 text-center tabular-nums outline-none select-none data-highlighted:bg-hover"
              >
                {zoomLabel(zoom)}
              </Menu.Item>
              <Menu.Item
                aria-label="Zoom in"
                closeOnClick={false}
                disabled={zoom >= ZOOM_MAX}
                onClick={() => onZoom(1)}
                className={STEP}
              >
                <PlusIcon className="size-3.5" />
              </Menu.Item>
            </div>
            <Item icon={SearchIcon} label="Find…" command="find" onClick={onFind} />

            <Separator />

            <Item icon={HistoryIcon} label="History" command="open-history" onClick={onHistory} />
            {canImport && (
              <Submenu icon={CookieIcon} label="Import Cookies">
                {sources === null ? (
                  <Menu.Item disabled className={ROW}>
                    Looking for browsers…
                  </Menu.Item>
                ) : sources.length === 0 ? (
                  <Menu.Item disabled className={ROW}>
                    No Chromium browser found
                  </Menu.Item>
                ) : (
                  sources.map((source) => (
                    <Menu.Item key={source.id} className={ROW} onClick={() => onImportCookies(source)}>
                      <span className="min-w-0 flex-1 truncate">{cookieSourceLabel(source)}</span>
                    </Menu.Item>
                  ))
                )}
              </Submenu>
            )}
            <Item icon={CodeXmlIcon} label="Developer Tools" command="browser-devtools" onClick={onDevTools} />
            <Submenu icon={DOCKS[devtoolsDock].icon} label="Developer Tools Position">
              <Menu.RadioGroup value={devtoolsDock} onValueChange={(value) => onDevToolsDock(value as DevToolsDock)}>
                {DEVTOOLS_DOCKS.map((id) => {
                  const { icon: Glyph, label } = DOCKS[id];
                  return (
                    <Menu.RadioItem key={id} value={id} closeOnClick className={ROW}>
                      <Glyph className="size-4 shrink-0 text-icon" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <Menu.RadioItemIndicator>
                        <CheckIcon className="size-4 shrink-0" />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Submenu>

            <Separator />

            <Item icon={SettingsIcon} label="Settings" onClick={onSettings} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Item({ icon: Glyph, label, command, onClick }: { icon: Icon; label: string; command?: CommandId; onClick: () => void }) {
  return (
    <Menu.Item className={ROW} onClick={onClick}>
      <Glyph className="size-4 shrink-0 text-icon" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {command && <span className="shrink-0 text-[12px] text-text-muted tabular-nums">{commandKeys(command)}</span>}
    </Menu.Item>
  );
}

function Separator() {
  return <Menu.Separator className="mx-2 my-1 h-px bg-border" />;
}

function Submenu({ icon: Glyph, label, children }: { icon: Icon; label: string; children: ReactNode }) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={ROW}>
        <Glyph className="size-4 shrink-0 text-icon" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-icon" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50" sideOffset={submenuOffset} alignOffset={submenuOffset}>
          <Menu.Popup className={PANEL}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
