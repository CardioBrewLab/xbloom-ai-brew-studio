import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export function resolveApiProxyTarget(value: string | undefined): string {
  const target = value?.trim() || "http://127.0.0.1:8787";
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error("VITE_API_PROXY_TARGET must be an absolute HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    !parsed.hostname ||
    (parsed.port &&
      (!Number.isInteger(Number(parsed.port)) ||
        Number(parsed.port) < 1 ||
        Number(parsed.port) > 65535))
  ) {
    throw new Error(
      "VITE_API_PROXY_TARGET must be an HTTP(S) origin without credentials, path, query, or hash.",
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = resolveApiProxyTarget(
    process.env.VITE_API_PROXY_TARGET || env.VITE_API_PROXY_TARGET,
  );
  return {
    plugins: [react(), tailwindcss()],
    build: {
      // The 544 kB ECharts renderer is an intentional on-demand chunk; the
      // initial workbench bundle remains below 500 kB and never preloads it.
      chunkSizeWarningLimit: 560,
    },
    server: {
      proxy: {
        // watchdog-xbloom.ps1 supplies the configured backend port.
        "/api": { target },
      },
    },
  };
});
