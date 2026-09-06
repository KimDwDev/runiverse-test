import { useCallback, useRef, useState } from "react";

const BASE = "http://localhost:8080/api/v1";
const DISTANCES = [3000, 5000, 10000];

// 18:00~22:00 30분 간격 — 서버 ApplyMatchRequest 검증과 같은 규칙
function slots(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
  const out = [];
  for (let h = 18; h <= 22; h++) {
    for (const m of h === 22 ? [0] : [0, 30]) {
      out.push(`${ymd}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
    }
  }
  return out;
}

const ALL_SLOTS = [...slots(0), ...slots(1)];

// 마감을 지금부터 N분 뒤로 만들려면 close-offset을 얼마로 둬야 하는지
function offsetHint(slot, minutesFromNow) {
  const ms = new Date(slot).getTime() - Date.now() - minutesFromNow * 60_000;
  if (ms <= 0) return "이미 지난 슬롯";
  const total = Math.round(ms / 60_000);
  return `${Math.floor(total / 60)}h${total % 60}m`;
}

function UserPanel({ label }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [slot, setSlot] = useState(ALL_SLOTS[0]);
  const [distance, setDistance] = useState(5000);
  const [room, setRoom] = useState(null);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const abortRef = useRef(null);
  const tokenRef = useRef("");

  const log = useCallback((kind, text) => {
    const at = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    setLogs((prev) => [{ at, kind, text }, ...prev].slice(0, 200));
  }, []);

  async function call(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return parsed;
  }

  function saveToken(value) {
    tokenRef.current = value;
    setToken(value);
  }

  async function login() {
    try {
      const r = await call("POST", "/auth/login", { email, password });
      saveToken(r.accessToken);
      log("ok", `로그인 — userId=${r.userId}`);
    } catch (e) {
      log("err", `로그인 실패 — ${e.message}`);
    }
  }

  // EventSource는 Authorization 헤더를 못 붙인다 — fetch 스트림으로 SSE를 직접 읽는다
  async function connect() {
    if (abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setConnected(true);
    log("sys", "스트림 연결 시도");
    try {
      const res = await fetch(`${BASE}/running-matches/stream`, {
        headers: {
          Authorization: `Bearer ${tokenRef.current}`,
          Accept: "text/event-stream",
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      log("ok", "스트림 연결됨");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        // SSE 프레임 구분자는 빈 줄이다
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          handleFrame(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
      log("sys", "스트림 종료(서버가 닫음)");
    } catch (e) {
      if (e.name !== "AbortError") log("err", `스트림 오류 — ${e.message}`);
    } finally {
      setConnected(false);
      abortRef.current = null;
    }
  }

  function handleFrame(raw) {
    let name = "message";
    const data = [];
    for (const line of raw.split("\n")) {
      // ": ping" — 프록시 유휴 타임아웃 방지용 주석
      if (line.startsWith(":")) {
        log("ping", line.slice(1).trim() || "ping");
        return;
      }
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    try {
      const parsed = JSON.parse(data.join("\n"));
      setRoom(parsed);
      log(name === "MATCH_STARTED" ? "started" : "event", `${name} — ${summarize(parsed)}`);
    } catch {
      log("event", `${name} — ${data.join("\n")}`);
    }
  }

  function disconnect() {
    abortRef.current?.abort();
    log("sys", "스트림 끊음(클라)");
  }

  async function apply() {
    try {
      const r = await call("POST", "/running-matches", {
        scheduledStartAt: slot,
        targetDistanceMeters: distance,
      });
      log("ok", `신청 성공 — runningRoomId=${r.runningRoomId}`);
      // 스펙상 신청 성공 직후에 연다 — 활성 신청이 없으면 서버가 보낼 게 없다(api-spec 5-A)
      if (!abortRef.current) connect();
    } catch (e) {
      log("err", `신청 실패 — ${e.message}`);
    }
  }

  async function cancel() {
    try {
      await call("DELETE", "/running-matches");
      setRoom(null);
      log("ok", "취소 성공 (204)");
      // 취소하면 클라가 스트림을 닫는다(api-spec 5-A)
      disconnect();
    } catch (e) {
      log("err", `취소 실패 — ${e.message}`);
    }
  }

  return (
    <div style={S.panel}>
      <h3 style={S.h3}>
        {label} {connected && <span style={S.dot} />}
      </h3>

      <div style={S.row}>
        <input style={S.input} placeholder="이메일" value={email}
               onChange={(e) => setEmail(e.target.value)} />
        <input style={S.input} type="password" placeholder="비밀번호" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        <button style={S.btn} onClick={login}>로그인</button>
      </div>
      <input style={{ ...S.input, width: "100%" }} placeholder="accessToken (직접 붙여넣기 가능)"
             value={token} onChange={(e) => saveToken(e.target.value)} />

      <div style={S.row}>
        <select style={S.input} value={slot} onChange={(e) => setSlot(e.target.value)}>
          {ALL_SLOTS.map((s) => <option key={s} value={s}>{s.replace("T", " ")}</option>)}
        </select>
        <select style={S.input} value={distance}
                onChange={(e) => setDistance(Number(e.target.value))}>
          {DISTANCES.map((d) => <option key={d} value={d}>{d / 1000}km</option>)}
        </select>
      </div>
      <div style={S.hint}>
        1분 뒤 마감시키려면 <code>match.close-offset={offsetHint(slot, 1)}</code>
      </div>

      <div style={S.row}>
        <button style={{ ...S.btn, ...S.primary }} onClick={apply} disabled={!token}>
          신청 + 연결
        </button>
        <button style={{ ...S.btn, ...S.danger }} onClick={cancel} disabled={!token}>
          취소
        </button>
        <button style={S.btn} onClick={connect} disabled={connected || !token}>재연결</button>
        <button style={S.btn} onClick={disconnect} disabled={!connected}>연결 끊기</button>
      </div>

      {room && (
        <div style={S.room}>
          <b>방 {room.runningRoomId}</b> · <b style={S.status}>{room.status}</b> ·{" "}
          {room.players?.length ?? 0}명
          <div style={S.small}>
            시작 {room.scheduledStartAt?.replace("T", " ")} / 마감 {room.closeAt?.replace("T", " ")}
            {room.teamAveragePaceSecondsPerKm != null &&
              ` / 평균 ${room.teamAveragePaceSecondsPerKm}초per km`}
          </div>
          <div style={S.small}>{room.players?.map((p) => p.nickname).join(", ")}</div>
        </div>
      )}

      <div style={S.logs}>
        {logs.map((l, i) => (
          <div key={i} style={{ ...S.logLine, color: COLORS[l.kind] ?? "#333" }}>
            <span style={S.time}>{l.at}</span> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function summarize(r) {
  return `방 ${r.runningRoomId} / ${r.status} / ${r.players?.length ?? 0}명`;
}

const COLORS = {
  ok: "#0a7", err: "#d33", event: "#06c",
  started: "#b60", ping: "#aaa", sys: "#666",
};

const S = {
  panel: { flex: 1, border: "1px solid #ddd", borderRadius: 8, padding: 12,
           fontFamily: "ui-monospace, monospace", fontSize: 13, minWidth: 380 },
  h3: { margin: "0 0 8px" },
  row: { display: "flex", gap: 6, margin: "6px 0", flexWrap: "wrap" },
  input: { flex: 1, minWidth: 90, padding: "5px 7px", border: "1px solid #ccc", borderRadius: 4 },
  btn: { padding: "5px 10px", border: "1px solid #bbb", borderRadius: 4,
         background: "#fafafa", cursor: "pointer" },
  primary: { fontWeight: 700, borderColor: "#8ab", background: "#eef5ff" },
  danger: { color: "#d33", borderColor: "#e9b0b0" },
  dot: { display: "inline-block", width: 8, height: 8, borderRadius: 4, background: "#0a7" },
  hint: { color: "#888", fontSize: 11, margin: "2px 0 6px" },
  room: { background: "#f5f8ff", border: "1px solid #dbe6ff", borderRadius: 6,
          padding: 8, margin: "6px 0" },
  status: { color: "#b60" },
  small: { color: "#666", fontSize: 11, marginTop: 3 },
  logs: { height: 260, overflowY: "auto", background: "#fbfbfb",
          border: "1px solid #eee", borderRadius: 4, padding: 6, marginTop: 6 },
  logLine: { whiteSpace: "pre-wrap", lineHeight: 1.5 },
  time: { color: "#bbb", marginRight: 6 },
};

export default function App() {
  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ fontFamily: "system-ui" }}>매칭 테스트</h2>
      <div style={{ display: "flex", gap: 12 }}>
        <UserPanel label="유저 A" />
        <UserPanel label="유저 B" />
      </div>
    </div>
  );
}
