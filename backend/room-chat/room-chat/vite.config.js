import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api만 백엔드로 넘긴다 — 같은 출처가 되어 CORS가 없다.
// 토큰은 앱이 Authorization 헤더로 직접 싣는다(SSE도 fetch라 헤더를 실을 수 있다) — 프록시가 옮기지 않는다.
// localhost 고정: WSL 릴레이가 ::1에만 붙어 127.0.0.1은 실패한다
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        // SSE를 모아 두지 않고 바로 흘린다
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (String(proxyRes.headers["content-type"] ?? "").includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
