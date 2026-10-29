# DATA_STORAGE.md

이 문서는 [Data Architecture](../model/DATA_ARCHITECTURE.md)가 정한 Main Server의 데이터를 저장하는 방안을 정합니다. 데이터의 구분과 쓰기, 읽기 규칙은 model 문서를 따르며, 이 문서는 바꾸지 않습니다. 이 문서의 내용은 Main Server의 Persistence 모듈이 구현합니다([Application Architecture](../model/APPLICATION_ARCHITECTURE.md#persistence) 참고). 용어는 [Glossary](../model/GLOSSARY.md)를 따릅니다.

## 저장소

Main Server의 데이터를 SQLite 데이터베이스 파일 하나에 저장합니다. 결정 배경은 [Store Main Server data in SQLite](../../adr/2026-10-28-store-main-server-data-in-sqlite.md)를 참고하세요.

| 설정 | 값 | 이유 |
|---|---|---|
| `journal_mode` | `WAL` | Batch를 쓰는 동안에도 Visualization의 질의가 읽을 수 있게 합니다. |
| `synchronous` | `FULL` | `accepted`를 보낸 Batch가 전원이 꺼져도 남게 합니다. |
| `foreign_keys` | `ON` | |
| `busy_timeout` | 설정 값 | 쓰기 잠금을 기다리는 최대 시간입니다. 넘으면 Batch를 `unavailable`로 거절합니다. |

### 설정

| 항목 | 설명 |
|---|---|
| 데이터 파일 | SQLite 데이터베이스 파일의 경로입니다. |
| 쓰기 잠금 대기 시간 | `busy_timeout`입니다. Daemon의 Ack 타임아웃보다 짧아야 합니다. |

## 스키마

테이블, 열, 제약 조건, 인덱스와 DDL은 [Table Definition](TABLE_DEFINITION.md)에서 정의합니다. [Data Architecture의 Entity](../model/DATA_ARCHITECTURE.md#entity-목록)마다 테이블을 하나 두고, 파생 데이터를 만든 구성 규칙의 버전을 담는 `derivation` 테이블을 더합니다.

## 쓰기

Batch 하나를 트랜잭션 하나로 처리합니다. [Data Architecture의 쓰기](../model/DATA_ARCHITECTURE.md#쓰기) 3번이 이 트랜잭션입니다.

1. `BEGIN IMMEDIATE`로 쓰기 잠금을 잡습니다. 쓰기 잠금 대기 시간 안에 잡지 못하면 `unavailable`로 거절합니다.
2. `session`, `agent`를 찾거나 추가하고, `ingest`를 추가합니다. `session`과 `agent`의 비어 있는 열은 `NULL`일 때만 채웁니다(예: `UPDATE session SET cwd = ? WHERE pk = ? AND cwd IS NULL`).
3. `event`를 추가합니다. 중복은 `INSERT ... ON CONFLICT (session_pk, event_id) DO NOTHING`으로 건너뜁니다.
4. Batch에 들어 있는 `turn_id`마다 `turn`, `llm_call`, `tool_call`, `compaction`의 행을 지우고, `event`에서 그 Turn의 행을 `position` 순으로 읽어 다시 만듭니다.
5. `ingest`의 `stored_count`를 채우고 `COMMIT`합니다.
6. `COMMIT`이 끝난 뒤에 `accepted`를 돌려줍니다.

어느 단계에서든 오류가 나면 `ROLLBACK`하고 `unavailable`로 거절합니다.

## 읽기

LLM Call의 input은 같은 `agent_pk`의 `event`를 범위로 읽습니다. 범위의 시작은 대상 LLM Call보다 앞에 있는 가장 가까운 `compaction` 행입니다. 먼저 그 행을 `compaction_by_turn` 인덱스로 찾고, 없으면 시작 조건을 뺍니다.

```sql
-- :turn_id, :position 은 대상 LLM Call의 값
-- :start_turn_id, :start_position 은 가장 가까운 compaction의 값
SELECT e.body
FROM event e JOIN turn t ON t.agent_pk = e.agent_pk AND t.turn_id = e.turn_id
WHERE e.agent_pk = :agent_pk
  AND (<t가 대상 Turn보다 앞> OR (e.turn_id = :turn_id AND e.position < :position))
  AND (<t가 시작 Turn보다 뒤> OR (e.turn_id = :start_turn_id AND e.position >= :start_position))
ORDER BY <Turn 순서>, e.position;
```

`<Turn 순서>`는 Agent 안 Turn의 순서 기준이 정해지면 그것을 따릅니다([Domain Model](../model/DOMAIN_MODEL.md#결정되지-않은-사항) 참고). `turn` 테이블은 후보가 되는 `started_at_us`와 `ingest_id`를 모두 가지므로, 기준이 정해져도 테이블을 바꾸지 않습니다.

Session 목록의 시작 시각은 그 Session의 `agent`에 속한 `turn.started_at_us`의 최솟값입니다.

## 스키마 버전

- 스키마 버전은 `PRAGMA user_version`에 둡니다. Main Server는 시작할 때 버전을 확인하고, 낮으면 순서대로 마이그레이션한 뒤 Batch를 받습니다.
- 원본 데이터의 테이블은 내용을 잃지 않게 마이그레이션합니다.
- 파생 데이터의 테이블은 마이그레이션하지 않고 지운 뒤 다시 만들어도 됩니다.
- `derivation.version`이 Main Server가 가진 구성 규칙의 버전과 다르면, Main Server는 파생 데이터를 모두 지우고 `event`로 다시 만듭니다. 다시 만드는 동안 받은 Batch는 `unavailable`로 거절합니다.

## Session 삭제

Session 하나를 트랜잭션 하나로 지웁니다. 그 Session의 `tool_call`, `llm_call`, `compaction`, `turn`, `event`, `ingest`, `agent`, `session` 행을 이 순서로 지웁니다.

## 결정되지 않은 사항

- SQLite에 접근하는 라이브러리. Kotlin의 컴파일 대상과 함께 정합니다([Implement the Main Server in Kotlin](../../adr/2026-10-24-implement-main-server-in-kotlin.md)의 범위 밖 참고).
- 데이터 파일의 기본 위치
- 쓰기 잠금 대기 시간의 기본값
- 큰 `event.body`를 압축하거나 따로 저장할지
- 백업 방법(예: `VACUUM INTO`)
