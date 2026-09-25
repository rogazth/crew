import { ArrowLeftIcon, ArrowRightIcon, CodeXmlIcon, RotateCwIcon, SmartphoneIcon, XIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { commandKeys, type CommandId } from "../../lib/commands";
import type { PageState } from "../../lib/browser/pageStore";
import { zoomLabel } from "../../lib/browser/zoom";
import { AddressBar, type AddressBarHandle } from "./AddressBar";

type Props = {
  page: PageState;
  addressRef: Ref<AddressBarHandle>;
  searchTemplate: string;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onDevTools: () => void;
  onZoomReset: () => void;
  responsive: boolean;
  onResponsive: () => void;
  onNavigate: (url: string) => void;
  onLeaveAddress: () => void;
};

/** One 40px row under the tab strip: history, the address, and the page's tools. */
export function BrowserToolbar({
  page,
  addressRef,
  searchTemplate,
  onBack,
  onForward,
  onReload,
  onStop,
  onDevTools,
  onZoomReset,
  responsive,
  onResponsive,
  onNavigate,
  onLeaveAddress,
}: Props) {
  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border bg-canvas px-2">
      <Tool label="Back" command="browser-back" disabled={!page.canGoBack} onClick={onBack}>
        <ArrowLeftIcon className="size-4" />
      </Tool>
      <Tool label="Forward" command="browser-forward" disabled={!page.canGoForward} onClick={onForward}>
        <ArrowRightIcon className="size-4" />
      </Tool>
      {page.loading ? (
        <Tool label="Stop" onClick={onStop}>
          <XIcon className="size-4" />
        </Tool>
      ) : (
        <Tool label="Reload" command="browser-reload" onClick={onReload}>
          <RotateCwIcon className="size-4" />
        </Tool>
      )}
      <div className="mx-1 flex min-w-0 flex-1">
        <AddressBar
          ref={addressRef}
          url={page.url}
          searchTemplate={searchTemplate}
          onNavigate={onNavigate}
          onLeave={onLeaveAddress}
        />
      </div>
      {page.zoom !== 1 && (
        <button
          type="button"
          title={`Zoomed to ${zoomLabel(page.zoom)}. Reset to actual size (${commandKeys("zoom-reset")})`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onZoomReset}
          className="h-6 shrink-0 rounded-md px-1.5 text-[11px] text-icon tabular-nums transition-colors hover:bg-hover hover:text-text"
        >
          {zoomLabel(page.zoom)}
        </button>
      )}
      <Tool label="Responsive View" active={responsive} onClick={onResponsive}>
        <SmartphoneIcon className="size-4" />
      </Tool>
      <Tool label="Developer Tools" command="browser-devtools" active={page.devtools} onClick={onDevTools}>
        <CodeXmlIcon className="size-4" />
      </Tool>
      {page.loading && <span aria-hidden className="browser-progress absolute inset-x-0 -bottom-px h-0.5" />}
    </div>
  );
}

function Tool({
  label,
  command,
  disabled = false,
  active = false,
  onClick,
  children,
}: {
  label: string;
  command?: CommandId;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const title = command ? `${label} (${commandKeys(command)})` : label;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      title={title}
      disabled={disabled}
      // A toolbar click keeps the keyboard where it was: in the page or in the bar.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-35 ${
        active ? "bg-selected text-text" : "text-icon hover:bg-hover hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
