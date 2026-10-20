import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { bootAccent } from "./hooks/useAccent";
import { bootChatText } from "./hooks/useChatText";
import { installComposedRangesShim } from "./lib/composedRanges";
import "./index.css";
import "./surfaces/chat/chat.css";
import "./surfaces/work.css";

installComposedRangesShim();
bootAccent();
bootChatText();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
