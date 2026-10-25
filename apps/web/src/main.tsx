import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { registerProductionServiceWorker } from "./register-service-worker.js";
import "./styles.css";
import { WorldRuntimeProvider } from "./world/use-world.js";

await registerProductionServiceWorker(import.meta.env.PROD, navigator);

createRoot(document.getElementById("root")!).render(
  <WorldRuntimeProvider><App /></WorldRuntimeProvider>,
);
