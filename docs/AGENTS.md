# AGENTS.md

`docs/`의 설계 문서는 다루는 내용에 따라 두 디렉터리로 나뉩니다.

| 디렉터리 | 다루는 내용 |
|---|---|
| [`001.model/`](001.model/) | 이 프로젝트가 해결하려는 문제의 정의, 추상화된 해결 방안, 프로젝트를 이루는 Model의 정의 |
| [`002.implementation/`](002.implementation/) | 프로그래밍 언어, 기술 스택, 프로젝트 구조 등 `model`을 구체적으로 구현하는 방안 |

## `model`

`model`의 문서는 구현에 의존하지 않습니다(implementation-agnostic). 프로그래밍 언어, 런타임, 라이브러리, 직렬화 형식, 통신 기술, 배포 방식처럼 구현을 바꾸면 함께 바뀌는 내용은 적지 않습니다. 구현을 바꿔도 `model`의 문서는 그대로 유지되어야 합니다.

`model`의 문서는 `implementation`의 문서를 참조하지 않습니다.

## `implementation`

`implementation`의 문서는 `model`이 정의한 것을 어떤 언어, 기술 스택, 프로젝트 구조로 구현하는지 정합니다. `model`의 정의와 규칙을 바꾸지 않으며, 구현하는 `model`의 문서를 참조합니다.
