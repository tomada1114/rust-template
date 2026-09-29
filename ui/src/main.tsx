import "./design/tokens.css";
import "./design/base.css";
import "./design/primitives.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CounterScreen } from "./counter/CounterScreen";

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <CounterScreen />
    </StrictMode>,
  );
}
