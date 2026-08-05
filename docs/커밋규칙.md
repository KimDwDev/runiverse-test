# Git Commit Convention

## 커밋 메시지 형식

```text
<type>: <간단한 설명>

(선택)
본문
```

## Commit Type

| Type | 설명 |
|------|------|
| 📍 Feat | 새로운 기능을 추가합니다. |
| 🔨 Fix | 버그를 수정하거나 기존 기능(UI/UX 포함)의 문제를 해결합니다. |
| 📝 Docs | 문서를 추가하거나 수정합니다. |
| 🎨 Style | 코드 포맷, 들여쓰기, 공백 등 스타일을 수정합니다. (기능 변경 없음) |
| 🤖 Refactor | 기능 변경 없이 코드 구조를 개선합니다. |
| ✅ Test | 테스트 코드를 추가하거나 수정합니다. |
| 🚚 Chore | 빌드, 설정, 라이브러리, 개발 환경 등을 변경합니다. |
| ✂️ Remove | 파일 또는 사용하지 않는 코드를 삭제합니다. |
| 🔧 Rename | 파일 또는 폴더의 이름을 변경하거나 이동합니다. |

## 예시

```text
📍 Feat: 카카오 로그인 기능 추가

🔨 Fix: JWT 만료 처리 오류 수정

🤖 Refactor: MatchingService 책임 분리

📝 Docs: WebSocket API 명세서 수정

🚚 Chore: Spring Boot 4.1.0으로 업데이트
```

## 규칙

- 커밋 제목은 **`<type>: <간단한 설명>`** 형식을 사용합니다.
- 설명은 **간결하고 명확하게** 작성합니다.
- 하나의 커밋에는 **하나의 논리적인 변경 사항만** 포함합니다.
- 추가 설명이 필요한 경우에만 **본문(Body)** 을 작성합니다.

## 브랜치 규칙

- 브랜치는 **`<type>/<domain>`** 형식을 사용합니다.
- 브랜치 이름은 **소문자**를 사용합니다.
- 단어를 여러 개 사용할 경우 **kebab-case(`-`)** 를 사용합니다.

예시

```text
feat/oauth-login
feat/profile-image

fix/token-refresh

refactor/running-session

docs/websocket-api
```