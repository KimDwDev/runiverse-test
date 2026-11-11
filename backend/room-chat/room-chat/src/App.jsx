import { useCallback, useEffect, useRef, useState } from "react";

// 대기방 채팅 수동 테스트 하네스(보내기·목록·수정·삭제) — 유저 A/B 두 패널. 프론트에 주는 문서(api-spec 5-E·슬롯 조회, feature-spec 대기방 채팅)
// 그대로 클라 동작을 따른다. 문서 규칙은 해당 코드 옆 주석에 [문서] 로 적었다.
// SSE는 EventSource 대신 fetch 스트림으로 읽는다 — Authorization·앱 버전 헤더를 그대로 실을 수 있다.

const API = "/api/v1";
const FIRST_PAGE_LIMIT = 50; // [문서 5-E] 목록 첫 페이지는 limit=50
const MAX_CONTENT = 200; // [문서 5-E-2] 1~200자, 공백만 불가
const BULK_COUNT = 100; // 테스트 도구 — 커서 확인용

// ---------- 시각 ----------

const pad = (n) => String(n).padStart(2, "0");
// 서버는 KST LocalDateTime(초 00)을 받는다 — 브라우저가 KST라고 가정한다
const toLocal = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDate(d);
};

// [문서 4-1] 초대 방: 지금 + 10분 이후, 오늘 23:59까지, 분 단위 — 기본은 지금 + 12분
function defaultInviteStart() {
  const d = new Date(Date.now() + 12 * 60_000);
  d.setSeconds(0, 0);
  return toLocal(d).slice(0, 16); // datetime-local 값
}

// ---------- HTTP ----------

function headersOf(config, token, json) {
  const h = { "X-App-Version": config.appVersion, "X-App-Platform": config.platform };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json) h["Content-Type"] = "application/json";
  return h;
}

// 네트워크 오류는 status 0으로 돌려준다 — "응답을 못 받음"을 화면이 가를 수 있게
async function call(config, token, method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: headersOf(config, token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, ok: false, data: { message: `네트워크 오류: ${e.message}` } };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

// ---------- SSE (fetch) ----------

async function openSse(config, token, path, { onOpen, onEvent, onClose, signal }) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: { ...headersOf(config, token, false), Accept: "text/event-stream" },
      signal,
    });
  } catch (e) {
    onClose(`연결 실패: ${e.message}`);
    return;
  }
  onOpen(res.status);
  if (!res.ok || !res.body) {
    onClose(`HTTP ${res.status}`);
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop();
      for (const frame of frames) {
        let name = null;
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(":")) continue; // keep-alive·connected 주석
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trim());
        }
        if (!name) continue;
        let parsed = data.join("\n");
        try {
          parsed = JSON.parse(parsed);
        } catch {
          /* 문자열 그대로 */
        }
        onEvent(name, parsed);
      }
    }
    onClose("서버가 스트림을 닫았습니다");
  } catch (e) {
    onClose(e.name === "AbortError" ? "직접 끊음" : `끊김: ${e.message}`);
  }
}

// ---------- 패널 ----------

function UserPanel({ label, config, other, onIdentity }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [me, setMe] = useState(null); // { userId, nickname, token }
  const [log, setLog] = useState([]);

  const [status, setStatus] = useState(null);
  const [friends, setFriends] = useState([]);
  const [notifications, setNotifications] = useState([]);

  // 매칭 신청 — [문서 슬롯 조회] 시각·거리는 서버가 내려 준 슬롯에서 고른다
  const [slotDate, setSlotDate] = useState(dayOffset(0));
  const [distances, setDistances] = useState([]);
  const [distance, setDistance] = useState(null);
  const [slot, setSlot] = useState("");

  const [inviteStart, setInviteStart] = useState(defaultInviteStart);
  const [inviteDistance, setInviteDistance] = useState(5000);
  const [roomId, setRoomId] = useState(null);

  const [streamState, setStreamState] = useState("끊김");
  const [room, setRoom] = useState(null);

  // 채팅 — chatId → Chat. [문서 5-E] 같은 chatId는 나중에 받은 쪽으로 덮는다
  const [chats, setChats] = useState({});
  const [nextCursor, setNextCursor] = useState(null);
  const [listState, setListState] = useState("안 불러옴"); // 안 불러옴 | 불러오는 중 | 더 있음 | 끝
  const [pages, setPages] = useState([]);
  const [chatClosed, setChatClosed] = useState(false); // [문서 5-E] ROOM_CHAT_CLOSED면 입력을 닫는다
  const [content, setContent] = useState("");
  const [failedSends, setFailedSends] = useState([]); // [문서 5-E] 응답을 못 받은 보내기 — 자동 재전송하지 않는다
  const [clientValidation, setClientValidation] = useState(true);
  const [bulk, setBulk] = useState(null);
  // 수정 — 한 번에 한 메시지만 고친다. [문서 5-E-3] 같은 요청 검증
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [showActionsOnAll, setShowActionsOnAll] = useState(false); // 테스트 도구 — 남의 것·지운 것에도 버튼(404 확인)

  const abortRef = useRef(null);
  const chatEndRef = useRef(null);
  const messagesRef = useRef(null);
  const keepScrollRef = useRef(null); // 이전 페이지를 위에 붙일 때 보던 자리를 지킨다
  const loadingOlderRef = useRef(false);
  const bulkStopRef = useRef(false);

  const token = me?.token;
  const add = useCallback((kind, text) => {
    const time = new Date().toLocaleTimeString();
    setLog((prev) => [{ time, kind, text }, ...prev].slice(0, 300));
  }, []);

  // 응답을 로그에 남기고 그대로 돌려준다. quiet면 성공은 남기지 않는다(대량 보내기용)
  const api = useCallback(
    async (method, path, body, quiet = false) => {
      const r = await call(config, token, method, path, body);
      if (!quiet || !r.ok) {
        add(r.ok ? "ok" : "err", `${method} ${path} → ${r.status} ${r.data ? JSON.stringify(r.data) : ""}`);
      }
      return r;
    },
    [config, token, add]
  );

  const mergeChats = useCallback((list) => {
    setChats((prev) => {
      const next = { ...prev };
      for (const chat of list) next[chat.chatId] = chat;
      return next;
    });
  }, []);

  // 새 메시지는 아래로, 이전 페이지를 붙였을 때는 보던 자리 유지. 수정·삭제는 건수가 그대로라 스크롤하지 않는다
  const chatCount = Object.keys(chats).length;
  useEffect(() => {
    const box = messagesRef.current;
    if (keepScrollRef.current != null && box) {
      box.scrollTop = box.scrollHeight - keepScrollRef.current;
      keepScrollRef.current = null;
    } else {
      chatEndRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [chatCount]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 방에서 나가거나 로그아웃하면 방에 딸린 화면 상태를 싹 비운다
  function clearRoomView() {
    setRoom(null);
    setRoomId(null);
    setChats({});
    setNextCursor(null);
    setListState("안 불러옴");
    setPages([]);
    setChatClosed(false);
    setFailedSends([]);
    setContent("");
    setBulk(null);
    setEditingId(null);
    setEditText("");
    bulkStopRef.current = true;
  }

  // 에러 응답 중 채팅에 의미 있는 것을 화면 상태로 옮긴다
  function applyChatError(r) {
    if (r.status === 409 && r.data?.code === "ROOM_CHAT_CLOSED") {
      setChatClosed(true); // [문서 5-E 공통 409] 클라는 채팅 입력을 닫는다
    }
  }

  // ----- 인증 -----

  async function login() {
    const r = await call(config, null, "POST", "/auth/login", { email: email.trim().toLowerCase(), password });
    add(r.ok ? "ok" : "err", `POST /auth/login → ${r.status}`);
    if (!r.ok) return;
    const profile = await call(config, r.data.accessToken, "GET", "/users/me");
    const identity = { userId: r.data.userId, token: r.data.accessToken, nickname: profile.data?.nickname ?? "?" };
    setMe(identity);
    onIdentity(identity);
  }

  function logout() {
    disconnect();
    clearRoomView();
    setStatus(null);
    setMe(null);
    onIdentity(null);
  }

  // ----- 상태·친구·알림 -----

  async function refreshStatus() {
    const r = await api("GET", "/users/me/status");
    if (r.ok) {
      setStatus(r.data);
      setRoomId(r.data?.runningRoomId ?? null);
    }
    return r.ok ? r.data : null;
  }

  async function refreshFriends() {
    const r = await api("GET", `/users/${me.userId}/friends`);
    if (r.ok) setFriends(r.data.items ?? []);
  }

  async function refreshNotifications() {
    const r = await api("GET", "/users/me/notifications");
    if (r.ok) setNotifications(r.data.items ?? []);
  }

  // ----- 매칭 신청 -----

  async function loadSlots() {
    const r = await api("GET", `/match-rooms/slots?date=${slotDate}`);
    if (!r.ok) return;
    const list = r.data.distances ?? [];
    setDistances(list);
    const d = list.find((x) => x.targetDistanceMeters === distance) ?? list[0];
    setDistance(d?.targetDistanceMeters ?? null);
    setSlot(d?.slots.find((s) => s.selectable)?.scheduledStartAt ?? "");
  }

  async function applyMatch() {
    const r = await api("POST", "/match-rooms", { scheduledStartAt: slot, targetDistanceMeters: Number(distance) });
    if (r.ok) setRoomId(r.data.runningRoomId);
  }

  // ----- 초대 방 -----

  async function openInvite() {
    const r = await api("POST", "/match-rooms/invite", {
      scheduledStartAt: `${inviteStart}:00`,
      targetDistanceMeters: Number(inviteDistance),
    });
    if (r.ok) setRoomId(r.data.runningRoomId);
  }

  async function invite(inviteeId) {
    await api("POST", `/match-rooms/${roomId}/invitations`, { inviteeId });
  }

  async function acceptInvitation(runningRoomId) {
    const r = await api("POST", `/match-rooms/${runningRoomId}/invitations/accept`);
    if (r.ok) {
      setRoomId(r.data.runningRoomId);
      refreshNotifications();
    }
  }

  async function declineInvitation(runningRoomId) {
    await api("POST", `/match-rooms/${runningRoomId}/invitations/decline`);
    refreshNotifications();
  }

  async function leave() {
    const r = await api("POST", "/match-rooms/leave");
    if (r.ok) {
      disconnect();
      clearRoomView();
      setStatus(null);
    }
  }

  // ----- 스트림과 입장 순서 -----

  // [문서 5-E] 방에 들어가거나 다시 연결하면: 1) 스트림을 연다 2) 연결되면 목록 limit=50 3) chatId로 합친다.
  // 입장 이벤트(MATCH_ROOM_ENTRANCE·INVITE_ROOM_ENTRANCE)는 기다리지 않는다 — 방 정보 갱신에만 쓴다
  async function connect() {
    // 방 ID는 신청·수락 응답이나 상태 조회가 알려 준다 — 모르면 상태 조회로 먼저 얻는다
    let targetRoomId = roomId;
    if (!targetRoomId) {
      const s = await refreshStatus();
      targetRoomId = s?.runningRoomId ?? null;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamState("연결 중");
    openSse(config, token, "/match-rooms/stream", {
      signal: controller.signal,
      onOpen: (code) => {
        setStreamState(code === 200 ? "연결됨" : `거절 ${code}`);
        add(code === 200 ? "sse" : "err", `GET /match-rooms/stream → ${code}`);
        // 연결이 열린 뒤에 목록을 부른다 — 순서를 거꾸로 하면 그 사이 메시지를 잃는다
        if (code === 200 && targetRoomId) loadFirstPage(targetRoomId);
      },
      onEvent: (name, data) => {
        add("sse", `${name} ${JSON.stringify(data)}`);
        if (name.endsWith("_ENTRANCE") || name.endsWith("_UPDATED") || name === "MATCH_CONFIRMED") {
          setRoom({ event: name, ...data });
          setRoomId(data.runningRoomId);
        } else if (name.startsWith("ROOM_CHAT_")) {
          // [문서 5-E] SENT·EDITED·DELETED 모두 data = Chat 전체 — chatId로 찾아 있으면 덮고 없으면 넣는다.
          // 내가 고치던 메시지를 상대 쪽 일로 덮을 일은 없다(남의 것은 고칠 수 없다)
          mergeChats([data]);
        }
      },
      onClose: (reason) => {
        setStreamState("끊김");
        // [문서 5-E] 채팅 이벤트는 변경분이라 놓친 것은 다시 오지 않는다 — 다시 연결하면 목록으로 맞춘다
        add("sse", `스트림 종료 — ${reason} (다시 연결하면 목록을 다시 받습니다)`);
      },
    });
  }

  function disconnect() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  // ----- 채팅 목록 (5-E-1) -----

  async function fetchPage(targetRoomId, cursor, limit) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    setListState("불러오는 중");
    const r = await api("GET", `/match-rooms/${targetRoomId}/chats?${query}`);
    if (!r.ok) {
      applyChatError(r);
      setListState(nextCursor ? "더 있음" : "끝");
      return null;
    }
    const items = r.data.items ?? []; // [문서] 최신순으로 온다 — 화면은 뒤집어 아래가 최신
    const next = r.data.nextCursor;
    setNextCursor(next);
    setListState(next ? "더 있음" : "끝");
    setPages((prev) => [
      ...prev,
      {
        n: prev.length + 1,
        count: items.length,
        newestId: items[0]?.chatId ?? "-",
        oldestId: items.at(-1)?.chatId ?? "-",
        cursorIn: cursor ?? "(첫 페이지)",
      },
    ]);
    return { items, next };
  }

  // 입장·재연결 경로 — 화면을 비우고 첫 페이지부터
  async function loadFirstPage(targetRoomId = roomId) {
    if (!targetRoomId) return;
    setChats({});
    setPages([]);
    setChatClosed(false);
    const page = await fetchPage(targetRoomId, null, FIRST_PAGE_LIMIT);
    if (page) mergeChats(page.items);
  }

  // [문서 5-E] 위로 올리면 더 이전 메시지를 이어 받는다
  async function loadOlder() {
    if (!roomId || !nextCursor || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    const box = messagesRef.current;
    keepScrollRef.current = box ? box.scrollHeight - box.scrollTop : null;
    const page = await fetchPage(roomId, nextCursor, FIRST_PAGE_LIMIT);
    if (page) mergeChats(page.items);
    loadingOlderRef.current = false;
  }

  function onMessagesScroll(e) {
    if (e.currentTarget.scrollTop < 8 && nextCursor) loadOlder();
  }

  // ----- 채팅 보내기 (5-E-2) -----

  // [문서 api-spec 공통] 필드 단위 안내는 클라 자체 검증으로 한다 — 서버 400 문구를 파싱하지 않는다
  function validate(text) {
    if (!text.trim()) return "메시지를 입력하세요.";
    if (text.length > MAX_CONTENT) return `${MAX_CONTENT}자까지 보낼 수 있습니다.`;
    return null;
  }

  async function postChat(text) {
    const r = await api("POST", `/match-rooms/${roomId}/chats`, { content: text });
    if (r.status === 201) {
      mergeChats([r.data]); // [문서] 보낸 사람에게는 이벤트가 오지 않는다 — 응답으로 그린다
      return { ok: true };
    }
    applyChatError(r);
    // 응답을 못 받았거나 서버 오류 — 저장됐을 수도 있어 자동으로 다시 보내지 않는다
    if (r.status === 0 || r.status >= 500) return { ok: false, retryable: true };
    return { ok: false, retryable: false };
  }

  async function sendChat(e) {
    e.preventDefault();
    if (!roomId || chatClosed) return;
    if (clientValidation) {
      const problem = validate(content);
      if (problem) {
        add("err", `클라 검증: ${problem}`);
        return;
      }
    }
    const text = content;
    setContent("");
    const result = await postChat(text);
    if (!result.ok && result.retryable) {
      setFailedSends((prev) => [...prev, { id: crypto.randomUUID(), text }]);
    } else if (!result.ok) {
      setContent(text); // 4xx는 입력을 되돌려 고칠 수 있게
    }
  }

  // [문서 5-E] "다시 보내기"는 사용자가 누를 때만 — 서버에 이미 저장됐을 수 있다(다음 입장 때 목록이 알려준다)
  async function retrySend(item) {
    const result = await postChat(item.text);
    if (result.ok || !result.retryable) setFailedSends((prev) => prev.filter((f) => f.id !== item.id));
  }

  // ----- 채팅 수정 (5-E-3) -----

  function startEdit(chat) {
    setEditingId(chat.chatId);
    setEditText(chat.content ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditText("");
  }

  async function saveEdit(e, chat) {
    e.preventDefault();
    if (clientValidation) {
      const problem = validate(editText);
      if (problem) {
        add("err", `클라 검증: ${problem}`);
        return;
      }
      // [문서 5-E-3] 같은 내용으로 고쳐도 서버는 수정으로 친다 — 바뀐 게 없으면 부르지 않는다
      if (editText === chat.content) {
        add("ok", `#${chat.chatId} 바뀐 내용이 없어 부르지 않음`);
        cancelEdit();
        return;
      }
    }
    const r = await api("PATCH", `/match-rooms/${roomId}/chats/${chat.chatId}`, { content: editText });
    if (r.status === 200) {
      mergeChats([r.data]); // [문서] 고친 사람에게는 이벤트가 오지 않는다 — 응답(고친 뒤의 Chat)으로 그린다
      cancelEdit();
      return;
    }
    applyChatError(r);
    if (r.status === 409) cancelEdit();
    // 404 — 없음·이미 지움·남의 것(서버가 가르지 않는다). 편집창은 남겨 로그와 함께 본다
  }

  // ----- 채팅 삭제 (5-E-4) -----

  async function deleteChat(chat) {
    if (!window.confirm(`#${chat.chatId} 메시지를 지울까요? 되돌릴 수 없습니다.`)) return;
    const r = await api("DELETE", `/match-rooms/${roomId}/chats/${chat.chatId}`);
    if (r.status === 204) {
      // [문서 5-E-4] 204 — 본인 화면은 그 말풍선을 "삭제된 메시지"로 바꾼다(목록·이벤트와 같은 모양으로 맞춘다)
      mergeChats([{ ...chat, content: null, isDeleted: true }]);
      if (editingId === chat.chatId) cancelEdit();
      return;
    }
    applyChatError(r);
  }

  // 테스트 도구 — 순서가 섞이지 않게 하나씩 차례로 보낸다
  async function sendBulk() {
    if (!roomId || bulk?.running || chatClosed) return;
    bulkStopRef.current = false;
    const target = roomId;
    let failed = 0;
    setBulk({ running: true, done: 0, total: BULK_COUNT, failed: 0 });
    for (let i = 1; i <= BULK_COUNT; i++) {
      if (bulkStopRef.current) break;
      const r = await api("POST", `/match-rooms/${target}/chats`, { content: `자동 메시지 #${i}` }, true);
      if (r.status === 201) mergeChats([r.data]);
      else {
        failed++;
        applyChatError(r);
        if (r.status === 409) break;
      }
      setBulk({ running: true, done: i, total: BULK_COUNT, failed });
    }
    setBulk((prev) => (prev ? { ...prev, running: false } : prev));
    add(failed ? "err" : "ok", `대량 보내기 끝 — 실패 ${failed}건`);
  }

  // 테스트 도구 — 커서를 null이 될 때까지 따라가 겹침·빠짐을 본다
  async function verifyAllPages() {
    if (!roomId) return;
    setChats({});
    setPages([]);
    let cursor = null;
    const seen = new Set();
    let total = 0;
    let duplicated = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const page = await fetchPage(roomId, cursor, FIRST_PAGE_LIMIT);
      if (!page) return;
      for (const c of page.items) {
        if (seen.has(c.chatId)) duplicated++;
        seen.add(c.chatId);
      }
      total += page.items.length;
      mergeChats(page.items);
      if (!page.next) break;
      cursor = page.next;
    }
    add(duplicated ? "err" : "ok", `전체 페이지 확인 — ${total}건, 페이지 사이 중복 ${duplicated}건`);
  }

  const sortedChats = Object.values(chats).sort((a, b) => a.chatId - b.chatId); // [문서] chatId로 정렬
  const otherRelation = friends.find((f) => f.userId === other?.userId)?.relationshipType ?? "NONE";
  const currentSlots = distances.find((d) => d.targetDistanceMeters === distance)?.slots ?? [];
  const inputProblem = clientValidation && content ? validate(content) : null;
  const editProblem = clientValidation && editingId != null ? validate(editText) : null;

  // ----- 화면 -----

  if (!me) {
    return (
      <section className="panel">
        <h2>{label}</h2>
        <div className="row">
          <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={login}>로그인</button>
        </div>
        <Log log={log} />
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>
        {label} · {me.nickname} <small>{me.userId}</small>
        <button className="ghost" onClick={logout}>로그아웃</button>
      </h2>

      <fieldset>
        <legend>상태</legend>
        <div className="row">
          <button onClick={refreshStatus}>상태 조회</button>
          <span>{status ? `${status.status} · room ${status.runningRoomId ?? "-"} · ${status.type ?? ""}` : "-"}</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>친구 (상대: {other ? other.nickname : "로그인 안 함"} · 관계 {otherRelation})</legend>
        <div className="row">
          <button disabled={!other} onClick={() => api("POST", `/users/${other.userId}/friend-request`).then(refreshFriends)}>
            상대에게 친구 요청
          </button>
          <button onClick={refreshFriends}>친구·요청 목록</button>
        </div>
        <ul>
          {friends.map((f) => (
            <li key={f.userId}>
              {f.nickname} — {f.relationshipType}
              {f.relationshipType === "FRIEND_REQUEST_RECEIVED" && (
                <>
                  <button onClick={() => api("PUT", `/users/${f.userId}/friend-request`).then(refreshFriends)}>수락</button>
                  <button onClick={() => api("DELETE", `/users/${f.userId}/friend-request`).then(refreshFriends)}>거절</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>매칭 신청 (슬롯 조회 API)</legend>
        <div className="row">
          <select value={slotDate} onChange={(e) => setSlotDate(e.target.value)}>
            <option value={dayOffset(0)}>오늘 {dayOffset(0)}</option>
            <option value={dayOffset(1)}>내일 {dayOffset(1)}</option>
          </select>
          <button onClick={loadSlots}>슬롯 불러오기</button>
          <select value={distance ?? ""} onChange={(e) => setDistance(Number(e.target.value))} disabled={!distances.length}>
            {distances.map((d) => (
              <option key={d.targetDistanceMeters} value={d.targetDistanceMeters}>{d.targetDistanceMeters / 1000}km</option>
            ))}
          </select>
          <select value={slot} onChange={(e) => setSlot(e.target.value)} disabled={!currentSlots.length}>
            <option value="">시각 선택</option>
            {currentSlots.map((s) => (
              // [문서] selectable=false는 마감이 지난 슬롯 — 목록에는 남기되 선택은 막는다
              <option key={s.scheduledStartAt} value={s.scheduledStartAt} disabled={!s.selectable}>
                {s.scheduledStartAt.slice(11, 16)} · {s.waitingCount}명 대기{s.selectable ? "" : " (마감)"}
              </option>
            ))}
          </select>
          <button disabled={!slot} onClick={applyMatch}>매칭 신청</button>
        </div>
      </fieldset>

      <fieldset>
        <legend>초대 방</legend>
        <div className="row">
          <input type="datetime-local" value={inviteStart} onChange={(e) => setInviteStart(e.target.value)} />
          <input className="narrow" type="number" step="100" value={inviteDistance} onChange={(e) => setInviteDistance(e.target.value)} />
          <button onClick={openInvite}>초대 방 개설</button>
          <button disabled={!other || !roomId} onClick={() => invite(other.userId)}>상대 초대</button>
          <button onClick={refreshNotifications}>받은 알림</button>
        </div>
        <ul>
          {notifications
            .filter((n) => n.type === "RUNNING_INVITED")
            .map((n) => (
              <li key={n.notificationId}>
                {n.actor.nickname}의 초대 · room {n.invitation.runningRoomId} · {n.invitation.status}
                {n.invitation.status === "PENDING" && (
                  <>
                    <button onClick={() => acceptInvitation(n.invitation.runningRoomId)}>수락</button>
                    <button onClick={() => declineInvitation(n.invitation.runningRoomId)}>거절</button>
                  </>
                )}
              </li>
            ))}
        </ul>
      </fieldset>

      <fieldset>
        <legend>방 · room {roomId ?? "-"} · 스트림 {streamState}</legend>
        <div className="row">
          <button onClick={connect}>입장(스트림 연결 → 목록)</button>
          <button onClick={disconnect}>끊기</button>
          <button onClick={leave}>나가기</button>
        </div>
        {room && (
          <div className="room">
            <b>{room.event}</b> · {room.type} · {room.status} · 시작 {room.scheduledStartAt} · 마감 {room.closeAt}
            {room.startsInMs != null && <> · {Math.round(room.startsInMs / 1000)}초 남음</>}
            <div>참가자: {room.players?.map((p) => p.nickname).join(", ")}</div>
            {room.invitations?.length > 0 && (
              <div>초대 대기: {room.invitations.map((i) => i.nickname).join(", ")}</div>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="chat">
        <legend>채팅 · 화면에 {sortedChats.length}건 · 목록 {listState}</legend>
        <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
          {nextCursor && <div className="older">▲ 위로 올리면 이전 메시지를 더 불러옵니다</div>}
          {listState === "끝" && sortedChats.length > 0 && <div className="older">— 방의 첫 메시지 —</div>}
          {sortedChats.length === 0 && <div className="empty">메시지가 없습니다</div>}
          {sortedChats.map((c) => {
            const mine = c.sender.userId === me.userId;
            // [문서 5-E] 수정·삭제는 보낸 본인만, 지운 메시지는 고치거나 지울 수 없다 — 버튼도 그때만 보인다
            const changeable = mine && !c.isDeleted && !chatClosed;
            const showActions = changeable || (showActionsOnAll && !chatClosed);
            const editing = editingId === c.chatId;
            return (
              <div key={c.chatId} className={`msg ${mine ? "mine" : ""}`}>
                <span className="who">
                  {c.sender.profileImageUrl ? <img className="avatar" src={c.sender.profileImageUrl} alt="" /> : <span className="avatar" />}
                  {c.sender.nickname}
                  {c.sender.isDeleted && " (탈퇴)"}
                </span>
                {editing ? (
                  <form className="edit" onSubmit={(e) => saveEdit(e, c)}>
                    <input
                      autoFocus
                      value={editText}
                      maxLength={clientValidation ? MAX_CONTENT : 300}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && cancelEdit()}
                    />
                    <span className={`count ${editProblem ? "bad" : ""}`}>{editText.length}/{MAX_CONTENT}</span>
                    <button disabled={!!editProblem}>저장</button>
                    <button type="button" onClick={cancelEdit}>취소</button>
                  </form>
                ) : (
                  // [문서] 지운 메시지는 content=null — "삭제된 메시지"로 그린다
                  <span className={`bubble ${c.isDeleted ? "deleted" : ""}`}>{c.isDeleted ? "삭제된 메시지" : c.content}</span>
                )}
                <span className="meta">
                  {c.createdAt.slice(11, 16)}
                  {/* [문서] editedAt이 있으면 "수정됨" — 지운 메시지는 내용이 없어 붙이지 않는다 */}
                  {c.editedAt && !c.isDeleted && <span title={`수정 ${c.editedAt}`}> · 수정됨</span>}
                  <span className="id"> #{c.chatId}</span>
                  {showActions && !editing && (
                    <>
                      {" · "}
                      <button className={`link ${changeable ? "" : "probe"}`} onClick={() => startEdit(c)}>수정</button>
                      {" · "}
                      <button className={`link ${changeable ? "" : "probe"}`} onClick={() => deleteChat(c)}>삭제</button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
          {failedSends.map((f) => (
            <div key={f.id} className="msg mine">
              <span className="bubble failed">{f.text}</span>
              <span className="meta">
                보내지 못함 · <button className="link" onClick={() => retrySend(f)}>다시 보내기</button>
                {" · "}
                <button className="link" onClick={() => setFailedSends((prev) => prev.filter((x) => x.id !== f.id))}>지우기</button>
              </span>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        {chatClosed ? (
          <div className="closed">러닝이 시작돼 채팅을 할 수 없습니다 (ROOM_CHAT_CLOSED)</div>
        ) : (
          <form className="row" onSubmit={sendChat}>
            <input
              className="grow"
              placeholder={roomId ? `메시지 (1~${MAX_CONTENT}자)` : "먼저 방에 들어가세요"}
              value={content}
              maxLength={clientValidation ? MAX_CONTENT : 300}
              onChange={(e) => setContent(e.target.value)}
            />
            <span className={`count ${inputProblem ? "bad" : ""}`}>{content.length}/{MAX_CONTENT}</span>
            <button disabled={!roomId || (clientValidation && !!validate(content))}>보내기</button>
          </form>
        )}
      </fieldset>

      <details className="tools">
        <summary>테스트 도구 (문서 밖 — 커서·서버 검증 확인용)</summary>
        <div className="row">
          <button disabled={!roomId || bulk?.running || chatClosed} onClick={sendBulk}>{BULK_COUNT}개 보내기</button>
          {bulk?.running && <button onClick={() => { bulkStopRef.current = true; }}>멈춤</button>}
          {bulk && (
            <span className="small">
              {bulk.done}/{bulk.total} 보냄{bulk.failed ? ` · 실패 ${bulk.failed}` : ""}{bulk.running ? "" : " · 끝"}
            </span>
          )}
        </div>
        <div className="row">
          <button disabled={!roomId} onClick={() => loadFirstPage()}>첫 페이지 다시</button>
          <button disabled={!roomId || !nextCursor} onClick={loadOlder}>이전 페이지 버튼으로</button>
          <button disabled={!roomId} onClick={verifyAllPages}>전체 페이지 확인</button>
          <button onClick={() => { setChats({}); setPages([]); setNextCursor(null); setListState("안 불러옴"); }}>화면만 비우기</button>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={!clientValidation} onChange={(e) => setClientValidation(!e.target.checked)} />
            클라 검증 끄기 (빈 문자열·201자·같은 내용 수정을 서버로 보내 400·200 확인)
          </label>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={showActionsOnAll} onChange={(e) => setShowActionsOnAll(e.target.checked)} />
            남의 메시지·지운 메시지에도 수정·삭제 버튼 보이기 (404 확인 — 빨간 버튼)
          </label>
        </div>
        <div className="row small">nextCursor: <code>{nextCursor ?? "null"}</code></div>
        {pages.length > 0 && (
          <table className="pages">
            <thead>
              <tr><th>#</th><th>건수</th><th>최신 id</th><th>가장 오래된 id</th><th>보낸 cursor</th></tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.n}>
                  <td>{p.n}</td><td>{p.count}</td><td>{p.newestId}</td><td>{p.oldestId}</td>
                  <td className="ellipsis">{p.cursorIn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      <Log log={log} />
    </section>
  );
}

function Log({ log }) {
  return (
    <fieldset>
      <legend>로그</legend>
      <div className="log">
        {log.map((l, i) => (
          <div key={i} className={l.kind}>
            [{l.time}] {l.text}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

export default function App() {
  const [config, setConfig] = useState({ appVersion: "9.9.9", platform: "ANDROID" });
  const [a, setA] = useState(null);
  const [b, setB] = useState(null);

  return (
    <>
      <style>{CSS}</style>
      <header>
        <b>Runiverse 대기방 채팅 하네스</b>
        <label>
          X-App-Version <input value={config.appVersion} onChange={(e) => setConfig({ ...config, appVersion: e.target.value })} />
        </label>
        <label>
          X-App-Platform
          <select value={config.platform} onChange={(e) => setConfig({ ...config, platform: e.target.value })}>
            <option>ANDROID</option>
            <option>IOS</option>
          </select>
        </label>
      </header>
      <main>
        <UserPanel label="유저 A" config={config} other={b} onIdentity={setA} />
        <UserPanel label="유저 B" config={config} other={a} onIdentity={setB} />
      </main>
    </>
  );
}

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #f4f5f7; color: #1d1f23; }
header { display: flex; gap: 16px; align-items: center; padding: 8px 16px; background: #1d1f23; color: #fff; flex-wrap: wrap; }
header input, header select { width: 90px; margin-left: 4px; }
main { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
.panel { background: #fff; border-radius: 8px; padding: 12px; min-width: 0; }
h2 { margin: 0 0 8px; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
h2 small { color: #888; font-weight: normal; font-size: 11px; }
fieldset { border: 1px solid #e2e4e8; border-radius: 6px; margin: 0 0 8px; padding: 6px 8px; min-width: 0; }
legend { font-weight: 600; padding: 0 4px; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 4px 0; }
.small { font-size: 11px; color: #666; }
.small code { word-break: break-all; }
.grow { flex: 1; min-width: 120px; }
.narrow { width: 70px; }
button { cursor: pointer; padding: 3px 8px; }
button:disabled { cursor: default; }
button.ghost { margin-left: auto; }
button.link { border: none; background: none; color: #0550ae; padding: 0; text-decoration: underline; font-size: 10px; }
ul { margin: 4px 0; padding-left: 18px; }
li button { margin-left: 4px; }
.room { background: #f0f6ff; border-radius: 4px; padding: 6px; margin-top: 4px; }
.messages { height: 340px; overflow-y: auto; background: #fafbfc; border-radius: 4px; padding: 6px; }
.older { text-align: center; color: #999; font-size: 11px; margin-bottom: 6px; }
.empty { color: #999; }
.msg { display: flex; flex-direction: column; align-items: flex-start; margin: 4px 0; }
.msg.mine { align-items: flex-end; }
.who { font-size: 11px; color: #666; display: flex; align-items: center; gap: 4px; }
.avatar { width: 16px; height: 16px; border-radius: 50%; background: #d0d4da; display: inline-block; object-fit: cover; }
.bubble { background: #e9ebef; border-radius: 10px; padding: 4px 10px; max-width: 80%; word-break: break-all; }
.mine .bubble { background: #ffe066; }
.bubble.deleted { background: #f1f1f1; color: #999; font-style: italic; }
.bubble.failed { background: #ffe1e1; }
.edit { display: flex; gap: 4px; align-items: center; max-width: 90%; }
.edit input { min-width: 180px; }
button.link.probe { color: #cf222e; }
.meta { font-size: 10px; color: #999; }
.meta .id { color: #bbb; }
.count { color: #888; font-size: 11px; }
.count.bad { color: #cf222e; }
.closed { background: #fff4e5; color: #8a5300; padding: 6px; border-radius: 4px; text-align: center; }
.tools { border: 1px dashed #c8ccd2; border-radius: 6px; margin: 0 0 8px; padding: 6px 8px; }
.tools summary { cursor: pointer; font-weight: 600; color: #555; }
.pages { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; table-layout: fixed; }
.pages th, .pages td { border-bottom: 1px solid #eee; padding: 2px 4px; text-align: left; }
.pages .ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log { height: 160px; overflow-y: auto; font: 11px/1.35 ui-monospace, monospace; }
.log .ok { color: #1a7f37; } .log .err { color: #cf222e; } .log .sse { color: #0550ae; }
`;
