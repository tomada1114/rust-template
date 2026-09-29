import "./design/tokens.css";
import "./design/base.css";
import "./design/primitives.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CounterScreen } from "./counter/CounterScreen";
import { logUnhandledErrors, rootErrorLogging } from "./ipc/log";

logUnhandledErrors(window);

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container, rootErrorLogging).render(
    <StrictMode>
      <CounterScreen />
    </StrictMode>,
  );
}
