import { useEffect, useRef, useState } from "react";

// 인앱 알림 확인용 2패널 하네스 — 앱 스트림·목록(2-4)·모두 읽음(2-5)·친구 요청/수락/거절·초대 러닝 개설/초대/수락/거절.
// EventSource는 헤더를 못 실어서(Authorization·X-App-Version) fetch 스트림으로 SSE를 직접 읽는다.
const BASE_URL = "http://localhost:8080/api/v1";
const APP_HEADERS = { "X-App-Version": "1.2.0", "X-App-Platform": "ANDROID" };

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      ...APP_HEADERS,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

// SSE 프레임을 줄 단위로 읽는다 — 빈 줄이 이벤트 하나의 끝, ':'로 시작하면 주석(connected·ping)
async function openStream(path, token, onFrame, signal) {
  const res = await fetch(BASE_URL + path, {
    headers: { ...APP_HEADERS, Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal,
  });
  onFrame({ kind: "status", text: `${path} HTTP ${res.status}` });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = null;
  let data = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      onFrame({ kind: "status", text: `${path} 서버가 스트림을 닫음` });
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (event) onFrame({ kind: "event", event, data: safeParse(data) });
        event = null;
        data = "";
      } else if (line.startsWith(":")) {
        onFrame({ kind: "comment", text: line.slice(1) });
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// 서버는 KST 벽시계로 받는다 — 브라우저 시간대와 무관하게 "지금 + 분"을 KST로 만든다
function kstAfterMinutes(minutes) {
  const date = new Date(Date.now() + minutes * 60_000);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date); // "2026-10-28 19:30"
  return parts.replace(" ", "T") + ":00";
}

function Panel({ label, other, onSession }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("Password123!");
  const [session, setSession] = useState(null); // { token, userId, nickname }
  const [log, setLog] = useState([]);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [startAt, setStartAt] = useState(kstAfterMinutes(30));
  const [distance, setDistance] = useState(5000);
  const [roomId, setRoomId] = useState("");
  const appStreamRef = useRef(null);
  const matchStreamRef = useRef(null);

  const push = (line) => setLog((prev) => [`${new Date().toLocaleTimeString()} ${line}`, ...prev].slice(0, 300));
  const show = (title, res) => push(`${title} ${res.status} ${res.body ? JSON.stringify(res.body) : ""}`);

  useEffect(() => () => {
    appStreamRef.current?.abort();
    matchStreamRef.current?.abort();
  }, []);

  async function login() {
    const res = await api("/auth/login", { method: "POST", body: { email, password } });
    push(`로그인 ${res.status}`);
    if (res.status !== 200) return push(JSON.stringify(res.body));
    const token = res.body.accessToken;
    const me = await api("/users/me", { token });
    const next = { token, userId: me.body?.userId, nickname: me.body?.nickname };
    setSession(next);
    onSession(next);
  }

  // ===== 스트림 =====

  function connect(path, ref, onEvent) {
    ref.current?.abort();
    const controller = new AbortController();
    ref.current = controller;
    openStream(
      path,
      session.token,
      (frame) => {
        if (frame.kind === "event") onEvent?.(frame);
        if (frame.kind === "comment" && frame.text === "ping") return; // 15초마다 오는 ping은 로그에서 뺀다
        push(frame.kind === "event" ? `[${frame.event}] ${JSON.stringify(frame.data)}` : `(${frame.kind}) ${frame.text}`);
      },
      controller.signal,
    ).catch((e) => push(`${path} 오류: ${e.name === "AbortError" ? "직접 끊음" : e.message}`));
  }

  // 받은 초대가 있으면 방 ID 칸을 채운다 — 초대받은 쪽은 방을 열지 않아 방 ID를 알 길이 알림뿐이다
  function fillRoomIdFrom(notifications) {
    const pending = notifications.find((item) => item.type === "RUNNING_INVITED" && item.invitation?.status === "PENDING");
    if (pending) setRoomId(String(pending.invitation.runningRoomId));
  }

  function connectAppStream() {
    connect("/app/stream", appStreamRef, (frame) => {
      if (frame.event === "NOTIFICATION_CREATED") {
        // 정한 흐름: 목록 맨 위에 붙이고 배지 +1
        setItems((prev) => [frame.data, ...prev]);
        setUnreadCount((count) => count + 1);
        fillRoomIdFrom([frame.data]);
      }
    });
  }

  // 초대 방 상태(초대 현황·입장)를 본다 — 활성 신청이 없으면 404다
  function connectMatchStream() {
    connect("/match-rooms/stream", matchStreamRef);
  }

  // ===== 상태·알림 =====

  async function myStatus() {
    show("2-2 내 상태", await api("/users/me/status", { token: session.token }));
  }

  async function loadFirstPage() {
    const res = await api("/users/me/notifications?limit=20", { token: session.token });
    push(`2-4 목록 ${res.status} — unreadCount=${res.body?.unreadCount}`);
    if (res.status !== 200) return push(JSON.stringify(res.body));
    setItems(res.body.items);
    setUnreadCount(res.body.unreadCount);
    setNextCursor(res.body.nextCursor);
    fillRoomIdFrom(res.body.items);
  }

  async function loadNextPage() {
    const res = await api(`/users/me/notifications?limit=20&cursor=${encodeURIComponent(nextCursor)}`, { token: session.token });
    push(`2-4 다음 페이지 ${res.status}`);
    if (res.status !== 200) return push(JSON.stringify(res.body));
    setItems((prev) => [...prev, ...res.body.items]);
    setNextCursor(res.body.nextCursor);
  }

  // 알림함을 여는 순서 — 목록을 먼저 그리고 읽음을 부른다
  async function openInbox() {
    await loadFirstPage();
    const res = await api("/users/me/notifications/read", { method: "POST", token: session.token });
    push(`2-5 모두 읽음 ${res.status}`);
    if (res.status === 204) setUnreadCount(0);
  }

  // 친구·초대 동작 뒤에는 목록을 다시 읽는다 — 항목의 버튼은 "지금 상태"로 그리므로 서버 상태를 다시 받아야 바뀐다
  async function act(title, request) {
    const res = await request;
    show(title, res);
    await loadFirstPage();
    return res;
  }

  // ===== 친구 =====

  async function friendRequest(targetId, name) {
    await act(`친구 요청 → ${name}`, api(`/users/${targetId}/friend-request`, { method: "POST", token: session.token }));
  }

  async function friendAccept(requesterId, name) {
    await act(`친구 수락 ← ${name}`, api(`/users/${requesterId}/friend-request`, { method: "PUT", token: session.token }));
  }

  // 받은 요청이면 거절, 보낸 요청이면 취소 — 같은 경로다
  async function friendDeclineOrCancel(targetId, name) {
    await act(`친구 요청 거절/취소 ↔ ${name}`, api(`/users/${targetId}/friend-request`, { method: "DELETE", token: session.token }));
  }

  async function unfriend(targetId, name) {
    await act(`친구 삭제 ✕ ${name}`, api(`/users/${targetId}/friend`, { method: "DELETE", token: session.token }));
  }

  // ===== 초대 러닝 =====

  async function openInviteRoom() {
    const res = await api("/match-rooms/invite", {
      method: "POST",
      token: session.token,
      body: { scheduledStartAt: startAt, targetDistanceMeters: Number(distance) },
    });
    show("초대 방 개설", res);
    if (res.status === 201) setRoomId(String(res.body.runningRoomId));
  }

  async function invite(inviteeId, name) {
    await act(`초대 → ${name} (방 ${roomId})`, api(`/match-rooms/${roomId}/invitations`, {
      method: "POST",
      token: session.token,
      body: { inviteeId },
    }));
  }

  async function inviteAccept(targetRoomId) {
    const res = await act(`초대 수락 (방 ${targetRoomId})`,
      api(`/match-rooms/${targetRoomId}/invitations/accept`, { method: "POST", token: session.token }));
    // 수락하면 초대 방에 들어간다 — 방 ID를 채워 나가기·매칭 스트림 연결을 바로 할 수 있게 한다
    if (res.status === 201) setRoomId(String(res.body.runningRoomId));
  }

  async function inviteDecline(targetRoomId) {
    await act(`초대 거절 (방 ${targetRoomId})`,
      api(`/match-rooms/${targetRoomId}/invitations/decline`, { method: "POST", token: session.token }));
  }

  async function leaveRoom() {
    await act("방 나가기", api("/match-rooms/leave", { method: "POST", token: session.token }));
  }

  // ===== 화면 =====

  // 알림 항목의 버튼은 "지금 상태"로 그린다 — 실제 앱 알림함과 같은 규칙
  function itemActions(item) {
    const actor = item.actor;
    if (item.type === "FRIEND_REQUESTED" && actor.relationshipType === "FRIEND_REQUEST_RECEIVED") {
      return (
        <>
          <button onClick={() => friendAccept(actor.userId, actor.nickname)}>수락</button>
          <button onClick={() => friendDeclineOrCancel(actor.userId, actor.nickname)}>거절</button>
        </>
      );
    }
    if (item.type === "RUNNING_INVITED" && item.invitation?.status === "PENDING") {
      return (
        <>
          <button onClick={() => inviteAccept(item.invitation.runningRoomId)}>초대 수락</button>
          <button onClick={() => inviteDecline(item.invitation.runningRoomId)}>초대 거절</button>
        </>
      );
    }
    return null;
  }

  return (
    <div style={styles.panel}>
      <h2 style={{ margin: 0 }}>
        {label} {session ? `— ${session.nickname}` : ""} <span style={styles.badge}>🔔 {unreadCount}</span>
      </h2>

      {!session ? (
        <div style={styles.row}>
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={login}>로그인</button>
        </div>
      ) : (
        <>
          <fieldset style={styles.box}>
            <legend>스트림 · 알림</legend>
            <div style={styles.row}>
              <button onClick={connectAppStream}>앱 스트림 연결</button>
              <button onClick={() => appStreamRef.current?.abort()}>앱 스트림 끊기</button>
              <button onClick={myStatus}>내 상태(2-2)</button>
            </div>
            <div style={styles.row}>
              <button onClick={loadFirstPage}>목록(2-4)</button>
              <button onClick={openInbox}>알림함 열기(2-4→2-5)</button>
              <button onClick={loadNextPage} disabled={!nextCursor}>다음 페이지</button>
            </div>
          </fieldset>

          <fieldset style={styles.box} disabled={!other}>
            <legend>친구 — 상대: {other?.nickname ?? "(반대쪽 로그인 필요)"}</legend>
            <div style={styles.row}>
              <button onClick={() => friendRequest(other.userId, other.nickname)}>친구 요청</button>
              <button onClick={() => friendAccept(other.userId, other.nickname)}>받은 요청 수락</button>
              <button onClick={() => friendDeclineOrCancel(other.userId, other.nickname)}>요청 거절/취소</button>
              <button onClick={() => unfriend(other.userId, other.nickname)}>친구 삭제</button>
            </div>
          </fieldset>

          <fieldset style={styles.box}>
            <legend>초대 러닝</legend>
            <div style={styles.row}>
              <label>
                시작(KST){" "}
                <input value={startAt} onChange={(e) => setStartAt(e.target.value)} style={{ width: 170 }} />
              </label>
              <button onClick={() => setStartAt(kstAfterMinutes(30))}>지금+30분</button>
              <label>
                거리(m){" "}
                <input type="number" value={distance} onChange={(e) => setDistance(e.target.value)} style={{ width: 80 }} />
              </label>
              <button onClick={openInviteRoom}>초대 방 개설</button>
            </div>
            <div style={styles.row}>
              <label>
                방 ID <input value={roomId} onChange={(e) => setRoomId(e.target.value)} style={{ width: 70 }} />
              </label>
              <button onClick={() => invite(other.userId, other.nickname)} disabled={!other || !roomId}>상대 초대</button>
              <button onClick={() => inviteAccept(roomId)} disabled={!roomId} title="방 ID가 비어 있으면 눌리지 않는다 — 목록(2-4)을 불러오면 받은 초대의 방 ID가 채워진다">초대 수락</button>
              <button onClick={() => inviteDecline(roomId)} disabled={!roomId}>초대 거절</button>
              <button onClick={leaveRoom}>방 나가기</button>
            </div>
            <div style={styles.row}>
              <button onClick={connectMatchStream}>매칭(초대 방) 스트림 연결</button>
              <button onClick={() => matchStreamRef.current?.abort()}>매칭 스트림 끊기</button>
            </div>
          </fieldset>
        </>
      )}

      <h3>알림 목록</h3>
      <ul style={styles.list}>
        {items.map((item) => (
          <li key={item.notificationId} style={{ fontWeight: item.isRead ? "normal" : "bold", marginBottom: 4 }}>
            #{item.notificationId} {item.type} — {item.actor.nickname}
            {item.actor.isDeleted ? " (탈퇴)" : ""} [관계: {item.actor.relationshipType ?? "null"}]
            {item.invitation
              ? ` [초대 ${item.invitation.status}, 방 ${item.invitation.runningRoomId}, ${item.invitation.scheduledStartAt}, ${item.invitation.targetDistanceMeters}m]`
              : ""}
            {item.isRead ? "" : " ●"} {itemActions(item)}
          </li>
        ))}
      </ul>

      <h3>로그</h3>
      <pre style={styles.log}>{log.join("\n")}</pre>
    </div>
  );
}

export default function App() {
  const [a, setA] = useState(null);
  const [b, setB] = useState(null);
  return (
    <div style={styles.page}>
      <Panel label="A" other={b} onSession={setA} />
      <Panel label="B" other={a} onSession={setB} />
    </div>
  );
}

const styles = {
  page: { display: "flex", gap: 16, padding: 16, fontFamily: "sans-serif" },
  panel: { flex: 1, border: "1px solid #ccc", borderRadius: 8, padding: 12, minWidth: 0 },
  box: { border: "1px solid #ddd", borderRadius: 6, margin: "8px 0" },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "6px 0" },
  badge: { fontSize: 14, background: "#eee", borderRadius: 12, padding: "2px 8px" },
  list: { paddingLeft: 18, fontSize: 13 },
  log: { background: "#111", color: "#0f0", fontSize: 12, height: 300, overflow: "auto", padding: 8, whiteSpace: "pre-wrap" },
};
