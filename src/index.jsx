import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/geist";
import App from "./App";
import "./tailwind.css";
import { initDarkMode } from "./lib/theme";
import { initMonitoring } from "./lib/monitoring";

// Before first render, so a saved dark preference is already on <html> and
// the app never paints light-then-dark.
initDarkMode();

// Before render too, so a throw during the very first paint is still caught.
initMonitoring();

const rootElement = document.getElementById("root");
const root = createRoot(rootElement);

root.render(
  <StrictMode>
    <App />
  </StrictMode>
);
