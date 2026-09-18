import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { resolveTheme, store } from "./lib/store";
import "./styles/index.css";

// Before the first paint: no flash of the wrong theme.
document.documentElement.dataset.theme = resolveTheme(store.state.theme);
document.documentElement.dataset.density = store.state.density;
void store.hydrate();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
