import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The 544 kB ECharts renderer is an intentional on-demand chunk; the
    // initial workbench bundle remains below 500 kB and never preloads it.
    chunkSizeWarningLimit: 560,
  },
  server: {
    proxy: {
      // 后端 API 一律代理到本地 Express（server/ workspace）
      "/api": "http://127.0.0.1:8787",
    },
  },
});
