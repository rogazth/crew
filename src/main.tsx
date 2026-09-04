import { IconContext } from "@phosphor-icons/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installComposedRangesShim } from "./lib/composedRanges";
import "./index.css";

installComposedRangesShim();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* The value replaces Phosphor's whole default context, so size has to come
        along or unsized icons stretch to fill their button. */}
    <IconContext.Provider value={{ weight: "bold", size: "1em" }}>
      <App />
    </IconContext.Provider>
  </React.StrictMode>,
);
