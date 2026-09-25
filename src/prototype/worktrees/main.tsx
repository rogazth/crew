// PROTOTYPE entry — served at /prototype.html by the regular vite dev server.
import { IconContext } from "@phosphor-icons/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { Prototype } from "./Prototype";
import "../../index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <IconContext.Provider value={{ weight: "bold", size: "1em" }}>
      <Prototype />
    </IconContext.Provider>
  </React.StrictMode>,
);
