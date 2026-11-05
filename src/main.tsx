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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
