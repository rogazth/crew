import type { Icon } from "@phosphor-icons/react";
import type { ButtonHTMLAttributes, Ref } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  icon: Icon;
  label: string;
  keys?: string;
  active?: boolean;
};

/** One row of the sidebar's action blocks; also the trigger for the popovers that live there. */
export function SidebarRow({
  icon: Glyph,
  label,
  keys,
  active = false,
  className = "",
  ...rest
}: Props) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      aria-current={active ? "page" : undefined}
      {...rest}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left outline-none transition-colors duration-150 ease-out ${
        active ? "bg-card" : "hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover"
      } ${className}`}
    >
      <Glyph className={`size-4 shrink-0 ${active ? "" : "text-kumo-subtle"}`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && <span className="shrink-0 text-[11px] text-kumo-subtle">{keys}</span>}
    </button>
  );
}
