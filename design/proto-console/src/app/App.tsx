import { useEffect } from "react";
import { Header } from "@/chrome/Header";
import { Sidebar } from "@/chrome/Sidebar";
import { TabStrip } from "@/chrome/TabStrip";
import { StatusLine } from "@/chrome/StatusLine";
import { Overlays } from "@/chrome/Overlays";
import { SurfaceStack } from "@/surfaces/SurfaceStack";
import { installHotkeys } from "@/lib/commands";
import { useHashRoute } from "@/lib/route";
import { resolveTheme, store, useApp } from "@/lib/store";

function useTheme(): void {
  const theme = useApp().theme;
  const density = useApp().density;
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      root.dataset.theme = resolveTheme(theme);
      root.dataset.density = density;
    };
    apply();
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, density]);
}

export function App() {
  const state = useApp();
  useTheme();
  useHashRoute();

  useEffect(() => installHotkeys(), []);

  const sidebarWidth = state.sidebar.collapsed ? 0 : state.sidebar.width;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-ink">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div
          className="flex min-w-0 flex-1 flex-col"
          style={{ borderLeft: sidebarWidth ? "1px solid var(--rule)" : "none" }}
        >
          <TabStrip />
          <main className="relative min-h-0 flex-1 overflow-hidden">
            <SurfaceStack />
          </main>
        </div>
      </div>
      <StatusLine />
      <Overlays />
      <Toast />
    </div>
  );
}

function Toast() {
  const toast = useApp().toast;
  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    const timer = window.setTimeout(() => store.clearToast(id), 2_400);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      role="status"
      style={{ animation: "slide-up var(--base) var(--ease) both" }}
      className="float pointer-events-none fixed bottom-[calc(var(--h-status)+12px)] left-1/2 z-50 -translate-x-1/2 px-3 py-1 font-mono text-sm text-ink-2"
    >
      {toast.text}
    </div>
  );
}
