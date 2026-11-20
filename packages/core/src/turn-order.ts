/** Agent 안에서 Turn의 순서를 정하는 데 쓰는 값입니다. */
export interface TurnOrderKey {
    readonly turnId: string;
    /** Turn을 시작한 user_message의 timestamp입니다. */
    readonly startedAtUs: number;
    /** Turn을 시작한 user_message를 처음 저장한 수신 기록의 id입니다. */
    readonly ingestId: number;
}

/**
 * Agent 안 Turn의 순서입니다. started_at이 이른 Turn이 앞이며, 같으면 Turn을 시작한 user_message를
 * 먼저 받은 Turn이 앞입니다(docs/001.model/003.domain_model/006.TURN.md).
 * 이 규칙은 여기에만 둡니다. 저장소는 이 순서로 정렬하지 않습니다.
 */
export function compareTurns(a: TurnOrderKey, b: TurnOrderKey): number {
    if (a.startedAtUs !== b.startedAtUs) return a.startedAtUs < b.startedAtUs ? -1 : 1;
    if (a.ingestId !== b.ingestId) return a.ingestId < b.ingestId ? -1 : 1;
    if (a.turnId === b.turnId) return 0;
    return a.turnId < b.turnId ? -1 : 1;
}
