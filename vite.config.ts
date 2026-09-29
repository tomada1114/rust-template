import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI lives in ui/; its build lands in dist/, which tauri.conf.json's frontendDist
// names. Port 1420 is Tauri's convention and must match build.devUrl.
export default defineConfig({
  root: "ui",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // WKWebView on macOS 14, the minimum system version (tauri.conf.json).
    target: "safari17",
  },
});
