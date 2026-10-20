import React, { useRef, useState } from 'react'

// ═══════════════════════════════════════════════════════════════
//  Runiverse 경로 조각(segment) · 일시정지(pauseSegment) 시나리오 하네스
//  1) 이메일·비밀번호 입력 → 2) 시나리오 "실행" → 3) ✅/❌ 확인
// ═══════════════════════════════════════════════════════════════

const EARTH_RADIUS_METERS = 6_371_008.8
const METERS_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_METERS
const BATCH_SIZE = 10            // 앱처럼 10초치(1Hz)씩 묶어 보낸다
const BATCH_GAP_MS = 80          // 배치 사이 간격 — 순서대로 처리되게 조금 띄운다

// 서버 APP_TIME_ZONE(KST)과 같은 시간대의 오프셋 없는 ISO
function localIso(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const today = () => localIso(new Date()).slice(0, 10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 북쪽으로 일정 속도로 달리는 구간 하나를 만든다 — 1초에 좌표 하나
function runLeg({ fromSequence, pauseSegment, startTime, startLat, lng, altitude, seconds, speed }) {
  const points = []
  for (let i = 0; i <= seconds; i++) {
    points.push({
      sequence: fromSequence + i,
      latitude: Number((startLat + (i * speed) / METERS_PER_DEGREE_LAT).toFixed(7)),
      longitude: lng,
      altitudeMeters: altitude,
      accuracyMeters: 5.0,
      speedMetersPerSecond: speed,
      headingDegrees: 0,
      cadenceSpm: 170,
      currentPaceSecondsPerKm: Math.round(1000 / speed),
      recordedAt: localIso(new Date(startTime.getTime() + i * 1000)),
      pauseSegment,
    })
  }
  return points
}

const lastOf = (points) => points[points.length - 1]

// 달리기 60초 → 일시정지(30초 동안 200m 옮기고 30m 오름) → 재개 후 60초.
// 시각은 과거로 미리 만들어 바로 보낸다 — 실시간으로 2분을 기다리지 않는다
function pausedRunTrack() {
  const speed = 3.0
  const start = new Date(Date.now() - 200 * 1000)
  const before = runLeg({
    fromSequence: 0, pauseSegment: 0, startTime: start,
    startLat: 37.5665, lng: 126.978, altitude: 30, seconds: 60, speed,
  })
  const after = runLeg({
    fromSequence: lastOf(before).sequence + 1, pauseSegment: 1,
    startTime: new Date(start.getTime() + 90 * 1000),
    startLat: lastOf(before).latitude + 200 / METERS_PER_DEGREE_LAT,
    lng: 126.978, altitude: 60, seconds: 60, speed,
  })
  return { before, after, ranMeters: 120 * speed, pauseMoveMeters: 200 }
}

// ───────── 지도(SVG) ─────────

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c']

function RouteMap({ title, segments = [], dots = [] }) {
  const width = 300
  const height = 200
  const all = [...segments.flat(), ...dots]
  if (!all.length) return <div style={s.muted}>{title}: 경로 없음</div>
  const lats = all.map((p) => p[0])
  const lngs = all.map((p) => p[1])
  const minLat = Math.min(...lats)
  const minLng = Math.min(...lngs)
  const lngScale = Math.cos(((minLat + Math.max(...lats)) / 2) * (Math.PI / 180))
  const spanX = Math.max((Math.max(...lngs) - minLng) * lngScale, 1e-6)
  const spanY = Math.max(Math.max(...lats) - minLat, 1e-6)
  const scale = Math.min((width - 20) / spanX, (height - 20) / spanY)
  const at = ([lat, lng]) => [10 + (lng - minLng) * lngScale * scale, height - 10 - (lat - minLat) * scale]
  return (
    <div style={{ display: 'inline-block', marginRight: 12 }}>
      <div style={s.muted}>{title}</div>
      <svg width={width} height={height} style={s.map}>
        {segments.map((segment, i) => {
          const color = COLORS[i % COLORS.length]
          const points = segment.map(at)
          if (points.length === 1) return <circle key={i} cx={points[0][0]} cy={points[0][1]} r={4} fill={color} />
          return <polyline key={i} fill="none" stroke={color} strokeWidth={3} points={points.map((p) => p.join(',')).join(' ')} />
        })}
        {dots.map((dot, i) => {
          const [x, y] = at(dot)
          return <circle key={`d${i}`} cx={x} cy={y} r={7} fill="none" stroke="#000" strokeWidth={1.5} />
        })}
      </svg>
    </div>
  )
}

// ───────── 서버 연결 ─────────

// REST·WS 한 세션. 메시지를 기다리는 waitFor로 시나리오를 순서대로 쓴다
function createClient(token, log) {
  let ws = null
  let waiters = []
  const received = []

  const api = async (method, path, body) => {
    const response = await fetch(`/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    log(`REST ${method} ${path} → ${response.status}`)
    if (!response.ok) throw new Error(`${method} ${path} 실패: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  const connect = () => new Promise((resolve, reject) => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${scheme}://${window.location.host}/api/v1/ws/running?token=${encodeURIComponent(token)}`)
    ws.onopen = () => { log('WS 연결됨'); resolve() }
    ws.onerror = () => reject(new Error('WS 연결 실패 — 서버가 떠 있는지, 토큰이 맞는지 확인'))
    ws.onclose = (e) => log(`WS 닫힘 code=${e.code}`)
    ws.onmessage = (raw) => {
      const message = JSON.parse(raw.data)
      received.push(message)
      log(`← ${message.event} ${JSON.stringify(message.data)}`)
      waiters = waiters.filter((w) => !(w.match(message) && (w.resolve(message), true)))
    }
  })

  const send = (event, data = {}) => {
    ws.send(JSON.stringify({ event, data }))
    if (event === 'RUNNING_LOCATION_UPDATE') {
      const l = data.locations
      log(`→ 좌표 ${l.length}개 (seq ${l[0].sequence}~${lastOf(l).sequence}, pauseSegment ${l[0].pauseSegment}~${lastOf(l).pauseSegment})`)
    } else {
      log(`→ ${event} ${JSON.stringify(data)}`)
    }
  }

  // 조건에 맞는 메시지가 올 때까지 기다린다 — 이미 받은 것도 본다
  const waitFor = (match, timeoutMs = 5000, what = '메시지') => {
    const already = received.find(match)
    if (already) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve }
      waiters.push(waiter)
      setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter)
        reject(new Error(`${what}을(를) ${timeoutMs / 1000}초 안에 받지 못함`))
      }, timeoutMs)
    })
  }

  const sendTrack = async (points) => {
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      send('RUNNING_LOCATION_UPDATE', { locations: points.slice(i, i + BATCH_SIZE) })
      await sleep(BATCH_GAP_MS)
    }
  }

  const close = () => ws && ws.close()
  const clearReceived = () => received.splice(0)

  return { api, connect, send, waitFor, sendTrack, close, clearReceived, received }
}

// 솔로 방을 열고 WS로 러닝을 시작한다
async function startSoloRun(client) {
  const { runningRoomId } = await client.api('POST', '/running-rooms/solo')
  await client.connect()
  client.send('RUNNING_START', { runningRoomId })
  await client.waitFor((m) => m.event === 'RUNNING_STARTED', 5000, 'RUNNING_STARTED')
  return runningRoomId
}

async function finishRun(client) {
  client.send('RUNNING_FINISH', { forced: true })
  await client.waitFor((m) => m.event === 'RUNNING_FINISHED', 8000, 'RUNNING_FINISHED')
}

const errorOf = (code) => (m) => m.event === 'ERROR' && m.data.code === code

// ───────── 시나리오 ─────────
// 각 시나리오는 check(이름, 통과 여부, 실제값)를 부르고, 화면에 그릴 것을 돌려준다

const SCENARIOS = [
  {
    id: 'pause',
    title: '① 일시정지가 기록과 경로에서 빠지는가',
    description: '60초 달리기 → 일시정지(그동안 200m 이동, 30m 오름) → 재개 후 60초 → 종료. 6-1·6-2·7-1을 조회해 확인한다.',
    run: async (client, check) => {
      const { before, after, ranMeters, pauseMoveMeters } = pausedRunTrack()
      const roomId = await startSoloRun(client)
      await client.sendTrack([...before, ...after])
      await sleep(500)
      await finishRun(client)

      const results = await client.api('GET', `/running-rooms/${roomId}/results`)
      const me = results.players.find((p) => p.isMe)
      const routes = results.routes ?? []
      check('6-1 routes가 조각 2개로 나뉜다', routes.length === 2, `조각 ${routes.length}개 (${routes.map((r) => `${r.length}점`).join(', ')})`)
      check(`6-1 거리에 일시정지 중 이동 ${pauseMoveMeters}m가 없다 (뛴 거리 약 ${ranMeters}m)`,
        me.totalDistanceMeters >= ranMeters - 30 && me.totalDistanceMeters <= ranMeters + 10,
        `${me.totalDistanceMeters}m`)
      check('6-1 움직인 시간에 일시정지 30초가 없다 (약 120초)',
        me.totalDurationSeconds >= 100 && me.totalDurationSeconds <= 125, `${me.totalDurationSeconds}초`)
      check('6-1 누적 상승에 일시정지 중 오른 30m가 없다', !me.totalElevationGainMeters,
        `${me.totalElevationGainMeters}m`)

      const splits = await client.api('GET', `/running-rooms/${roomId}/split-results`)
      const single = splits.splits.filter((sp) => sp.routes && sp.routes.length === 1)
      check('6-2 끊긴 곳에 걸친 구간 1개가 점 하나만 갖는다', single.length === 1,
        `점 하나 구간 ${single.map((sp) => `#${sp.splitNumber}`).join(', ') || '없음'} / 전체 ${splits.splits.length}개`)

      const records = await client.api('GET', `/users/me/running-records?from=${today()}&to=${today()}`)
      const record = records.runningRecords.find((r) => r.runningRoomId === roomId)
      check('7-1 목록에 이 기록이 있다', !!record, record ? `기록 #${record.runningRecordId}` : '없음')
      check('7-1 목록은 경로를 싣지 않는다 (routePolyline 없음)', !!record && !('routePolyline' in record),
        record ? Object.keys(record).join(', ') : '기록 없음')

      return {
        maps: [
          { title: '6-1 routes (조각마다 색)', segments: routes },
          { title: '6-2 구간 (원 = 점 하나 구간)', segments: splits.splits.map((sp) => sp.routes).filter(Boolean), dots: single.map((sp) => sp.routes[0]) },
        ],
      }
    },
  },
  {
    id: 'decrease-in-batch',
    title: '② 배치 안에서 pauseSegment가 줄면 거부되는가',
    description: '정상 배치를 하나 보낸 뒤, 순번 순으로 1 → 0으로 줄어드는 배치를 보낸다.',
    run: async (client, check) => {
      const { before } = pausedRunTrack()
      await startSoloRun(client)
      await client.sendTrack(before.slice(0, 10))
      const next = before[10].sequence
      client.send('RUNNING_LOCATION_UPDATE', {
        locations: [{ ...before[10], sequence: next, pauseSegment: 1 }, { ...before[11], sequence: next + 1, pauseSegment: 0 }],
      })
      const error = await client.waitFor(errorOf('PAUSE_SEGMENT_DECREASED'), 5000, 'ERROR PAUSE_SEGMENT_DECREASED').catch((e) => e)
      check('ERROR PAUSE_SEGMENT_DECREASED를 받는다', !(error instanceof Error), error instanceof Error ? error.message : error.data.message)
      await finishRun(client).catch(() => {})
      return {}
    },
  },
  {
    id: 'decrease-from-stored',
    title: '③ 이전 배치보다 pauseSegment가 줄면 거부되는가',
    description: 'pauseSegment 1로 배치를 보낸 뒤, 다음 순번을 pauseSegment 0으로 보낸다.',
    run: async (client, check) => {
      const { before } = pausedRunTrack()
      await startSoloRun(client)
      await client.sendTrack(before.slice(0, 10).map((p) => ({ ...p, pauseSegment: 1 })))
      client.send('RUNNING_LOCATION_UPDATE', { locations: before.slice(10, 20).map((p) => ({ ...p, pauseSegment: 0 })) })
      const error = await client.waitFor(errorOf('PAUSE_SEGMENT_DECREASED'), 5000, 'ERROR PAUSE_SEGMENT_DECREASED').catch((e) => e)
      check('ERROR PAUSE_SEGMENT_DECREASED를 받는다', !(error instanceof Error), error instanceof Error ? error.message : error.data.message)
      await finishRun(client).catch(() => {})
      return {}
    },
  },
  {
    id: 'missing',
    title: '④ pauseSegment를 빼고 보내면 거부되는가',
    description: 'pauseSegment 칸이 없는 좌표 하나를 보낸다(옛 앱).',
    run: async (client, check) => {
      const { before } = pausedRunTrack()
      await startSoloRun(client)
      const { pauseSegment, ...withoutPause } = before[0]
      client.send('RUNNING_LOCATION_UPDATE', { locations: [withoutPause] })
      const error = await client.waitFor(errorOf('INVALID_REQUEST'), 5000, 'ERROR INVALID_REQUEST').catch((e) => e)
      check('ERROR INVALID_REQUEST를 받는다', !(error instanceof Error), error instanceof Error ? error.message : error.data.message)
      await finishRun(client).catch(() => {})
      return {}
    },
  },
  {
    id: 'resend',
    title: '⑤ 재연결 재전송이 거리를 두 번 세지 않는가',
    description: '일시정지 전 구간을 보내고 연결을 끊었다가, 다시 연결해 처음부터 전부 재전송한 뒤 종료한다.',
    run: async (client, check, makeClient) => {
      const { before, after, ranMeters } = pausedRunTrack()
      const roomId = await startSoloRun(client)
      await client.sendTrack(before)
      await sleep(300)
      client.close()
      await sleep(500)

      const again = makeClient()
      await again.connect()
      again.send('RUNNING_START', { runningRoomId: roomId })
      await again.waitFor((m) => m.event === 'RUNNING_STARTED', 5000, '재연결 RUNNING_STARTED')
      await again.sendTrack([...before, ...after])
      await sleep(500)
      const errors = again.received.filter((m) => m.event === 'ERROR')
      check('재전송에 ERROR가 없다', errors.length === 0, errors.map((m) => m.data.code).join(', ') || '없음')
      await finishRun(again)

      const results = await again.api('GET', `/running-rooms/${roomId}/results`)
      const me = results.players.find((p) => p.isMe)
      check(`거리가 두 번 세지지 않는다 (약 ${ranMeters}m)`,
        me.totalDistanceMeters >= ranMeters - 30 && me.totalDistanceMeters <= ranMeters + 10, `${me.totalDistanceMeters}m`)
      check('조각은 여전히 2개', (results.routes ?? []).length === 2, `${(results.routes ?? []).length}개`)
      again.close()
      return { maps: [{ title: '6-1 routes', segments: results.routes ?? [] }] }
    },
  },
  {
    id: 'resume-numbers',
    title: '⑥ 재연결 ack가 서버가 받은 번호를 알려 주는가 (재설치 복구)',
    description: '첫 ack가 0·0인지 본다 → 일시정지 전(0)·재개 후(1) 좌표를 보내고 재연결해 ack의 nextSequence·pauseSegment를 본다 → 재설치처럼 번호를 0부터 다시 보내 버려지거나 거부되는지 → ack 값으로 이어 보내 저장되는지 확인한다.',
    run: async (client, check, makeClient) => {
      const { before, after } = pausedRunTrack()
      const roomId = await startSoloRun(client)
      const first = client.received.find((m) => m.event === 'RUNNING_STARTED').data
      check('첫 진입 ack는 nextSequence 0, pauseSegment 0', first.nextSequence === 0 && first.pauseSegment === 0,
        `nextSequence ${first.nextSequence}, pauseSegment ${first.pauseSegment}`)

      // 일시정지 전(번호 0)과 재개 후(번호 1)를 보낸다 — 마지막 좌표가 서버가 기억할 값이다
      await client.sendTrack([...before, ...after])
      await sleep(500)
      client.close()
      await sleep(500)

      const reconnect = async () => {
        const next = makeClient()
        await next.connect()
        next.send('RUNNING_START', { runningRoomId: roomId })
        const ack = await next.waitFor((m) => m.event === 'RUNNING_STARTED', 5000, '재연결 RUNNING_STARTED')
        return { next, ack: ack.data }
      }
      const last = lastOf(after)
      const { next: second, ack } = await reconnect()
      check(`재연결 ack의 nextSequence = 마지막 순번 + 1 (${last.sequence + 1})`,
        ack.nextSequence === last.sequence + 1, `${ack.nextSequence}`)
      check(`재연결 ack의 pauseSegment = 마지막 좌표의 번호 (${last.pauseSegment})`,
        ack.pauseSegment === last.pauseSegment, `${ack.pauseSegment}`)

      // 재설치로 로컬을 잃었다 — 순번 0부터, 번호 0으로 새 좌표 10개를 만든다
      const tail = runLeg({
        fromSequence: 0, pauseSegment: 0, startTime: new Date(Date.now() - 40 * 1000),
        startLat: last.latitude, lng: 126.978, altitude: 60, seconds: 9, speed: 3.0,
      })
      await second.sendTrack(tail)
      await sleep(300)
      const silent = second.received.filter((m) => m.event === 'ERROR')
      check('이미 받은 순번(0~9)은 오류 없이 버려진다 (그래서 번호를 이어 써야 한다)', silent.length === 0,
        silent.map((m) => m.data.code).join(', ') || '오류 없음')

      // 순번만 서버 값으로 올리고 번호는 0 그대로 보낸다 → 거부
      second.send('RUNNING_LOCATION_UPDATE', {
        locations: tail.map((p, i) => ({ ...p, sequence: ack.nextSequence + i, pauseSegment: 0 })),
      })
      const rejected = await second.waitFor(errorOf('PAUSE_SEGMENT_DECREASED'), 5000, 'ERROR PAUSE_SEGMENT_DECREASED').catch((e) => e)
      check('번호를 0으로 보내면 PAUSE_SEGMENT_DECREASED로 거부된다', !(rejected instanceof Error),
        rejected instanceof Error ? rejected.message : rejected.data.message)

      // 앱 규칙대로 로컬 값(0)과 ack 값 중 큰 쪽으로 이어 쓴다 → 저장된다
      const resumed = tail.map((p, i) => ({
        ...p,
        sequence: Math.max(0, ack.nextSequence) + i,
        pauseSegment: Math.max(0, ack.pauseSegment),
      }))
      second.clearReceived()
      await second.sendTrack(resumed)
      await sleep(500)
      const errors = second.received.filter((m) => m.event === 'ERROR')
      check('ack 값으로 이어 보내면 오류가 없다', errors.length === 0, errors.map((m) => m.data.code).join(', ') || '오류 없음')
      second.close()
      await sleep(500)

      // 다시 재연결하면 이어 쓴 10개만큼 올라가 있어야 한다 — 0~9가 버려졌다는 증거이기도 하다
      const { next: third, ack: again } = await reconnect()
      check(`다시 재연결하면 nextSequence가 ${ack.nextSequence + resumed.length}`,
        again.nextSequence === ack.nextSequence + resumed.length, `${again.nextSequence}`)
      check(`pauseSegment는 이어 쓴 값(${ack.pauseSegment}) 그대로`, again.pauseSegment === ack.pauseSegment, `${again.pauseSegment}`)
      await finishRun(third)
      return {}
    },
  },
]

// ───────── 화면 ─────────

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [logs, setLogs] = useState([])
  const [outcomes, setOutcomes] = useState({})
  const [busy, setBusy] = useState(null)
  const clients = useRef([])

  const log = (line) => setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${line}`].slice(-400))

  const login = async () => {
    try {
      const result = await createClient('', log).api('POST', '/auth/login', { email, password })
      setToken(result.accessToken)
      log('로그인 성공')
    } catch (e) {
      log(`로그인 실패: ${e.message}`)
    }
  }

  const runScenario = async (scenario) => {
    setBusy(scenario.id)
    setLogs([])
    const checks = []
    const check = (name, pass, actual) => checks.push({ name, pass, actual })
    const makeClient = () => {
      const client = createClient(token, log)
      clients.current.push(client)
      return client
    }
    let view = {}
    let failure = null
    log(`▶ ${scenario.title}`)
    try {
      view = (await scenario.run(makeClient(), check, makeClient)) || {}
    } catch (e) {
      failure = e.message
      log(`✖ 중단: ${e.message}`)
    } finally {
      clients.current.forEach((c) => c.close())
      clients.current = []
    }
    setOutcomes((prev) => ({ ...prev, [scenario.id]: { checks, failure, ...view } }))
    setBusy(null)
  }

  const runAll = async () => {
    for (const scenario of SCENARIOS) {
      // eslint-disable-next-line no-await-in-loop
      await runScenario(scenario)
    }
  }

  return (
    <div style={s.page}>
      <h2 style={{ margin: '0 0 4px' }}>Runiverse 경로 조각 · 일시정지 테스트</h2>

      <div style={s.guide}>
        <b>하는 순서</b>
        <ol style={{ margin: '4px 0 0 18px', padding: 0 }}>
          <li>서버를 띄운다(<code>./gradlew bootRun</code>, 8080). 이 화면은 <code>npm run dev</code>로 띄운다.</li>
          <li>온보딩까지 마친 계정의 이메일·비밀번호로 로그인한다(솔로 방은 몸무게가 있어야 열린다).</li>
          <li>시나리오의 <b>실행</b>을 누르거나 <b>전부 실행</b>을 누른다. 몇 초면 끝난다.</li>
          <li>체크가 전부 ✅인지 본다. ❌이면 실제값과 아래 로그를 확인한다.</li>
        </ol>
      </div>

      <div style={s.box}>
        <b>1. 로그인</b>{' '}
        <input style={s.input} placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={s.input} placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={login}>로그인</button>{' '}
        <span style={token ? s.ok : s.muted}>{token ? '토큰 있음 ✔' : '로그인 전'}</span>
      </div>

      <div style={s.box}>
        <b>2. 시나리오</b>{' '}
        <button disabled={!token || busy} onClick={runAll}>전부 실행</button>
        {SCENARIOS.map((scenario) => {
          const outcome = outcomes[scenario.id]
          const passed = outcome && !outcome.failure && outcome.checks.every((c) => c.pass)
          return (
            <div key={scenario.id} style={s.card}>
              <div>
                <button disabled={!token || busy} onClick={() => runScenario(scenario)}>
                  {busy === scenario.id ? '실행 중…' : '실행'}
                </button>{' '}
                <b>{scenario.title}</b>{' '}
                {outcome && <span style={passed ? s.ok : s.bad}>{passed ? '통과' : '실패'}</span>}
              </div>
              <div style={s.muted}>{scenario.description}</div>
              {outcome?.failure && <div style={s.bad}>중단됨: {outcome.failure}</div>}
              {outcome?.checks.map((c) => (
                <div key={c.name}>{c.pass ? '✅' : '❌'} {c.name} — <span style={s.muted}>실제: {c.actual}</span></div>
              ))}
              {outcome?.maps?.map((m) => <RouteMap key={m.title} {...m} />)}
            </div>
          )
        })}
      </div>

      <div style={s.box}>
        <b>3. 로그</b> <span style={s.muted}>(마지막으로 실행한 시나리오)</span>
        <pre style={s.log}>{logs.join('\n')}</pre>
      </div>
    </div>
  )
}

const s = {
  page: { padding: 16, maxWidth: 1100 },
  guide: { background: '#eef4ff', padding: 10, borderRadius: 6, marginBottom: 10 },
  box: { border: '1px solid #ccc', borderRadius: 6, padding: 10, marginBottom: 10 },
  card: { borderTop: '1px solid #eee', padding: '8px 0' },
  input: { margin: '0 4px', padding: 3 },
  ok: { color: '#15803d', fontWeight: 'bold' },
  bad: { color: '#b91c1c', fontWeight: 'bold' },
  muted: { color: '#666', fontSize: 12 },
  map: { background: '#fff', border: '1px solid #ddd' },
  log: { maxHeight: 300, overflow: 'auto', fontSize: 11, background: '#111', color: '#9f9', padding: 8, margin: '6px 0 0' },
}
