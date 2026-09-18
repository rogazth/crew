import { useEffect } from "react";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@crew/fixtures";
import { Kbd } from "@/ui";
import { store } from "@/lib/store";
import { General } from "./General";
import { Appearance } from "./Appearance";
import { TerminalSettings } from "./TerminalSettings";
import { Providers } from "./Providers";
import { Keybindings } from "./Keybindings";
import { About } from "./About";

const NOTE: Record<SettingsSectionId, string> = {
  general: "Where Crew starts, and what a new agent inherits.",
  appearance: "Theme, density and the marks agents are drawn with.",
  terminal: "How every terminal in the window renders.",
  providers: "Which CLIs the daemon found on PATH, and what they offer.",
  keybindings: "Every chord the window listens for. All of them are editable.",
  about: "What this build is, and what is not behind it yet.",
};

export function SettingsPage({ section }: { section: SettingsSectionId }) {
  useEffect(() => {
    // Bubble phase on purpose: a menu, a dialog or a chord recording swallows
    // Escape in the capture phase first, and only a free Escape closes the page.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      store.closePage();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const label = SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label ?? section;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[var(--h-tabs)] shrink-0 items-center gap-1.5 border-b border-rule px-3 font-mono text-sm">
        <span className="text-ink-4">settings</span>
        <span className="text-ink-4" aria-hidden>
          ▸
        </span>
        <span className="text-ink">{label.toLowerCase()}</span>
        <button
          type="button"
          onClick={() => store.closePage()}
          className="ml-auto flex items-center gap-1.5 text-ink-3 transition-colors duration-[var(--fast)] hover:text-ink"
        >
          <span>close</span>
          <Kbd>Esc</Kbd>
        </button>
      </header>

      <div className="scroll min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-[768px] flex-col gap-5 px-6 pt-8 pb-16">
          <div className="flex flex-col gap-1">
            <h1 className="font-mono text-xl text-ink">{label}</h1>
            <p className="text-sm text-ink-3">{NOTE[section]}</p>
          </div>
          {section === "general" ? <General /> : null}
          {section === "appearance" ? <Appearance /> : null}
          {section === "terminal" ? <TerminalSettings /> : null}
          {section === "providers" ? <Providers /> : null}
          {section === "keybindings" ? <Keybindings /> : null}
          {section === "about" ? <About /> : null}
        </div>
      </div>
    </div>
  );
}
