---
status: accepted
date: 2026-10-30
decision-makers: pgd
---

# Choose the implementation tooling and Visualization stack

## Context and Problem Statement

구현 언어, 런타임, HTTP 프레임워크, 실행 구성은 [Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md)에서, 저장소는 [Store Main Server data in SQLite](2026-10-28-store-main-server-data-in-sqlite.md)에서 정했습니다. 코드를 쓰기 시작하려면 코드 저장소 구성, 입력 검증, DB 접근 방식, Visualization 스택, 품질 도구, 파일 감시가 더 필요하고, 첫 배포까지는 지원 플랫폼, 상주 방식, 배포 방법, 설정 형식이 필요합니다.

아직 코드가 없으므로 Bun 1.4.4의 시제품으로 후보를 측정했습니다. 결과는 [More Information](#more-information)에 있습니다. 측정 과정에서 문서에 없던 위험도 드러났습니다. 컴파일한 실행 파일이 실행한 디렉터리의 `.env`를 읽고, 사용자 계정마다 Daemon이 상주하므로 고정 포트가 충돌하며, 같은 머신의 다른 계정이 localhost로 프롬프트 원문을 읽을 수 있고, 큰 input을 한 번에 읽으면 메모리가 크게 오릅니다.

## Decision Drivers

- **메모리 사용량을 최소화합니다.** 다른 기준보다 우선합니다.
- 실행 파일 하나와 Plugin 디렉터리로 이루어진 구성에 맞아야 합니다.
- Daemon과 Main Server가 이벤트 루프를 함께 쓰므로, 무거운 작업이 수집을 막지 않아야 합니다.
- Main Server는 프롬프트와 Tool Call 결과의 원문을 다룹니다. 이를 다른 계정에 노출하지 않아야 합니다.
- Bun이 내장한 기능이 있으면 의존성을 더하지 않습니다.

## Decision

**코드 저장소와 빌드**

- 단일 저장소에 Bun workspaces로 패키지를 나눕니다. Plugin 패키지도 같은 저장소에 둡니다.
- Plugin은 `bun build --target=bun --format=esm`으로 번들합니다.
- 실행 파일은 `bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig`로 만듭니다.

**라이브러리**

- Input Adapter의 Decoder와 Plugin의 레코드 검증에 Valibot을 씁니다. 모르는 필드를 보존해야 하는 객체에는 `looseObject`를 씁니다.
- DB 접근은 ORM이나 쿼리 빌더 없이 `bun:sqlite`와 직접 쓴 SQL로 합니다.
- 파일 감시는 `node:fs`의 `watch`와 주기적 재검사로 합니다.
- 설정 파일 형식은 TOML이며 `Bun.TOML.parse`로 읽습니다.

**Visualization**

- Preact 기반 SPA로 만들고, Bun으로 번들해 실행 파일에 내장합니다. 서버 렌더링은 하지 않습니다.
- 스타일은 일반 CSS로 쓰고, 토큰 차트는 SVG로 직접 그립니다.
- Visualization은 `127.0.0.1`에만 바인딩하고, 포트를 설정할 수 있게 하며, 권한 `0600` 파일의 접근 토큰을 요구합니다. 자세한 내용은 [Visualization](../docs/002.implementation/010.VISUALIZATION.md)을 따릅니다.
- LLM Call 목록은 메타데이터만 돌려줍니다. 본문은 펼칠 때 `.iterate()`와 스트리밍 응답으로 보냅니다.

**품질 도구**

- 테스트는 `bun test`, 린트와 포맷은 Biome, 타입 검사는 `tsc --noEmit`, CI는 GitHub Actions를 씁니다.

**실행과 배포**

- 지원 플랫폼은 Linux x64, Linux arm64, macOS arm64입니다. Windows는 지원하지 않습니다.
- 실행 파일에 서비스 등록 명령을 넣어 systemd user service와 launchd 파일을 만듭니다. systemd에는 `MemoryMax`를 겁니다.
- GitHub Releases에 플랫폼별 실행 파일, Plugin `.js`, SHA-256 체크섬을 올립니다.
- SQLite의 `mmap_size`는 `0`을 유지합니다.

**범위 밖**

- 원격 Transport의 인증과 암호화. 팀 단계에서 정합니다. 그때는 Daemon별 Bearer 토큰과 Caddy 같은 프록시의 TLS를 먼저 검토합니다.
- `event.body` 압축. 되풀이되는 input의 중복 제거와 함께 정합니다.
- 질의를 Worker로 분리하는 것. 질의가 수집을 막는 것이 측정될 때 정합니다.
- Plugin 서명 검증. 오픈소스 단계에서 정합니다.
- 패키지 이름과 디렉터리 구성, Visualization이 보여 줄 화면

## Consequences

- Good, because 측정한 구성의 대기 RSS가 약 20 MB, 요청을 처리한 뒤에도 약 28 MB입니다.
- Good, because 파일 감시, TOML 해석, 번들, 테스트에 Bun 내장 기능을 쓰므로 런타임 의존성이 Hono, Valibot, Preact 셋입니다.
- Good, because 화면 렌더링이 브라우저에서 일어나므로 큰 문자열을 만드는 일이 수집과 같은 이벤트 루프를 막지 않습니다.
- Bad, because 실행 파일이 약 105 MB입니다. 플랫폼마다 내려받아야 하며, 메모리가 아닌 디스크와 내려받기 비용입니다.
- Bad, because SQL을 직접 쓰므로 스키마를 바꿀 때 컴파일러가 질의의 오류를 잡지 못합니다. Persistence 테스트로 막습니다.
- Bad, because Biome의 타입 인지 규칙은 typescript-eslint보다 적습니다. 그만큼 일부 오류를 잡지 못합니다.
- Bad, because Preact는 React의 일부 생태계와 호환되지 않을 수 있습니다. 라이브러리를 더할 때 확인합니다.
- Bad, because `fs.watch`의 동작은 플랫폼마다 다릅니다. 주기적 재검사로 놓친 이벤트를 보완합니다.
- Neutral, because Visualization에 접근 토큰이 생기므로 사용자는 실행 파일의 명령으로 접속 URL을 얻어야 합니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/002.implementation/001.TECH_STACK.md`](../docs/002.implementation/001.TECH_STACK.md): 이 결정의 전체 목록
  - [`docs/002.implementation/004.PLUGIN_GUIDE.md`](../docs/002.implementation/004.PLUGIN_GUIDE.md): 저장소 구성, Plugin 번들, 파일 감시, 배포
  - [`docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md`](../docs/002.implementation/007.CLIENT_ADAPTER_DAEMON.md): 실행 파일 빌드, 설정 파일, 상주 방식, 배포
  - [`docs/002.implementation/008.DATA_STORAGE.md`](../docs/002.implementation/008.DATA_STORAGE.md): `mmap_size`, 큰 본문 읽기
  - [`docs/002.implementation/010.VISUALIZATION.md`](../docs/002.implementation/010.VISUALIZATION.md): SPA 구성, 접속, 큰 데이터 조회
- **Dependencies**: Bun 1.4.4 이상, `hono`, `valibot` 1.5 이상, `preact` 11.1 이상. 개발 의존성은 Biome 2, `typescript`입니다.
- **Patterns to follow**:
  - 패키지 의존 관계로 모듈 경계를 강제합니다. Daemon과 Plugin 패키지는 Main Server 패키지에 의존하지 않습니다.
  - CI와 개발 환경의 Bun 버전을 고정합니다.
  - `event.body`를 읽는 질의는 `.iterate()`로 한 행씩 처리합니다.
- **Patterns to avoid**:
  - ORM, 쿼리 빌더, chokidar, Vite, Tailwind, 차트 라이브러리, 코드 에디터 컴포넌트를 이 ADR을 고치지 않고 더하지 않습니다.
  - `event.body`를 `.all()`로 읽거나, 여러 본문을 한 번에 `JSON.stringify`하지 않습니다.
  - Visualization을 `0.0.0.0`에 바인딩하지 않습니다.
  - `mmap_size`를 켜지 않습니다.

### Verification

- [ ] `bun install`이 저장소 루트에서 모든 workspace를 설치하고, Daemon과 Plugin 패키지의 의존 목록에 Main Server 패키지가 없습니다.
- [ ] CI가 `bun test`, Biome 검사, `tsc --noEmit`을 실행하고, 하나라도 실패하면 실패합니다.
- [x] `.env`를 둔 디렉터리에서 실행 파일을 실행해도 그 값이 `process.env`에 없습니다.
- [ ] 의존 목록에 ORM, 쿼리 빌더, chokidar가 없습니다.
- [ ] 같은 머신의 두 계정이 Daemon을 동시에 실행해도 포트가 충돌하지 않습니다.
- [x] 접속 정보 파일의 권한이 `0600`이고, 토큰 없는 요청과 `Host`가 맞지 않는 요청을 거절합니다.
- [ ] LLM Call 목록 응답에 `event.body`가 없고, `event.body`를 읽는 코드에 `.all()`이 없습니다.
- [ ] macOS arm64에서 재귀 파일 감시와 외부 Plugin 불러오기가 동작합니다.
- [x] 전체 구현에서 대기 상태의 RSS를 측정해 이 ADR에 기록합니다.

## Alternatives Considered

- **Zod, Zod Mini**: 생태계가 가장 넓지만 측정한 대기 RSS가 Zod는 약 7 MB, Zod Mini는 약 2 MB 더 큽니다. Plugin마다 따로 번들되므로 그 차이가 Plugin 수만큼 늘어날 수 있어 기각했습니다.
- **손으로 쓴 Decoder**: 의존성이 없지만 Session Log Event 종류마다 검증 코드와 타입을 함께 관리해야 해서 기각했습니다.
- **Drizzle, Kysely**: 스키마 변경을 타입으로 잡아 주지만, DDL과 트랜잭션, 질의가 이미 SQL로 문서화되어 있고 의존성이 늡니다.
- **Hono JSX 서버 렌더링**: 번들할 클라이언트가 거의 없지만 큰 input의 HTML을 서버에서 만듭니다. 수집과 이벤트 루프를 함께 쓰므로 기각했습니다.
- **Solid, Svelte**: 2차 자료에서는 Preact보다 작다고 하지만 직접 측정하지 않았습니다. 차이는 수 KB이고 서버 메모리와 무관해, React 호환 생태계를 택했습니다.
- **ESLint + typescript-eslint**: 타입 인지 규칙이 가장 많지만 도구와 설정이 늡니다.
- **Oxlint**: 타입 인지 규칙이 Biome보다 많지만, 포맷 도구를 따로 골라야 합니다.
- **고정 포트**: URL을 외우기 쉽지만 계정마다 Daemon이 상주하므로 충돌합니다.
- **Windows 지원**: 파일 감시, 서비스 등록, 권한 `0600`을 따로 구현해야 해서 첫 배포에서 뺐습니다.

## More Information

측정 환경은 Linux, Bun 1.4.4입니다. 각 구성을 한 번씩만 쟀으므로 1 MB 안팎의 차이는 오차로 봅니다.

| 구성 | 대기 RSS | 300회 요청 후 |
|---|---|---|
| 빈 프로세스 | 13.5 MB | 13.5 MB |
| Hono + `Bun.serve` | 17.4 MB | 24.5 MB |
| + SQLite(WAL) | 19.9 MB | 27.0 MB |
| + Valibot | 20.0 MB | 28.1 MB |
| + Zod Mini | 22.0 MB | 29.3 MB |
| + Zod | 26.8 MB | 31.4 MB |
| + SPA 내장 (SQLite 구성 기준) | 21.3 MB | 28.1 MB |
| + Worker 1개 (SQLite 구성 기준) | 24.7 MB | 31.3 MB |

- `--smol`과 `--bytecode`는 이 규모에서 메모리를 눈에 띄게 줄이지 않았습니다.
- Preact hello-world 번들은 13.4 KB(gzip 5.7 KB)입니다. `Bun.serve`의 `routes`로 내장 HTML을, `fetch`로 Hono를 함께 띄울 수 있었습니다.
- `--compile`의 기본 옵션으로 실행 파일 밖 Plugin을 동적 `import()`로 불러왔습니다. Plugin 안의 `node:fs`, `bun:sqlite` 사용도 동작했습니다.
- 20 KB 본문 2,000건을 읽을 때 RSS는 `.iterate()`가 40 MB, `.all()`이 61 MB, `JSON.stringify`까지 하면 138 MB였습니다.
- 489 MB 데이터베이스를 읽을 때 `mmap_size`가 기본값 `0`이면 RSS가 40 MB, 256 MB로 켜면 296 MB였습니다(파일 캐시 페이지 포함).
- 로컬 Session Log 13 MB의 zstd 압축률은 레코드별 2.67배, 파일 전체 4.99배였습니다.
- macOS, 교차 컴파일, 실제 Plugin 부하, 장시간 실행은 측정하지 않았습니다.
- 전체 구현(OpenCode Plugin 포함, Linux x64, 수집한 Session 2개)의 RSS는 대기 상태에서 약 33 MB, Visualization으로 조회한 뒤 약 38 MB였습니다.

- 관련 ADR: [Run the Client Adapter Daemon and the Main Server in one Bun process](2026-10-29-run-daemon-and-main-server-in-one-bun-process.md), [Load built Plugins into the Daemon at runtime](2026-10-29-load-built-plugins-into-daemon-at-runtime.md), [Store Main Server data in SQLite](2026-10-28-store-main-server-data-in-sqlite.md)
- 다시 검토할 조건: Preact로 필요한 라이브러리를 쓸 수 없을 때, 질의가 수집을 막는 것이 측정될 때, Windows 사용자가 필요할 때
- 용어: [Glossary](../docs/001.model/002.GLOSSARY.md)
