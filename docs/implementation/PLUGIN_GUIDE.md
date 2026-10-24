# PLUGIN_GUIDE.md

이 문서는 [Plugin Specification](../model/PLUGIN_SPEC.md)을 따르는 Plugin을 구현하는 방안을 정합니다. Plugin의 역할과 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 구현 언어는 [Tech Stack](TECH_STACK.md)을, 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## Plugin을 Daemon에 넣는 방식

Plugin 코드는 Daemon 실행 파일에 함께 빌드합니다. Daemon은 실행 중에 Plugin을 불러오지 않으며, Daemon 설정의 "사용할 Plugin"은 실행 파일에 들어 있는 Plugin 가운데 활성화할 것을 고릅니다. 새 에이전트를 지원하거나 Plugin을 고치면 Daemon을 다시 빌드하고 배포합니다. 결정 배경은 [Bundle Plugins into the Client Adapter Daemon executable](../../adr/2026-10-22-bundle-plugins-into-daemon-executable.md)을 참고하세요.

## 결정되지 않은 사항

- Plugin이 Session Log Event를 Daemon에 넘기는 TypeScript 인터페이스
- Plugin이 읽은 위치 같은 자신의 상태를 저장하는 위치
