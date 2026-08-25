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

// 부산 어딘가 — 순번이 늘수록 북쪽으로 약 2m씩 이동시킨다
const BASE = { lat: 35.17955, lng: 129.07564 }

// 서버가 LocalDateTime으로 받으므로 UTC(toISOString)가 아니라 로컬 시각이어야 한다
const localIso = (date = new Date()) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)

// api-spec 5-D의 좌표 한 개
const samplePoint = (seq) => ({
  sequence: seq,
  latitude: Number((BASE.lat + seq * 0.00002).toFixed(7)),
  longitude: BASE.lng,
  altitudeMeters: 18.4,
  accuracyMeters: 6.2,
  speedMetersPerSecond: 2.8,
  headingDegrees: 0,
  cadenceSpm: 165,
  currentPaceSecondsPerKm: 345,
  recordedAt: localIso(new Date(Date.now() + seq * 1000)),
})

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [roomId, setRoomId] = useState('')
  const [open, setOpen] = useState({ A: false, B: false })
  const [logs, setLogs] = useState([])
  const [trackSize, setTrackSize] = useState(0)   // 보낸 좌표 총 개수 (표시용)

  const sockets = useRef({ A: null, B: null })
  const heartbeat = useRef(null)

  const sequence = useRef(0)          // 러닝 내 좌표 순번 — 계속 증가
  const lastBatch = useRef([])        // 직전 배치 (중복 재전송용)
  const allPoints = useRef([])        // 전체 트랙 (재연결 시나리오용)
  const locationTimer = useRef(null)

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
    resetSequence()   // 방이 바뀌면 순번도 처음부터다
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
      if (slot === 'A') {
        clearInterval(heartbeat.current); heartbeat.current = null
        clearInterval(locationTimer.current); locationTimer.current = null
      }
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

  // ── 위치 전송 ──────────────────────────────────────────────
  // 성공해도 ack가 없다(api-spec 5-D) — 화면은 조용하고 확인은 redis-cli로 한다

  function sendLocations(slot, locations) {
    if (!roomId) return log('error', '먼저 솔로 방을 개시하세요', slot)
    send(slot, JSON.stringify({
      event: 'RUNNING_LOCATION_UPDATE',
      data: { runningRoomId: Number(roomId), locations },
    }))
  }

  // 클라는 1~2초 간격으로 모아 10초마다 보낸다 — 배치 하나에 5개
  function sendNextBatch(slot, count = 5) {
    const batch = []
    for (let i = 0; i < count; i += 1) {
      batch.push(samplePoint(sequence.current))
      sequence.current += 1
    }
    lastBatch.current = batch
    allPoints.current = [...allPoints.current, ...batch]
    setTrackSize(allPoints.current.length)
    sendLocations(slot, batch)
  }

  // 직전 배치를 그대로 다시 — 전부 중복이라 Redis에 아무것도 안 쌓여야 한다
  function resendLastBatch(slot) {
    if (!lastBatch.current.length) return log('error', '먼저 배치를 보내세요', slot)
    sendLocations(slot, lastBatch.current)
  }

  // 재연결 시나리오 — 클라가 처음 sequence부터 전부 다시 보낸다(api-spec 5-D)
  function resendAll(slot) {
    if (!allPoints.current.length) return log('error', '먼저 배치를 보내세요', slot)
    sendLocations(slot, allPoints.current)
  }

  function toggleAutoLocation(slot) {
    if (locationTimer.current) {
      clearInterval(locationTimer.current)
      locationTimer.current = null
      return log('info', '자동 위치 전송 중지')
    }
    sendNextBatch(slot)
    locationTimer.current = setInterval(() => sendNextBatch(slot), 10_000)
    log('info', '자동 위치 전송 시작 — 10초 간격')
  }

  function resetSequence() {
    sequence.current = 0
    lastBatch.current = []
    allPoints.current = []
    setTrackSize(0)
  }

  const color = { sent: '#0b6', recv: '#06c', error: '#c33', info: '#666' }
  const row = { marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }
  const divider = { ...row, borderTop: '1px solid #ddd', paddingTop: 10 }

  return (
    <div style={{ fontFamily: 'monospace', padding: 24, maxWidth: 1000 }}>
      <h2>러닝 WebSocket 테스터 — RUNNING_START · LOCATION_UPDATE</h2>

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
        <section key={slot} style={divider}>
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

      <section style={divider}>
        <strong style={{ width: 84 }}>위치 전송</strong>
        <button onClick={() => sendNextBatch('A')} disabled={!open.A}>
          배치 전송 (5개)
        </button>
        <button onClick={() => resendLastBatch('A')} disabled={!open.A}>
          직전 배치 재전송 → 0개 적재
        </button>
        <button onClick={() => resendAll('A')} disabled={!open.A}>
          처음부터 전부 재전송 (재연결)
        </button>
        <button onClick={() => toggleAutoLocation('A')} disabled={!open.A}>
          자동 전송 10초
        </button>
        <button onClick={resetSequence}>순번 초기화</button>
        <span>보낸 좌표 {trackSize}개</span>
      </section>

      <section style={divider}>
        <strong style={{ width: 84 }}>위치 실패</strong>
        <button onClick={() => sendLocations('A', [])} disabled={!open.A}>
          빈 배열 → INVALID_REQUEST
        </button>
        <button onClick={() => sendLocations('A', [{ ...samplePoint(0), latitude: 999 }])}
                disabled={!open.A}>
          위도 999 → INVALID_REQUEST
        </button>
        <button onClick={() => sendLocations('A', [{ ...samplePoint(0), recordedAt: null }])}
                disabled={!open.A}>
          시각 없음 → INVALID_REQUEST
        </button>
        <button onClick={() => sendLocations('A', [{ ...samplePoint(0), sequence: null }])}
                disabled={!open.A}>
          순번 없음 → INVALID_REQUEST
        </button>
      </section>

      <section style={divider}>
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

      <section style={divider}>
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
