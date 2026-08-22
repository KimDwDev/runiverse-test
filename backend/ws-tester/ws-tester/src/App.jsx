import { useRef, useState } from 'react'

const WS_PATH = '/api/v1/ws/running'

// 봉투 단계 — 유스케이스에 닿기 전에 걸러지는 것들
const ENVELOPE_CASES = [
  ['HEALTH_CHECK',      '{"event":"HEALTH_CHECK","data":{}}'],
  ['깨진 JSON',          'this is not json'],
  ['event 없음',         '{"data":{}}'],
  ['event 공백',         '{"event":"   ","data":{}}'],
  ['모르는 타입',        '{"event":"MATCH_REQUEST","data":{}}'],
  ['S→C 전용 타입',      '{"event":"HEALTH_CHECKED","data":{}}'],
]

// 4001은 서버가 정한 값 — 다른 연결이 이어받았다는 뜻이라 클라는 재연결하지 않는다
const CLOSE_REASON = {
  1000: '정상 종료',
  1003: '바이너리 거부(TextWebSocketHandler)',
  1006: '비정상 종료 — 핸드셰이크 실패(401)일 가능성',
  1009: '버퍼 초과',
  1011: '서버 예외',
  4001: '다른 연결이 이어받음 (중복 연결)',
}

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [roomId, setRoomId] = useState('')
  const [open, setOpen] = useState({ A: false, B: false })
  const [logs, setLogs] = useState([])

  const sockets = useRef({ A: null, B: null })
  const heartbeat = useRef(null)

  const log = (kind, text, slot = '-') =>
    setLogs((prev) => [...prev, { kind, text, slot, at: new Date().toLocaleTimeString() }])

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : null
    return { ok: res.ok, status: res.status, body }
  }

  async function login() {
    const { ok, status, body } = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
    if (!ok) return log('error', `로그인 실패 ${status} — ${JSON.stringify(body)}`)
    setToken(body.accessToken)
    log('info', `로그인 성공 — userId=${body.userId}`)
  }

  // 방을 먼저 만들어야 RUNNING_START에 실을 runningRoomId가 생긴다
  async function openSoloRoom() {
    if (!token) return log('error', '먼저 로그인하세요')
    const { ok, status, body } = await api('/api/v1/running-rooms/solo', { method: 'POST' })
    if (!ok) return log('error', `솔로 방 개시 실패 ${status} — ${JSON.stringify(body)}`)
    setRoomId(String(body.runningRoomId))
    // 이 시점 방은 MATCHED, 참가자는 JOINED다 — STARTED로 올리는 건 RUNNING_START다
    log('info', `솔로 방 개시 — runningRoomId=${body.runningRoomId} (MATCHED/JOINED)`)
  }

  function connect(slot) {
    if (!token) return log('error', '먼저 로그인해서 accessToken을 받으세요')
    // 브라우저는 WS에 헤더를 못 붙인다 — vite.config.js의 proxyReqWs 훅이
    // ?token= 을 읽어 Authorization: Bearer 로 바꿔 서버에 넘긴다.
    // 그래서 서버가 보는 건 Flutter와 같은 헤더 인증 경로다
    const url = `ws://${location.host}${WS_PATH}?token=${encodeURIComponent(token)}`
    const socket = new WebSocket(url)
    sockets.current[slot] = socket

    socket.onopen = () => { setOpen((p) => ({ ...p, [slot]: true })); log('info', '연결됨', slot) }
    socket.onmessage = (e) => log('recv', e.data, slot)
    socket.onerror = () => log('error', '전송 오류 (핸드셰이크 401이면 여기로 온다)', slot)
    socket.onclose = (e) => {
      setOpen((p) => ({ ...p, [slot]: false }))
      if (slot === 'A') { clearInterval(heartbeat.current); heartbeat.current = null }
      const why = CLOSE_REASON[e.code] ?? '알 수 없음'
      log('error', `종료 — code=${e.code} (${why}) reason="${e.reason}"`, slot)
    }
  }

  function send(slot, payload) {
    const socket = sockets.current[slot]
    if (socket?.readyState !== WebSocket.OPEN) return log('error', '연결되어 있지 않습니다', slot)
    socket.send(payload)
    log('sent', payload, slot)
  }

  const runningStart = (data) => `{"event":"RUNNING_START","data":${data}}`

  // 재연결·재입장·최초 진입 모두 같은 메시지 — 두 번 보내도 상태가 안 바뀌어야 한다
  function sendStart(slot) {
    if (!roomId) return log('error', '먼저 솔로 방을 개시하거나 roomId를 입력하세요', slot)
    send(slot, runningStart(`{"runningRoomId":${roomId}}`))
  }

  function sendStartTwice(slot) {
    sendStart(slot)
    setTimeout(() => sendStart(slot), 300)
  }

  function sendBinary(slot) {
    sockets.current[slot]?.send(new Uint8Array([1, 2, 3]))
    log('sent', '(binary 3 bytes)', slot)
  }

  function toggleHeartbeat() {
    if (heartbeat.current) {
      clearInterval(heartbeat.current)
      heartbeat.current = null
      return log('info', '자동 헬스 체크 중지')
    }
    // websocket.idle-timeout=2m 이므로 그보다 짧게 보내야 세션이 유지된다
    heartbeat.current = setInterval(() => send('A', ENVELOPE_CASES[0][1]), 30_000)
    log('info', '자동 헬스 체크 시작 — 30초 간격')
  }

  const color = { sent: '#0b6', recv: '#06c', error: '#c33', info: '#666' }
  const row = { marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }

  return (
    <div style={{ fontFamily: 'monospace', padding: 24, maxWidth: 1000 }}>
      <h2>러닝 WebSocket 테스터 — RUNNING_START</h2>

      <section style={row}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>로그인</button>
        <span>{token ? '🔑 토큰 있음' : '🔒 토큰 없음'}</span>
      </section>

      <section style={row}>
        <button onClick={openSoloRoom} disabled={!token}>솔로 방 개시 (POST /running-rooms/solo)</button>
        <input placeholder="runningRoomId" value={roomId} style={{ width: 120 }}
               onChange={(e) => setRoomId(e.target.value)} />
      </section>

      {['A', 'B'].map((slot) => (
        <section key={slot} style={{ ...row, borderTop: '1px solid #ddd', paddingTop: 10 }}>
          <strong style={{ width: 84 }}>소켓 {slot} {open[slot] ? '🟢' : '⚪'}</strong>
          <button onClick={() => connect(slot)} disabled={open[slot]}>연결</button>
          <button onClick={() => sockets.current[slot]?.close(1000, 'client bye')}
                  disabled={!open[slot]}>종료</button>
          <button onClick={() => sendStart(slot)} disabled={!open[slot]}>RUNNING_START</button>
          <button onClick={() => sendStartTwice(slot)} disabled={!open[slot]}>
            RUNNING_START ×2 (멱등)
          </button>
        </section>
      ))}

      <section style={{ ...row, borderTop: '1px solid #ddd', paddingTop: 10 }}>
        <strong style={{ width: 84 }}>실패 케이스</strong>
        <button onClick={() => send('A', runningStart('{}'))} disabled={!open.A}>
          roomId 없음 → INVALID_REQUEST
        </button>
        <button onClick={() => send('A', runningStart('{"runningRoomId":999999}'))} disabled={!open.A}>
          없는 방 → ROOM_NOT_FOUND
        </button>
        <button onClick={() => send('A', runningStart('{"runningRoomId":"abc"}'))} disabled={!open.A}>
          타입 오류 → INVALID_REQUEST
        </button>
      </section>

      <section style={{ ...row, borderTop: '1px solid #ddd', paddingTop: 10 }}>
        <strong style={{ width: 84 }}>봉투 단계</strong>
        {ENVELOPE_CASES.map(([label, payload]) => (
          <button key={label} onClick={() => send('A', payload)} disabled={!open.A}>{label}</button>
        ))}
        <button onClick={() => sendBinary('A')} disabled={!open.A}>바이너리 (1003)</button>
        <button onClick={toggleHeartbeat} disabled={!open.A}>자동 헬스 체크</button>
        <button onClick={() => setLogs([])}>지우기</button>
      </section>

      <pre style={{ background: '#f6f6f6', padding: 12, height: 420, overflow: 'auto' }}>
        {logs.map((entry, i) => (
          <div key={i} style={{ color: color[entry.kind] }}>
            {entry.at} [{entry.slot}] {entry.kind.padEnd(5)} {entry.text}
          </div>
        ))}
      </pre>
    </div>
  )
}
