import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 서버가 CORS를 열어 두지 않아 같은 출처로 프록시한다.
// 스트림은 EventSource가 아니라 fetch로 읽어 헤더(토큰·앱 버전)를 직접 싣는다 — 프록시가 헤더를 옮길 필요가 없다.
// WSL2 서버는 Windows에서 localhost(::1)로만 닿는다 — 127.0.0.1로 바꾸지 않는다
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
