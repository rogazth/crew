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
const prototypeName = import.meta.env.DEV ? new URLSearchParams(location.search).get("prototype") : null;
// In Electron there is no address bar: VITE_CREW_PROTOTYPE=chat does the same.
const prototype =
  import.meta.env.DEV &&
  (new URLSearchParams(location.search).get("prototype") === "chat" || import.meta.env.VITE_CREW_PROTOTYPE === "chat");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {prototypeName === "agent-header" ? (
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
