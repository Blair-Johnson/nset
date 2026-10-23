import { defineConfig } from "vite";
export default defineConfig({
  server: {
    proxy: { "/api": process.env.NSET_API ?? "http://127.0.0.1:8080" },
  },
  build: { target: "es2022" },
});
