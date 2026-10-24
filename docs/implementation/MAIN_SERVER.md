# MAIN_SERVER.md

이 문서는 Main Server([System Architecture](../model/SYSTEM_ARCHITECTURE.md), [Application Architecture](../model/APPLICATION_ARCHITECTURE.md))를 구현하는 방안을 정합니다. 모듈의 역할과 의존 관계는 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## Input Adapter

Input Adapter의 Transport는 표준입출력, Unix Socket, REST API, Streamable HTTP, WebSocket 등을 지원합니다. Transport별 전송 방식은 [Agent Logging Protocol 구현](AGENT_LOGGING_PROTOCOL.md#transport-바인딩)에서 정합니다.

## 결정되지 않은 사항

- Main Server의 구현 언어
