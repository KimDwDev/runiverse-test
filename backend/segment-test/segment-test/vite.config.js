import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 서버 주소 — WSL 안에서 vite를 띄우면 그대로 localhost:8080이다
const TARGET = process.env.API_TARGET || 'http://localhost:8080'

// 브라우저 WebSocket은 Authorization 헤더를 못 단다 — 서버 핸드셰이크는 Bearer 헤더만 본다.
// ?token= 쿼리를 헤더로 옮겨 넣고, Origin은 지워 서버의 출처·CORS 검사를 피한다(같은 출처로 보인다)
function attachAuth(proxy) {
  const rewrite = (proxyReq, req) => {
    proxyReq.removeHeader('origin')
    const url = new URL(req.url, 'http://local')
    const token = url.searchParams.get('token')
    if (token) {
      proxyReq.setHeader('Authorization', `Bearer ${token}`)
    }
  }
  proxy.on('proxyReq', rewrite)
  proxy.on('proxyReqWs', rewrite)
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api/v1': { target: TARGET, changeOrigin: true, ws: true, configure: attachAuth },
    },
  },
})
