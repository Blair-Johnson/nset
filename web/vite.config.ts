import { defineConfig } from "vite";
import { uplotLogRanges } from "./build/uplot-compat.ts";
export default defineConfig({
  plugins: [uplotLogRanges()],
  // Keep the pinned source visible to the same compatibility transform in dev
  // and production instead of serving an unpatched dependency prebundle.
  optimizeDeps: { exclude: ["uplot"] },
  server: {
    proxy: { "/api": process.env.NSET_API ?? "http://127.0.0.1:8080" },
  },
  build: { target: "es2022" },
});
