import { useEffect, useRef, useState } from 'react';

const API = '/api/v1';
const wsUrl = (token) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/ws/running?token=${encodeURIComponent(token)}`;
const WAIT_MS = 5000;   // 와야 하는 메시지를 기다리는 시간 — 트랙 전체를 다시 분석하는 종료가 있어 넉넉히
const QUIET_MS = 2000;  // 오면 안 되는 메시지를 지켜보는 시간
const BATCH = 150;      // WS 수신 한도 64KB — 좌표 하나가 약 260B
const MAX_LOGS = 800;
const START_POINT = { lat: 37.4979, lng: 127.0276 }; // 강남역
// 서버 하버사인(지구 평균 반경 6,371,008.8m) 기준의 위도 1도 — 미터 좌표가 서버 거리와 맞는다
const M_PER_DEG_LAT = 111_194.93;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((START_POINT.lat * Math.PI) / 180);
const MATCH_TARGET = 3000;
const ROUTE_BREAK_M = 30; // 이웃한 경로 점이 이보다 멀면 관측하지 못한 구간

const RESULT_STYLE = {
  PASS: { bg: '#dcfce7', fg: '#166534' },
  FAIL: { bg: '#fee2e2', fg: '#991b1b' },
  RUNNING: { bg: '#e0e7ff', fg: '#3730a3' },
  SKIP: { bg: '#f3f4f6', fg: '#6b7280' },
  WAIT: { bg: '#fff', fg: '#9ca3af' },
};
const STATUS_STYLE = {
  RUNNING: { bg: '#dcfce7', fg: '#166534' },
  PAUSED: { bg: '#fef3c7', fg: '#92400e' },
  DISCONNECTED: { bg: '#e5e7eb', fg: '#374151' },
  FINISHED: { bg: '#dbeafe', fg: '#1e40af' },
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
// 서버는 recordedAt을 오프셋 없는 KST LocalDateTime으로 받는다
const localIso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const clock = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const between = (v, lo, hi, label) => assert(v >= lo && v <= hi, `${label}=${v} (기대 ${lo}~${hi})`);
const parseLocal = (s) => new Date(s); // 'YYYY-MM-DDTHH:mm:ss'는 브라우저 로컬(KST)로 해석된다

function haversine([lat1, lng1], [lat2, lng2]) {
  const R = 6_371_008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const routeBreaks = (routes) => {
  let n = 0;
  for (let i = 1; i < (routes?.length ?? 0); i++) if (haversine(routes[i - 1], routes[i]) > ROUTE_BREAK_M) n++;
  return n;
};

function Badge({ value, styles }) {
  const s = styles[value] ?? { bg: '#fee2e2', fg: '#991b1b' };
  return (
    <span style={{ background: s.bg, color: s.fg, padding: '2px 8px', borderRadius: 999, fontWeight: 700, fontSize: 12 }}>
      {value ?? '없음'}
    </span>
  );
}

// ── WS 클라이언트: 받은 메시지를 기다리거나(waitFor) 오지 않음을 확인한다(expectNone) ──
class RunningSocket {
  constructor(name, token, log, onMessage) {
    this.name = name;
    this.token = token;
    this.log = log;
    this.onMessage = onMessage;
    this.ws = null;
    this.waiters = new Set();
    this.onClosed = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.log(this.name, '→', 'WS 연결');
      const ws = new WebSocket(wsUrl(this.token));
      this.ws = ws;
      ws.onopen = () => { this.log(this.name, '←', 'WS open'); resolve(); };
      ws.onerror = () => { this.log(this.name, '✕', 'WS error'); reject(new Error('WS 연결 실패 — 서버·프록시·토큰 확인')); };
      ws.onclose = (e) => { this.log(this.name, '✕', 'WS close', { code: e.code, reason: e.reason }); this.onClosed?.(); };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (!msg.event?.startsWith('HEALTH') && msg.event !== 'RUNNING_COMBO_UPDATED') this.log(this.name, '←', msg.event, msg.data);
        this.onMessage(msg);
        for (const w of [...this.waiters]) {
          if (w.pred(msg)) { this.waiters.delete(w); clearTimeout(w.timer); w.hit(msg); }
        }
      };
    });
  }

  send(event, data = {}) {
    assert(this.ws?.readyState === WebSocket.OPEN, `${this.name} ${event}: WS가 열려 있지 않다`);
    this.ws.send(JSON.stringify({ event, data }));
    const shown = event === 'RUNNING_LOCATION_UPDATE'
      ? { count: data.locations.length, sequence: `${data.locations[0].sequence}~${data.locations.at(-1).sequence}` }
      : data;
    this.log(this.name, '→', event, shown);
  }

  // 보내기 전에 걸어 둬야 한다 — 응답이 send보다 먼저 처리될 수 있다
  waitFor(pred, label, ms = WAIT_MS) {
    return new Promise((resolve, reject) => {
      const w = { pred, hit: resolve };
      w.timer = setTimeout(() => { this.waiters.delete(w); reject(new Error(`${this.name}: ${ms}ms 안에 오지 않음 — ${label}`)); }, ms);
      this.waiters.add(w);
    });
  }

  expectNone(pred, label, ms = QUIET_MS) {
    return new Promise((resolve, reject) => {
      const w = { pred, hit: (msg) => reject(new Error(`${this.name}: 오면 안 되는 메시지 — ${label} → ${JSON.stringify(msg.data)}`)) };
      w.timer = setTimeout(() => { this.waiters.delete(w); resolve(); }, ms);
      this.waiters.add(w);
    });
  }

  // 좌표를 한도 안으로 나눠 보낸다
  sendTrack(points) {
    for (let i = 0; i < points.length; i += BATCH) {
      this.send('RUNNING_LOCATION_UPDATE', { locations: points.slice(i, i + BATCH) });
    }
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.onClosed = resolve;
      this.ws.close(1000, 'harness');
    });
  }
}

// ── 트랙 만들기: 출발점 기준 미터 좌표(north 북쪽, east 동쪽)와 경과 초(t)로 쌓는다 ──
// 서버 TrackFilterTest의 Track 헬퍼와 같은 동작이다
function createTrack() {
  const raw = [{ north: 0, east: 0, t: 0, acc: 5 }];
  let north = 0, east = 0, t = 0;
  let sent = 0;
  let baseMs = null;
  const add = (n, e, dt, acc = 5) => { north = n; east = e; t += dt; raw.push({ north: n, east: e, t, acc }); };
  const toPoint = (p, i) => ({
    sequence: i,
    latitude: +(START_POINT.lat + p.north / M_PER_DEG_LAT).toFixed(7),
    longitude: +(START_POINT.lng + p.east / M_PER_DEG_LNG).toFixed(7),
    altitudeMeters: 20,
    accuracyMeters: p.acc,
    speedMetersPerSecond: 3,
    headingDegrees: 0,
    cadenceSpm: 170,
    currentPaceSecondsPerKm: 333,
    recordedAt: localIso(new Date(baseMs + p.t * 1000)),
  });
  const track = {
    // 1초마다 북쪽으로 step m
    run(count, step = 3) { for (let i = 0; i < count; i++) add(north + step, east, 1); return track; },
    // 제자리에서 2초마다 동서로 meters씩 흔들린다 — 기준 위치는 그대로
    jitter(seconds, meters = 1) {
      const bn = north, be = east;
      for (let i = 1; i * 2 <= seconds; i++) add(bn, be + (i % 2 ? -meters : meters), 2);
      north = bn; east = be;
      return track;
    },
    // 좌표 없이 seconds가 지난 뒤 북쪽으로 meters 떨어진 곳에서 나타난다
    gap(seconds, meters) { add(north + meters, east, seconds); return track; },
    // 한 점만 동쪽으로 튀고, 다음 점은 원래 경로(북쪽 3m 앞)로 돌아온다
    spike(eastMeters = 200) { const be = east; add(north + 3, be + eastMeters, 1); east = be; return track; },
    // 정확도가 나쁜 점 하나 — 위치도 옆으로 어긋나 있다
    badPoint(eastMeters = 30, acc = 80) { const be = east; add(north + 3, be + eastMeters, 1, acc); east = be; return track; },
    get seconds() { return t; },
    // 시각 기준을 정한다 — 솔로는 과거로(끝이 지금), 매칭은 시작 순간부터
    anchor(ms) { baseMs = ms; return track; },
    // 아직 안 보낸 좌표
    take() { const out = raw.slice(sent).map((p, k) => toPoint(p, sent + k)); sent = raw.length; return out; },
  };
  return track;
}

// ── 메시지 조건 ──
const isEvent = (event) => (m) => m.event === event;
const isProgressOf = (userId, pred = () => true) => (m) =>
  m.event === 'RUNNING_PROGRESS_UPDATED' && m.data?.userId === userId && pred(m.data);
const isFinishOrPending = (m) => m.event === 'RUNNING_FINISHED' || m.event === 'RUNNING_GOAL_PENDING';

// ── ① 솔로 필터 시나리오: 기대 거리·움직인 시간·지도 끊김 ──
// 거리는 10m 경계로 잘리고, 움직인 시간은 마지막 10m 미만 꼬리만큼 짧아질 수 있다
const SOLO = [
  { name: '정상 600m', build: (t) => t.run(200), distance: 600, moving: 200, breaks: 0 },
  { name: '신호 대기 (제자리 60초)', build: (t) => t.run(100).jitter(60, 1).run(100), distance: 600, moving: 200, breaks: 0, removedAtLeast: 50 },
  { name: 'GPS 튐 (한 점 200m)', build: (t) => t.run(100).spike(200).run(100), distance: 603, moving: 201, breaks: 0 },
  { name: '순간이동 (1초에 500m)', build: (t) => t.run(100).gap(1, 500).run(100), distance: 600, moving: 200, breaks: 1 },
  { name: '터널 (100초 300m) — 인정', build: (t) => t.run(100).gap(100, 300).run(100), distance: 900, moving: 300, breaks: 0 },
  { name: '택시 (60초 400m) — 거부', build: (t) => t.run(100).gap(60, 400).run(100), distance: 600, moving: 200, breaks: 1, removedAtLeast: 55 },
  { name: '서면→해운대 (1시간 10km) — 거부', build: (t) => t.run(100).gap(3600, 10_000).run(100), distance: 600, moving: 200, breaks: 1, removedAtLeast: 3500 },
  { name: '정확도 80m인 점', build: (t) => t.run(100).badPoint(30, 80).run(100), distance: 603, moving: 201, breaks: 0 },
  { name: '일시정지 후 제자리 재개', build: (t) => t.run(100).gap(60, 1).run(100), distance: 600, moving: 200, breaks: 0, removedAtLeast: 55 },
];

// ── ② 매칭 2인 시나리오 (목표 3,000m) ──
const MATCH = [
  {
    name: '둘 다 START', expect: '서로 스냅샷에 보임',
    run: async (c) => {
      c.a.track.anchor(Date.now());
      c.b.track.anchor(Date.now());
      for (const p of [c.a, c.b]) {
        const ack = p.sock.waitFor(isEvent('RUNNING_STARTED'), 'RUNNING_STARTED');
        p.sock.send('RUNNING_START', { runningRoomId: c.roomId });
        const started = await ack;
        const ids = started.data.players.map((x) => x.userId);
        assert(ids.includes(c.a.userId) && ids.includes(c.b.userId), `${p.name} 스냅샷 참가자=${ids.join(',')}`);
      }
      return '둘 다 RUNNING_STARTED · 서로 보임';
    },
  },
  {
    name: 'A 1,500m', expect: 'B 화면에 A 진행 거리 ≈1,500',
    run: async (c) => {
      const seen = c.b.sock.waitFor(isProgressOf(c.a.userId, (d) => d.distanceMeters >= 1490), 'B가 받은 A 진행 ≥1,490');
      c.a.sock.sendTrack(c.a.track.run(500).take());
      const m = await seen;
      return `B가 본 A 거리 ${m.data.distanceMeters}m`;
    },
  },
  {
    name: 'B 2,898m', expect: '목표 전 — 종료 신호 없음',
    run: async (c) => {
      const own = c.b.sock.waitFor(isProgressOf(c.b.userId, (d) => d.distanceMeters >= 2890), 'B 진행 ≥2,890');
      const quiet = c.b.sock.expectNone(isFinishOrPending, '종료·남은 거리');
      c.b.sock.sendTrack(c.b.track.run(966).take());
      const m = await own;
      await quiet;
      return `B 러닝 중 누적 ${m.data.distanceMeters}m`;
    },
  },
  {
    name: 'B 제자리 흔들림 60초', expect: '누적은 3,000 초과(알려진 한계) · B에게 아무것도 안 옴',
    run: async (c) => {
      const crossed = c.a.sock.waitFor(isProgressOf(c.b.userId, (d) => d.distanceMeters >= MATCH_TARGET), 'A가 받은 B 진행 ≥3,000');
      const quiet = c.b.sock.expectNone(isFinishOrPending, '자동 종료가 보류됐는데 메시지가 옴', 3000);
      c.b.sock.sendTrack(c.b.track.jitter(60, 3).take());
      const m = await crossed;
      await quiet;
      return `누적 ${m.data.distanceMeters}m(흔들림 포함) · 자동 종료 보류, 메시지 없음`;
    },
  },
  {
    name: 'B 종료 forced=false', expect: 'RUNNING_GOAL_PENDING ≈100m · RUNNING_FINISHED 안 옴',
    run: async (c) => {
      const pending = c.b.sock.waitFor(isEvent('RUNNING_GOAL_PENDING'), 'RUNNING_GOAL_PENDING');
      const noFinish = c.b.sock.expectNone(isEvent('RUNNING_FINISHED'), 'RUNNING_FINISHED', 2500);
      c.b.sock.send('RUNNING_FINISH', { forced: false });
      const m = await pending;
      await noFinish;
      between(m.data.remainingMeters, 95, 115, 'remainingMeters');
      return `남은 거리 ${m.data.remainingMeters}m`;
    },
  },
  {
    name: 'B 120m 더', expect: '자동 종료 → RUNNING_FINISHED · A 화면에 B FINISHED',
    run: async (c) => {
      const fin = c.b.sock.waitFor(isEvent('RUNNING_FINISHED'), 'B RUNNING_FINISHED');
      const seen = c.a.sock.waitFor(isProgressOf(c.b.userId, (d) => d.status === 'FINISHED'), 'A가 받은 B FINISHED');
      c.b.sock.sendTrack(c.b.track.run(40).take());
      await fin;
      await seen;
      return 'B 완주 · A가 FINISHED를 봄';
    },
  },
  {
    name: 'A 종료 forced=false (1,500m)', expect: 'RUNNING_GOAL_PENDING ≈1,500m',
    run: async (c) => {
      const pending = c.a.sock.waitFor(isEvent('RUNNING_GOAL_PENDING'), 'RUNNING_GOAL_PENDING');
      c.a.sock.send('RUNNING_FINISH', { forced: false });
      const m = await pending;
      between(m.data.remainingMeters, 1490, 1505, 'remainingMeters');
      return `남은 거리 ${m.data.remainingMeters}m`;
    },
  },
  {
    name: 'A 종료 forced=true', expect: 'RUNNING_FINISHED (그래도 그만두기)',
    run: async (c) => {
      const fin = c.a.sock.waitFor(isEvent('RUNNING_FINISHED'), 'A RUNNING_FINISHED');
      c.a.sock.send('RUNNING_FINISH', { forced: true });
      await fin;
      return 'A 종료 확정';
    },
  },
  {
    name: '결과 확인', expect: 'A 1,500 · B 3,000 · B는 기간−움직인 시간 ≥ 50초 · 지도 끊김 0',
    run: async (c) => {
      const ra = await c.api('GET', `/running-rooms/${c.roomId}/results`, null, c.a.token);
      const rb = await c.api('GET', `/running-rooms/${c.roomId}/results`, null, c.b.token);
      const pa = ra.players.find((p) => p.userId === c.a.userId);
      const pb = ra.players.find((p) => p.userId === c.b.userId);
      between(pa.totalDistanceMeters, 1490, 1500, 'A 거리');
      assert(pb.totalDistanceMeters === MATCH_TARGET, `B 거리=${pb.totalDistanceMeters}`);
      const period = (parseLocal(rb.finishedAt) - parseLocal(rb.startedAt)) / 1000;
      const bMoving = rb.players.find((p) => p.isMe).totalDurationSeconds;
      assert(period - bMoving >= 50, `B 기간 ${period}초 − 움직인 시간 ${bMoving}초 = ${period - bMoving}`);
      assert(routeBreaks(rb.routes) === 0, `B 지도 끊김 ${routeBreaks(rb.routes)}`);
      return `A ${pa.totalDistanceMeters}m · B ${pb.totalDistanceMeters}m · B 기간 ${period}초 / 움직인 시간 ${bMoving}초`;
    },
  },
];

// 오늘(또는 내일) 신청할 수 있는 슬롯 — 마감(시작 − 오프셋)이 지나지 않은 것만
function availableSlots(closeOffsetMin) {
  const out = [];
  const now = Date.now();
  for (let day = 0; day < 2 && out.length < 6; day++) {
    for (let m = 18 * 60; m <= 22 * 60; m += 30) {
      const d = new Date();
      d.setDate(d.getDate() + day);
      d.setHours(Math.floor(m / 60), m % 60, 0, 0);
      if (d.getTime() - closeOffsetMin * 60_000 > now + 30_000) out.push(localIso(d));
    }
  }
  return out.slice(0, 6);
}

const blank = (steps) => steps.map(() => ({ result: 'WAIT', actual: '' }));

export default function App() {
  const [cred, setCred] = useState({ A: { email: '', password: '' }, B: { email: '', password: '' } });
  const [auth, setAuth] = useState({ A: null, B: null }); // { token, userId }
  const [soloResults, setSoloResults] = useState(blank(SOLO));
  const [matchResults, setMatchResults] = useState(blank(MATCH));
  const [busy, setBusy] = useState(false);
  const [closeOffset, setCloseOffset] = useState(10);
  const [slot, setSlot] = useState('');
  const [match, setMatch] = useState(null); // { roomId, startAt }
  const [now, setNow] = useState(Date.now());
  const [live, setLive] = useState({}); // userId → { status, distance }
  const [logs, setLogs] = useState([]);
  const startedRef = useRef(false);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!slot) setSlot(availableSlots(closeOffset)[0] ?? ''); }, [closeOffset, slot]);

  const log = (who, dir, event, data = null) =>
    setLogs((prev) => [{ id: `${Date.now()}-${Math.random()}`, t: clock(), who, dir, event, data }, ...prev].slice(0, MAX_LOGS));

  const api = async (method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    log('API', '→', `${method} ${path}`, body ?? null);
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    log('API', res.ok ? '←' : '✕', `${res.status} ${method} ${path}`, data);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.code ?? ''}`);
    return data;
  };

  const onMessage = (msg) => {
    if (msg.event === 'RUNNING_PROGRESS_UPDATED') {
      setLive((p) => ({ ...p, [msg.data.userId]: { status: msg.data.status, distance: msg.data.distanceMeters } }));
    }
  };

  const openSocket = async (name, a) => {
    const sock = new RunningSocket(name, a.token, log, onMessage);
    await sock.open();
    return sock;
  };

  const login = (who) => async () => {
    try {
      const c = cred[who];
      const d = await api('POST', '/auth/login', { email: c.email.trim().toLowerCase(), password: c.password }, null);
      setAuth((p) => ({ ...p, [who]: { token: d.accessToken, userId: d.userId } }));
    } catch { /* 로그에 남았다 */ }
  };

  // 남아 있는 신청·러닝을 정리한다 — 활성 신청이 있으면 새 방을 열 수 없다.
  // 마감 뒤 매칭 방에서 나가면 확정 후 이탈이라 쿨다운이 걸릴 수 있다
  const cleanUp = async (name, a) => {
    const s = await api('GET', '/users/me/status', null, a.token);
    if (s.status === 'WAITING' || s.status === 'READY') {
      await api('DELETE', '/running-matches', null, a.token);
    } else if (s.status === 'RUNNING') {
      log(name, '·', '진행 중인 러닝을 끝낸다', { runningRoomId: s.runningRoomId });
      const sock = await openSocket(name, a);
      const ack = sock.waitFor(isEvent('RUNNING_STARTED'), 'RUNNING_STARTED');
      sock.send('RUNNING_START', { runningRoomId: s.runningRoomId });
      await ack;
      const fin = sock.waitFor(isEvent('RUNNING_FINISHED'), 'RUNNING_FINISHED');
      sock.send('RUNNING_FINISH', { forced: true });
      await fin;
      await sock.close();
    }
  };

  // ── ① 솔로 필터 시나리오 ──
  const runSolo = async () => {
    setBusy(true);
    setSoloResults(blank(SOLO));
    const a = auth.A;
    for (let i = 0; i < SOLO.length; i++) {
      const sc = SOLO[i];
      setSoloResults((r) => r.map((x, j) => (j === i ? { result: 'RUNNING', actual: '' } : x)));
      log('A', '·', `── 솔로 ${i + 1}. ${sc.name}`);
      let sock;
      try {
        await cleanUp('A', a);
        const { runningRoomId } = await api('POST', '/running-rooms/solo', null, a.token);
        sock = await openSocket('A', a);
        const ack = sock.waitFor(isEvent('RUNNING_STARTED'), 'RUNNING_STARTED');
        sock.send('RUNNING_START', { runningRoomId });
        await ack;
        // 트랙이 지금 끝나도록 과거로 맞춘다 — 서버 시계와 크게 어긋나지 않게
        const track = sc.build(createTrack());
        track.anchor(Date.now() - (track.seconds + 5) * 1000);
        sock.sendTrack(track.take());
        await sleep(300);
        const fin = sock.waitFor(isEvent('RUNNING_FINISHED'), 'RUNNING_FINISHED');
        sock.send('RUNNING_FINISH', { forced: false }); // 솔로는 목표가 없어 미루지 않는다
        await fin;
        const res = await api('GET', `/running-rooms/${runningRoomId}/results`, null, a.token);
        const me = res.players.find((p) => p.isMe);
        const period = (parseLocal(res.finishedAt) - parseLocal(res.startedAt)) / 1000;
        const breaks = routeBreaks(res.routes);
        between(me.totalDistanceMeters, sc.distance - 15, sc.distance + 5, '거리');
        between(me.totalDurationSeconds, sc.moving - 7, sc.moving + 3, '움직인 시간');
        assert(breaks === sc.breaks, `지도 끊김=${breaks} (기대 ${sc.breaks})`);
        if (sc.removedAtLeast) assert(period - me.totalDurationSeconds >= sc.removedAtLeast,
          `기간 ${period}초 − 움직인 시간 ${me.totalDurationSeconds}초 < ${sc.removedAtLeast}`);
        setSoloResults((r) => r.map((x, j) => (j === i ? {
          result: 'PASS',
          actual: `${me.totalDistanceMeters}m · 움직인 ${me.totalDurationSeconds}초 · 기간 ${period}초 · 끊김 ${breaks}`,
        } : x)));
      } catch (e) {
        setSoloResults((r) => r.map((x, j) => (j === i ? { result: 'FAIL', actual: e.message } : x)));
        log('A', '✕', `솔로 ${sc.name} 실패`, e.message);
      } finally {
        await sock?.close();
      }
    }
    setBusy(false);
  };

  // ── ② 매칭 2인: 신청 → 시작 시각 대기 → 시나리오 ──
  const applyMatch = async () => {
    setBusy(true);
    try {
      await cleanUp('A', auth.A);
      await cleanUp('B', auth.B);
      const body = { scheduledStartAt: slot, targetDistanceMeters: MATCH_TARGET };
      const ra = await api('POST', '/running-matches', body, auth.A.token);
      const rb = await api('POST', '/running-matches', body, auth.B.token);
      assert(ra.runningRoomId === rb.runningRoomId, `서로 다른 방에 배정됨 A=${ra.runningRoomId} B=${rb.runningRoomId}`);
      startedRef.current = false;
      setMatchResults(blank(MATCH));
      setMatch({ roomId: ra.runningRoomId, startAt: parseLocal(slot).getTime() });
    } catch (e) {
      log('API', '✕', '매칭 신청 실패', e.message);
    }
    setBusy(false);
  };

  const runMatch = async () => {
    setBusy(true);
    setMatchResults(blank(MATCH));
    const c = { roomId: match.roomId, api };
    try {
      c.a = { name: 'A', ...auth.A, track: createTrack(), sock: await openSocket('A', auth.A) };
      c.b = { name: 'B', ...auth.B, track: createTrack(), sock: await openSocket('B', auth.B) };
    } catch (e) {
      log('API', '✕', '연결 실패', e.message);
      setBusy(false);
      return;
    }
    let failed = false;
    for (let i = 0; i < MATCH.length; i++) {
      if (failed) { setMatchResults((r) => r.map((x, j) => (j === i ? { result: 'SKIP', actual: '앞 단계 실패' } : x))); continue; }
      setMatchResults((r) => r.map((x, j) => (j === i ? { result: 'RUNNING', actual: '' } : x)));
      log('·', '·', `── 매칭 ${i + 1}. ${MATCH[i].name}`);
      try {
        const actual = await MATCH[i].run(c);
        setMatchResults((r) => r.map((x, j) => (j === i ? { result: 'PASS', actual } : x)));
      } catch (e) {
        failed = true;
        setMatchResults((r) => r.map((x, j) => (j === i ? { result: 'FAIL', actual: e.message } : x)));
        log('·', '✕', `매칭 ${MATCH[i].name} 실패`, e.message);
      }
    }
    await c.a.sock.close();
    await c.b.sock.close();
    setBusy(false);
  };

  // 시작 시각이 지나면 자동으로 시작한다 — 서버 시작 스케줄러와 겹치지 않게 3초 여유
  useEffect(() => {
    if (match && !startedRef.current && now >= match.startAt + 3000) {
      startedRef.current = true;
      runMatch();
    }
  }, [now, match]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = { border: '1px solid #d1d5db', borderRadius: 8, padding: 12, marginBottom: 12 };
  const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 };
  const btn = (color = '#111827') => ({ padding: '5px 12px', borderRadius: 6, border: `1px solid ${color}`, background: '#fff', color, cursor: 'pointer' });

  const Table = ({ steps, results, expectOf }) => (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid #d1d5db' }}>
          <th style={{ width: 30 }}>#</th><th>단계</th><th>기대</th><th style={{ width: 70 }}>결과</th><th>실제</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s, i) => (
          <tr key={i} style={{ borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' }}>
            <td>{i + 1}</td><td><b>{s.name}</b></td>
            <td style={{ color: '#4b5563' }}>{expectOf(s)}</td>
            <td><Badge value={results[i].result} styles={RESULT_STYLE} /></td>
            <td style={{ color: results[i].result === 'FAIL' ? '#991b1b' : '#111827' }}>{results[i].actual}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const secondsLeft = match ? Math.max(0, Math.round((match.startAt - now) / 1000)) : null;
  const loginRow = (who) => (
    <div style={row}>
      <b style={{ width: 20 }}>{who}</b>
      <input value={cred[who].email} onChange={(e) => setCred((p) => ({ ...p, [who]: { ...p[who], email: e.target.value } }))} placeholder="email" style={{ width: 200 }} />
      <input value={cred[who].password} onChange={(e) => setCred((p) => ({ ...p, [who]: { ...p[who], password: e.target.value } }))} placeholder="password" type="password" />
      <button style={btn()} onClick={login(who)}>로그인</button>
      <button style={btn('#6b7280')} disabled={!auth[who] || busy} onClick={() => cleanUp(who, auth[who]).catch((e) => log(who, '✕', '정리 실패', e.message))}>정리</button>
      {auth[who] && <span style={{ fontSize: 13 }}>userId {auth[who].userId}</span>}
    </div>
  );

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, color: '#111827', maxWidth: 1200 }}>
      <h2 style={{ marginTop: 0 }}>트랙 필터 · 자동 종료 · 남은 거리 알림 테스트</h2>

      <div style={box}>
        <b>1. 로그인</b> <small style={{ color: '#6b7280' }}>— 온보딩을 마친 계정 둘. 솔로는 A만, 매칭은 A·B 둘 다</small>
        {loginRow('A')}
        {loginRow('B')}
      </div>

      <div style={box}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <b>2. 솔로 필터 시나리오 (A)</b>
          <button style={btn('#2563eb')} onClick={runSolo} disabled={!auth.A || busy}>▶ 실행</button>
          <small style={{ color: '#6b7280' }}>시나리오마다 새 솔로 방 → 트랙 전송 → 종료 → 결과 조회</small>
        </div>
        <Table steps={SOLO} results={soloResults}
          expectOf={(s) => `${s.distance}m · 움직인 ${s.moving}초 · 끊김 ${s.breaks}${s.removedAtLeast ? ` · 빠진 시간 ≥${s.removedAtLeast}초` : ''}`} />
      </div>

      <div style={box}>
        <b>3. 매칭 2인 시나리오 (A·B, 목표 {MATCH_TARGET}m)</b>
        <div style={row}>
          <span>마감 오프셋(분)</span>
          <input type="number" value={closeOffset} onChange={(e) => { setCloseOffset(+e.target.value); setSlot(''); }} style={{ width: 60 }} />
          <select value={slot} onChange={(e) => setSlot(e.target.value)}>
            {availableSlots(closeOffset).map((s) => <option key={s} value={s}>{s.replace('T', ' ')}</option>)}
          </select>
          <button style={btn('#2563eb')} onClick={applyMatch} disabled={!auth.A || !auth.B || busy || !slot}>둘 다 신청</button>
          {match && (
            <span style={{ fontSize: 13 }}>
              방 {match.roomId} · 시작 {secondsLeft > 0 ? `${Math.floor(secondsLeft / 60)}분 ${secondsLeft % 60}초 남음` : '시작됨'}
            </span>
          )}
          {match && <button style={btn()} onClick={runMatch} disabled={busy || secondsLeft > 0}>다시 실행</button>}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
          시작 시각이 지나면 자동으로 실행된다. 대기 중에는 "정리"를 누르지 말 것 — 마감 뒤 나가면 쿨다운이 걸린다.
        </div>
        <Table steps={MATCH} results={matchResults} expectOf={(s) => s.expect} />
        <div style={{ ...row, fontSize: 13 }}>
          러닝 중 누적(진행 통지):
          {['A', 'B'].map((who) => auth[who] && (
            <span key={who}>
              {who} <Badge value={live[auth[who].userId]?.status} styles={STATUS_STYLE} /> {live[auth[who].userId]?.distance ?? '-'}m
            </span>
          ))}
        </div>
      </div>

      <div style={box}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <b>4. 로그</b>
          <button style={btn()} onClick={() => setLogs([])}>지우기</button>
        </div>
        <div style={{ maxHeight: 400, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 6 }}>
          {logs.map((l) => {
            const color = l.dir === '✕' ? '#dc2626' : l.dir === '→' ? '#2563eb' : l.dir === '←' ? '#16a34a' : '#6b7280';
            return (
              <details key={l.id} style={{ borderBottom: '1px dashed #e5e7eb' }}>
                <summary style={{ color, cursor: 'pointer' }}>
                  {l.t} [{l.who}] {l.dir} {l.event}
                  {l.event === 'RUNNING_PROGRESS_UPDATED' && <> <Badge value={l.data?.status} styles={STATUS_STYLE} /> {l.data?.distanceMeters}m</>}
                  {l.event === 'RUNNING_GOAL_PENDING' && <> <b>{l.data?.remainingMeters}m 남음</b></>}
                  {l.event === 'ERROR' && <> <b>{l.data?.code}</b> ({l.data?.sourceType})</>}
                </summary>
                <pre style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(l.data, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      </div>
    </div>
  );
}
