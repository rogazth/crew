import React from "react";
import ReactDOM from "react-dom/client";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { App } from "./App";
import { installComposedRangesShim } from "./lib/composedRanges";
import { LANGS } from "./lib/highlighting";
import "./index.css";

installComposedRangesShim();

// Tokenizing on the main thread froze the window on a 14k-line composer.lock.
// The pool moves it off-thread; `langs` keeps Shiki from pulling every grammar.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize: 4 }}
      highlighterOptions={{ langs: LANGS }}
    >
      <App />
    </WorkerPoolContextProvider>
  </React.StrictMode>,
);
