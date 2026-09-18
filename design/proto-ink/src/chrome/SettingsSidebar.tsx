import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SETTINGS_SECTIONS } from "@crew/fixtures";
import type { SettingsSectionId } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";
import { useApp } from "@/lib/store";

const SECTION_ICON: Record<SettingsSectionId, IconName> = {
  general: "settings",
  appearance: "palette",
  terminal: "terminal",
  providers: "package",
  keybindings: "keyboard",
  about: "info",
};

/**
 * The settings half of the sidebar. The shell owns the width and the slide; this
 * renders the inner column only.
 */
export function SettingsSidebar() {
  const { page, actions } = useApp();
  const current: SettingsSectionId = page?.kind === "settings" ? page.section : "general";
  const index = SETTINGS_SECTIONS.findIndex((section) => section.id === current);
  const [active, setActive] = useState(() => (index < 0 ? 0 : index));
  const rows = useRef<Array<HTMLDivElement | null>>([]);

  // The page also changes from outside this list (⌘, the hash route, the palette),
  // so the roving tabstop follows the page rather than owning it.
  useEffect(() => {
    if (index >= 0) setActive(index);
  }, [index]);

  const focusAt = useCallback((next: number) => {
    setActive(next);
    rows.current[next]?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = SETTINGS_SECTIONS.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt((active + 1) % count);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusAt((active - 1 + count) % count);
        return;
      case "Home":
        event.preventDefault();
        focusAt(0);
        return;
      case "End":
        event.preventDefault();
        focusAt(count - 1);
        return;
      case "Enter":
      case " ": {
        event.preventDefault();
        const section = SETTINGS_SECTIONS[active];
        if (section) actions.openSettings(section.id);
        return;
      }
      default:
        return;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center px-2">
        <button
          type="button"
          onClick={() => actions.closePage()}
          className={cx(
            "inline-flex h-7 items-center gap-1 rounded-row pl-1 pr-2.5",
            "text-body text-primary transition-colors duration-[var(--dur-2)]",
            "hover:bg-[var(--fill-tertiary)]",
          )}
        >
          <Icon name="chevronLeft" size={16} className="text-icon" />
          <span className="font-[var(--weight-medium)]">Settings</span>
        </button>
      </div>

      <div
        role="listbox"
        aria-label="Settings sections"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-px px-2 pb-2"
      >
        {SETTINGS_SECTIONS.map((section, i) => {
          const selected = section.id === current;
          return (
            <div
              key={section.id}
              ref={(node) => {
                rows.current[i] = node;
              }}
              role="option"
              aria-selected={selected}
              tabIndex={i === active ? 0 : -1}
              onClick={() => {
                setActive(i);
                actions.openSettings(section.id);
              }}
              className={cx(
                "relative flex h-7 cursor-default select-none items-center gap-2 rounded-row pl-2.5 pr-2",
                "text-body transition-colors duration-[var(--dur-2)]",
                selected
                  ? "bg-[var(--fill-tertiary)] text-primary"
                  : "text-secondary hover:bg-[var(--fill-quaternary)] hover:text-primary",
              )}
            >
              {/* The rail marker, not a filled row: selection must not compete with the canvas. */}
              <span
                aria-hidden
                className={cx(
                  "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-[var(--accent)]",
                  "transition-opacity duration-[var(--dur-2)]",
                  selected ? "opacity-100" : "opacity-0",
                )}
              />
              <Icon
                name={SECTION_ICON[section.id]}
                size={16}
                className={selected ? "text-icon-strong" : "text-icon"}
              />
              <span className="min-w-0 flex-1 truncate">{section.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
