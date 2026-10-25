import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PUBLIC_RETIREMENT_WORKER } from "../../scripts/public-retirement-worker.mjs";
import { PUBLIC_ASSETS } from "../../scripts/public-asset-manifest.mjs";
function publicAssets(): import("vite").Plugin {
  return {
    name: "admitted-public-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(1);
        if (!PUBLIC_ASSETS.some(file => file.path === path)) return next();
        response.setHeader('Content-Type', path.endsWith('.glb') ? 'model/gltf-binary' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/plain; charset=utf-8');
        response.end(readFileSync(resolve(import.meta.dirname, 'public', path)));
      });
    },
    generateBundle() {
      for (const file of PUBLIC_ASSETS) this.emitFile({
        type: "asset" as const,
        fileName: file.path,
        source: readFileSync(resolve(import.meta.dirname, "public", file.path))
      });
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: PUBLIC_RETIREMENT_WORKER
      });
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: JSON.stringify({
          id: "/",
          name: "Meridian — Founding District",
          short_name: "Meridian",
          description: "A fictional city presented from validated public world facts.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#f5f1e8",
          theme_color: "#0a1730",
          icons: []
        })
      });
    }
  };
}
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
  publicDir: false,
  build: {
    target: "esnext",
    sourcemap: false
  },
  plugins: [react(), publicAssets()],
  // Same-origin proxies for both local previews (`vite dev` and `vite preview`).
  // The web app never names another origin; every world route goes to the
  // loopback service. The read-only decision history is served under /world
  // and keeps the browser's Host because the relay checks it exactly.
  server: {
    proxy: {
      "/world": "http://127.0.0.1:8787",
      "/events": "http://127.0.0.1:8787",
      "/presence": { target: "http://127.0.0.1:8787", changeOrigin: false },
      // Object form: the string shorthand sets changeOrigin, which rewrites Host and is refused.
    }
  },
  preview: {
    proxy: {
      "/world": "http://127.0.0.1:8787",
      "/events": "http://127.0.0.1:8787",
      "/presence": { target: "http://127.0.0.1:8787", changeOrigin: false },
      // Object form: the string shorthand sets changeOrigin, which rewrites Host and is refused.
    }
  }
});
