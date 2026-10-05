// PROTOTYPE entry — served at /prototype.html by `npm run prototype` (vite on the mock daemon).
import React from "react";
import ReactDOM from "react-dom/client";
import { installComposedRangesShim } from "../../lib/composedRanges";
import { Prototype } from "./Prototype";
import "../../index.css";
import "./proto.css";

installComposedRangesShim();
// The chat loads its markdown renderer lazily; a prototype that opens on a long report should not show it raw first.
void import("../../surfaces/chat/Markdown");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Prototype />
  </React.StrictMode>,
);
