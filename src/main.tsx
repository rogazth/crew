import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { bootChatText } from "./hooks/useChatText";
import { installComposedRangesShim } from "./lib/composedRanges";
import { installWindowTrace } from "./lib/trace";
import "./index.css";
import "./surfaces/chat/chat.css";
import "./surfaces/work.css";

installWindowTrace();
installComposedRangesShim();
bootChatText();

// DEV ONLY: `?widgets` shows the transcript's widgets alone (src/surfaces/chat/Gallery.tsx).
const Gallery =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("widgets")
    ? React.lazy(() => import("./surfaces/chat/Gallery"))
    : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {Gallery ? (
      <React.Suspense fallback={null}>
        <Gallery />
      </React.Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
