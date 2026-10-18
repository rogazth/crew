// PROTOTYPE — throwaway. `?prototype=settings`: the redesigned settings window
// on its own, nav and page, with no daemon behind it. `&page=<id>` opens a page
// directly; the dev bar at the bottom flips direction, theme and the update.
import { useCallback, useEffect, useState } from "react";
import { BotAvatarProvider } from "../../../hooks/useBotAvatar";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../../../lib/settings";
import { DirectionBar } from "../DirectionBar";
import { applyDirection, readDirection } from "../direction";
import { SettingsNav } from "./SettingsNav";
import { RedesignedSettingsPage } from "./SettingsPages";
import { toast } from "./ui";

function initialPage(): SettingsSectionId {
  const page = new URLSearchParams(location.search).get("page");
  return SETTINGS_SECTIONS.some((s) => s.id === page) ? (page as SettingsSectionId) : "general";
}

export function SettingsPrototype() {
  const [section, setSection] = useState<SettingsSectionId>(initialPage);

  // The redesign is what this route shows; "Today" has no pages to show here.
  useEffect(() => {
    if (readDirection() === "off") applyDirection("a");
  }, []);

  const select = useCallback((next: SettingsSectionId) => {
    setSection(next);
    const url = new URL(location.href);
    url.searchParams.set("page", next);
    history.replaceState(null, "", url);
  }, []);

  return (
    <BotAvatarProvider>
      <div className="flex h-screen bg-sidebar text-text">
        <aside data-sidebar="sidebar" className="flex w-[248px] shrink-0 flex-col bg-sidebar">
          <div data-tauri-drag-region className="flex h-[39px] shrink-0 items-center gap-2 px-4">
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span key={c} className="size-3 rounded-full" style={{ background: c }} />
            ))}
          </div>
          <div className="min-h-0 flex-1">
            <SettingsNav section={section} onSelect={select} onClose={() => toast("Back to your sessions", "info")} />
          </div>
        </aside>
        <main className="min-w-0 flex-1 bg-canvas">
          <RedesignedSettingsPage section={section} standalone />
        </main>
      </div>
      <DirectionBar keys />
    </BotAvatarProvider>
  );
}
