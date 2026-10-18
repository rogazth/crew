import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installComposedRangesShim } from "./lib/composedRanges";
import "./index.css";

installComposedRangesShim();

// PROTOTYPE — throwaway: `?prototype=chat` opens the chat redesign variants instead of the app.
const ChatRedesignPrototype = React.lazy(() =>
  import("./prototype/chat-redesign/ChatRedesignPrototype").then((m) => ({ default: m.ChatRedesignPrototype })),
);
// PROTOTYPE — throwaway: `?prototype=agent-header` opens the subagent thread header variants.
const AgentHeaderPrototype = React.lazy(() =>
  import("./prototype/agent-header/AgentHeaderPrototype").then((m) => ({ default: m.AgentHeaderPrototype })),
);
// PROTOTYPE — throwaway: `?prototype=system` opens the design system gallery, with a dev bar
// for colourway, theme and a simulated update. In the app those live in Settings › Appearance.
const SystemPrototype = React.lazy(() =>
  import("./prototype/design-system/SystemPrototype").then((m) => ({ default: m.SystemPrototype })),
);
// `?prototype=settings` opens the redesigned settings pages on their own, without crewd.
const SettingsPrototype = React.lazy(() =>
  import("./prototype/design-system/settings/SettingsPrototype").then((m) => ({ default: m.SettingsPrototype })),
);
if (import.meta.env.DEV) {
  void import("./prototype/design-system/directions.css");
  void import("./prototype/design-system/direction").then((m) => m.boot());
}
const prototypeName = import.meta.env.DEV ? new URLSearchParams(location.search).get("prototype") : null;
// In Electron there is no address bar: VITE_CREW_PROTOTYPE=chat does the same.
const prototype =
  import.meta.env.DEV &&
  (new URLSearchParams(location.search).get("prototype") === "chat" || import.meta.env.VITE_CREW_PROTOTYPE === "chat");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {prototypeName === "settings" ? (
      <React.Suspense>
        <SettingsPrototype />
      </React.Suspense>
    ) : prototypeName === "system" ? (
      <React.Suspense>
        <SystemPrototype />
      </React.Suspense>
    ) : prototypeName === "agent-header" ? (
      <React.Suspense>
        <AgentHeaderPrototype />
      </React.Suspense>
    ) : prototype ? (
      <React.Suspense>
        <ChatRedesignPrototype />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
