import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExcalidrawApp from "../packages/excalidraw/ExcalidrawApp";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";
window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();
root.render(
  <StrictMode>
    <ExcalidrawApp
      excalidraw={{aiEnabled:false,UIOptions:{canvasActions:{export:false,loadScene:false,saveToActiveFile:false}}}}
      collabServerUrl="http://localhost:3002"
      storageServerUrl="http://localhost:8090"
    />
  </StrictMode>,
);
