import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The local linked Spark package can otherwise pull in its own THREE instance,
    // which breaks shader chunk registration in production builds.
    dedupe: ["three"],
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["@sparkjsdev/spark"],
  },
});
