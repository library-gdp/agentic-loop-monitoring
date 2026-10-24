---
status: accepted
date: 2026-10-22
decision-makers: pgd
---

# Implement the Client Adapter Daemon and Plugins in TypeScript

## Context and Problem Statement

[Split the system into a Client Adapter Daemon and a Main Server](2026-10-19-split-system-into-client-adapter-daemon-and-main-server.md)와 [Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md)는 구현 언어를 범위 밖으로 남겼습니다. Daemon과 Plugin은 한 실행 파일로 함께 빌드하므로 같은 언어를 써야 하며, 구현을 시작하려면 이 언어를 정해야 합니다.

## Decision

Client Adapter Daemon과 Plugin을 TypeScript로 구현합니다.

- [Plugin Specification](../docs/model/PLUGIN_SPEC.md)의 Plugin과 Daemon 사이 인터페이스를 TypeScript 타입으로 정의하고, 모든 Plugin이 이 타입을 구현합니다.
- Plugin은 에이전트마다 별도의 모듈로 두고, Daemon은 이 모듈들을 정적 `import`로 모은 등록 목록 하나에서 에이전트 id로 Plugin을 찾습니다.

**범위 밖**

- Main Server의 구현 언어
- TypeScript를 실행할 런타임, 그리고 Daemon을 실행 파일 하나로 빌드하는 방법
- 코드 디렉터리 구성

## Consequences

- Good, because Plugin 인터페이스와 Session Log Event를 타입으로 정의하므로, Plugin이 인터페이스를 어기거나 Session Log Event 필드를 잘못 채우면 빌드할 때 드러납니다.
- Good, because Session Log File이 대부분 JSON이므로 별도 라이브러리 없이 다루기 쉽습니다.
- Good, because 정적 `import`만으로 Plugin을 Daemon에 함께 빌드할 수 있어 [Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md)을 그대로 따를 수 있습니다.
- Bad, because TypeScript는 런타임이 있어야 실행됩니다. 배포물을 실행 파일 하나로 유지하려면 런타임을 함께 묶는 빌드 방법을 따로 정해야 합니다.
- Bad, because 컴파일 언어로 만든 실행 파일보다 메모리 사용량과 시작 시간이 큽니다. Daemon은 상주 프로세스이므로 시작 시간은 문제가 되지 않지만, 에이전트 머신에 늘 떠 있는 메모리는 늘어납니다.

## Implementation Plan

- **Affected paths**: 아직 코드가 없습니다. 설계 문서는 다음과 같습니다.
  - [`docs/implementation/TECH_STACK.md`](../docs/implementation/TECH_STACK.md): Daemon과 Plugin의 구현 언어
  - [`docs/implementation/CLIENT_ADAPTER_DAEMON.md`](../docs/implementation/CLIENT_ADAPTER_DAEMON.md): 런타임과 빌드 방법에 관한 결정되지 않은 사항
  - [`docs/implementation/PLUGIN_GUIDE.md`](../docs/implementation/PLUGIN_GUIDE.md): Plugin 인터페이스에 관한 결정되지 않은 사항
- **Dependencies**: TypeScript 컴파일러. 런타임은 후속 결정으로 정합니다.
- **Patterns to follow**:
  - Plugin 인터페이스 타입은 한 곳에 두고, Daemon과 모든 Plugin이 그 타입만 참조합니다.
- **Patterns to avoid**:
  - 동적 `import()`나 경로를 문자열로 조립한 `require`로 Plugin을 불러오지 않습니다.
  - Plugin 인터페이스 타입에 `any`를 쓰지 않습니다.

### Verification

- [ ] 모든 Plugin 모듈이 공통 Plugin 인터페이스 타입을 구현하며, 타입 검사를 통과합니다.
- [ ] Daemon 소스에 Plugin을 불러오는 동적 `import()`나 `require`가 없습니다.

## Alternatives Considered

다른 언어는 따로 비교하지 않았습니다. 결정한 사람이 TypeScript를 지정했습니다.

## More Information

- 관련 ADR: [Bundle Plugins into the Client Adapter Daemon executable](2026-10-22-bundle-plugins-into-daemon-executable.md)
- 다시 검토할 조건: 상주하는 Daemon의 메모리 사용량이 에이전트 머신에서 문제가 되는 경우
- 2026-10-24: 범위 밖으로 남긴 Main Server의 구현 언어는 [Implement the Main Server in Kotlin](2026-10-24-implement-main-server-in-kotlin.md)에서 정했습니다.
