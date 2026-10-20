import { useState } from "react";

const API = "http://localhost:8080/api/v1";

// 프로필·배경이 다른 점은 여기에만 둔다 — 아래 함수들은 종류로 분기하지 않는다
const IMAGE_TYPES = {
  profile: {
    label: "프로필",
    path: "profile-image",
    keyField: "profileImageKey",
    urlField: "profileImageUrl",
  },
  background: {
    label: "배경",
    path: "background-image",
    keyField: "backgroundImageKey",
    urlField: "backgroundImageUrl",
  },
};

const MAX_SIZE_BYTES = 10 * 1024 * 1024;

export default function App() {
  const [email, setEmail] = useState("runner@runiverse.com");
  const [password, setPassword] = useState("Password123!");
  const [auth, setAuth] = useState(null);
  const [files, setFiles] = useState({ profile: null, background: null });
  const [urls, setUrls] = useState({ profile: null, background: null });
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState(false);

  const log = (msg) => setLogs((prev) => [...prev, msg]);

  // 서버 에러는 { code, message } 평면 구조로 온다. 204는 본문이 없어 null이 된다
  async function callApi(path, options) {
    const res = await fetch(`${API}${path}`, options);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${res.status} ${body?.code ?? ""} ${body?.message ?? ""}`);
    }
    return body;
  }

  function authHeaders(json = true) {
    const headers = { Authorization: `Bearer ${auth.accessToken}` };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function login() {
    setBusy(true);
    try {
      const body = await callApi("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      setAuth({ accessToken: body.accessToken, userId: body.userId });
      log(`로그인 성공 — userId=${body.userId}`);
      await refreshAll(body.userId);
    } catch (e) {
      log(`로그인 실패 — ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // 조회는 공개 경로라 토큰을 싣지 않는다 — 401이 나면 공개 설정이 빠진 것이다
  async function refresh(typeName, userId = auth?.userId) {
    const type = IMAGE_TYPES[typeName];
    try {
      const body = await callApi(`/users/${userId}/${type.path}`, { method: "GET" });
      const url = body[type.urlField];
      setUrls((prev) => ({ ...prev, [typeName]: url }));
      log(`[${type.label}] 조회 — ${url ? "URL 있음" : "null (등록 안 됨)"}`);
    } catch (e) {
      log(`[${type.label}] 조회 실패 — ${e.message}`);
    }
  }

  async function refreshAll(userId = auth?.userId) {
    await Promise.all(Object.keys(IMAGE_TYPES).map((typeName) => refresh(typeName, userId)));
  }

  async function uploadAndSave(typeName) {
    const type = IMAGE_TYPES[typeName];
    const file = files[typeName];
    if (!auth || !file) return;
    setBusy(true);
    try {
      // 1) 발급 — 크기가 서명에 들어가므로 실제 file.size를 그대로 보낸다
      const issued = await callApi(`/users/me/${type.path}/presigned-url`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ mimeType: file.type, fileSizeBytes: file.size }),
      });
      const key = issued[type.keyField];
      log(`[${type.label}] 발급 성공 — ${key}`);

      // 2) S3 직접 업로드 — 서버를 거치지 않는다
      //    Content-Type이 발급 때와 다르면 403, Content-Length는 브라우저가 file.size로 채운다
      const put = await fetch(issued.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) {
        const detail = await put.text(); // S3는 XML로 원인을 준다
        console.log("S3 응답:", detail);
        const code = detail.match(/<Code>(.*?)<\/Code>/)?.[1] ?? "알 수 없음";
        throw new Error(`S3 업로드 실패 — ${put.status} ${code}`);
      }
      log(`[${type.label}] S3 업로드 성공`);

      // 3) 서버에 key 반영 — 서버가 HeadObject로 실제 존재를 확인한 뒤 저장한다
      const saved = await callApi(`/users/me/${type.path}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ [type.keyField]: key }),
      });
      log(`[${type.label}] 저장 완료 — ${saved[type.keyField]}`);
      await refresh(typeName);
    } catch (e) {
      log(`[${type.label}] 실패 — ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  // S3 객체는 남기고 DB의 key 연결만 끊는다 — 없는 상태에서 불러도 204다
  async function remove(typeName) {
    const type = IMAGE_TYPES[typeName];
    if (!auth) return;
    setBusy(true);
    try {
      await callApi(`/users/me/${type.path}`, {
        method: "DELETE",
        headers: authHeaders(false),
      });
      log(`[${type.label}] 삭제 완료 (204)`);
      await refresh(typeName);
    } catch (e) {
      log(`[${type.label}] 삭제 실패 — ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>프로필·배경 이미지 업로드 테스트</h2>

      <section style={{ marginBottom: 24 }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="이메일" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호"
        />
        <button onClick={login} disabled={busy}>
          로그인
        </button>
        {auth && <p>userId: {auth.userId}</p>}
      </section>

      {auth && <ProfilePreview urls={urls} onRefresh={() => refreshAll()} busy={busy} />}

      {Object.entries(IMAGE_TYPES).map(([typeName, type]) => (
        <ImageSection
          key={typeName}
          type={type}
          file={files[typeName]}
          onFileChange={(file) => setFiles((prev) => ({ ...prev, [typeName]: file }))}
          onUpload={() => uploadAndSave(typeName)}
          onDelete={() => remove(typeName)}
          disabled={busy || !auth}
        />
      ))}

      <pre style={{ background: "#f4f4f4", padding: 12, minHeight: 120, whiteSpace: "pre-wrap" }}>
        {logs.join("\n")}
      </pre>
    </div>
  );
}

// 서버가 돌려준 URL로 실제 프로필 화면처럼 그린다 — 배경은 배너, 프로필은 원형 아바타
function ProfilePreview({ urls, onRefresh, busy }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <div style={{ position: "relative", height: 200 }}>
        <div
          style={{
            height: 140,
            borderRadius: 8,
            background: urls.background ? `url(${urls.background}) center / cover` : "#c9d6e3",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#556",
          }}
        >
          {!urls.background && "기본 배경 (backgroundImageUrl = null)"}
        </div>
        <div
          style={{
            position: "absolute",
            left: 20,
            top: 90,
            width: 100,
            height: 100,
            borderRadius: "50%",
            border: "4px solid white",
            background: urls.profile ? `url(${urls.profile}) center / cover` : "#9aa",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontSize: 12,
          }}
        >
          {!urls.profile && "기본"}
        </div>
      </div>
      <button onClick={onRefresh} disabled={busy}>
        서버 값 다시 조회 (토큰 없이)
      </button>
    </section>
  );
}

function ImageSection({ type, file, onFileChange, onUpload, onDelete, disabled }) {
  return (
    <section style={{ marginBottom: 24, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
      <h3 style={{ marginTop: 0 }}>{type.label} 이미지</h3>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
      />
      {file && (
        <p>
          {file.name} — {file.type} — {file.size.toLocaleString()} bytes
          {file.size > MAX_SIZE_BYTES && " (10MB 초과)"}
        </p>
      )}
      <button onClick={onUpload} disabled={disabled || !file}>
        업로드하고 저장
      </button>{" "}
      <button onClick={onDelete} disabled={disabled}>
        삭제
      </button>
      {file && (
        <div style={{ marginTop: 8 }}>
          <img src={URL.createObjectURL(file)} alt={`${type.label} 미리보기`} width={160} />
        </div>
      )}
    </section>
  );
}
