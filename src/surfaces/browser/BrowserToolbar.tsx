import { ArrowClockwiseIcon, ArrowLeftIcon, ArrowRightIcon, BracketsAngleIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode, Ref } from "react";
import { commandKeys, type CommandId } from "../../lib/commands";
import type { PageState } from "../../lib/browser/pageStore";
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
          <ArrowClockwiseIcon className="size-4" />
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
      <Tool label="Developer Tools" command="browser-devtools" active={page.devtools} onClick={onDevTools}>
        <BracketsAngleIcon className="size-4" />
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
        active ? "bg-selected text-text" : "text-text-muted hover:bg-hover hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
