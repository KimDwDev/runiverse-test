import { useRef, useState } from 'react'

const CASES = [
  ['정상 — HEALTH_CHECK',   '{"event":"HEALTH_CHECK","data":{}}'],
  ['깨진 JSON',              'this is not json'],
  ['event 없음',             '{"data":{}}'],
  ['event 공백',             '{"event":"   ","data":{}}'],
  ['모르는 타입',            '{"event":"MATCH_REQUEST","data":{}}'],
  ['S→C 전용 타입',          '{"event":"HEALTH_CHECKED","data":{}}'],
]

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [connected, setConnected] = useState(false)
  const [logs, setLogs] = useState([])
  const socketRef = useRef(null)
  const heartbeatRef = useRef(null)

  const log = (kind, text) =>
    setLogs((prev) => [...prev, { kind, text, at: new Date().toLocaleTimeString() }])

  async function login() {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await res.json()
    if (!res.ok) return log('error', `로그인 실패 ${res.status} — ${JSON.stringify(body)}`)
    setToken(body.accessToken)
    log('info', `로그인 성공 — userId=${body.userId}`)
  }

  function connect() {
    if (!token) return log('error', '먼저 로그인해서 accessToken을 받으세요')
    const url = `ws://${location.host}/api/v1/ws/running?token=${encodeURIComponent(token)}`
    const socket = new WebSocket(url)
    socketRef.current = socket

    socket.onopen = () => { setConnected(true); log('info', `연결됨 — ${url.split('?')[0]}`) }
    socket.onmessage = (e) => log('recv', e.data)
    socket.onerror = () => log('error', '전송 오류 (핸드셰이크 401이면 여기로 온다)')
    socket.onclose = (e) => {
      setConnected(false)
      clearInterval(heartbeatRef.current)
      // 1000 정상 / 1011 서버 예외 / 1003 바이너리 거부 / 1009 버퍼 초과
      log('error', `연결 종료 — code=${e.code} reason="${e.reason}" wasClean=${e.wasClean}`)
    }
  }

  function send(payload) {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN) return log('error', '연결되어 있지 않습니다')
    socket.send(payload)
    log('sent', payload)
  }

  function sendBinary() {
    // TextWebSocketHandler는 바이너리를 1003으로 끊는다 — 그 동작 확인용
    socketRef.current?.send(new Uint8Array([1, 2, 3]))
    log('sent', '(binary 3 bytes)')
  }

  function toggleHeartbeat() {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
      log('info', '자동 헬스 체크 중지')
      return
    }
    // websocket.idle-timeout=2m 이므로 그보다 짧게 보내야 세션이 유지된다
    heartbeatRef.current = setInterval(() => send(CASES[0][1]), 30_000)
    log('info', '자동 헬스 체크 시작 — 30초 간격')
  }

  const color = { sent: '#0b6', recv: '#06c', error: '#c33', info: '#666' }

  return (
    <div style={{ fontFamily: 'monospace', padding: 24, maxWidth: 900 }}>
      <h2>러닝 WebSocket 테스터</h2>

      <section style={{ marginBottom: 16 }}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>로그인</button>
        <button onClick={connect} disabled={connected}>연결</button>
        <button onClick={() => socketRef.current?.close(1000, 'client bye')} disabled={!connected}>
          연결 종료
        </button>
        <span style={{ marginLeft: 12 }}>{connected ? '🟢 연결됨' : '⚪ 끊김'}</span>
      </section>

      <section style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {CASES.map(([label, payload]) => (
          <button key={label} onClick={() => send(payload)} disabled={!connected}>{label}</button>
        ))}
        <button onClick={sendBinary} disabled={!connected}>바이너리 (1003 확인)</button>
        <button onClick={toggleHeartbeat} disabled={!connected}>자동 헬스 체크 on/off</button>
        <button onClick={() => setLogs([])}>지우기</button>
      </section>

      <pre style={{ background: '#f6f6f6', padding: 12, height: 420, overflow: 'auto' }}>
        {logs.map((entry, i) => (
          <div key={i} style={{ color: color[entry.kind] }}>
            {entry.at} {entry.kind.padEnd(5)} {entry.text}
          </div>
        ))}
      </pre>
    </div>
  )
}
