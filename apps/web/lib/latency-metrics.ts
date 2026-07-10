export type LatencyRequestKind = "text" | "ptt" | "live";
export type LatencyRequestStatus =
  | "active"
  | "completed"
  | "interrupted"
  | "error";

export interface LatencyMarks {
  requestId: string;
  kind: LatencyRequestKind;
  status: LatencyRequestStatus;
  requestStartedAt: number;
  speechStartedAt?: number;
  speechEndedAt?: number;
  firstPartialAt?: number;
  finalTranscriptAt?: number;
  firstLlmDeltaAt?: number;
  firstAudioPlaybackAt?: number;
}

export interface LatencySnapshot extends LatencyMarks {
  sttFirstPartialMs?: number;
  sttFinalMs?: number;
  llmFirstDeltaMs?: number;
  ttsFirstAudioMs?: number;
  speechEndToFirstAudioMs?: number;
}

export type LatencyRegistry = Map<string, LatencyMarks>;
export type LatencyMark = Exclude<
  keyof LatencyMarks,
  "requestId" | "kind" | "status"
>;

export function beginLatencyRequest(
  registry: LatencyRegistry,
  requestId: string,
  kind: LatencyRequestKind,
  now: number
): LatencySnapshot {
  const marks: LatencyMarks = {
    requestId,
    kind,
    status: "active",
    requestStartedAt: now
  };
  registry.set(requestId, marks);
  pruneLatencyRegistry(registry);
  return toLatencySnapshot(marks);
}

export function markLatency(
  registry: LatencyRegistry,
  requestId: string,
  mark: LatencyMark,
  now: number
): LatencySnapshot | undefined {
  const current = registry.get(requestId);
  if (!current) return undefined;

  // Every milestone is first-observation latency. Late duplicate events must
  // not make an already displayed result look slower.
  if (current[mark] === undefined) {
    current[mark] = now;
  }
  return toLatencySnapshot(current);
}

export function settleLatencyRequest(
  registry: LatencyRegistry,
  requestId: string,
  status: Exclude<LatencyRequestStatus, "active">
): LatencySnapshot | undefined {
  const current = registry.get(requestId);
  if (!current) return undefined;
  current.status = status;
  return toLatencySnapshot(current);
}

export function toLatencySnapshot(marks: LatencyMarks): LatencySnapshot {
  const llmBaseline = marks.finalTranscriptAt ?? marks.requestStartedAt;
  return {
    ...marks,
    ...duration("sttFirstPartialMs", marks.speechStartedAt, marks.firstPartialAt),
    ...duration("sttFinalMs", marks.speechEndedAt, marks.finalTranscriptAt),
    ...duration("llmFirstDeltaMs", llmBaseline, marks.firstLlmDeltaAt),
    ...duration("ttsFirstAudioMs", marks.firstLlmDeltaAt, marks.firstAudioPlaybackAt),
    ...duration(
      "speechEndToFirstAudioMs",
      marks.speechEndedAt,
      marks.firstAudioPlaybackAt
    )
  };
}

function duration<Key extends string>(
  key: Key,
  start: number | undefined,
  end: number | undefined
): Partial<Record<Key, number>> {
  if (start === undefined || end === undefined || end < start) return {};
  return { [key]: Math.round(end - start) } as Record<Key, number>;
}

function pruneLatencyRegistry(registry: LatencyRegistry): void {
  while (registry.size > 100) {
    const oldest = registry.keys().next().value as string | undefined;
    if (!oldest) return;
    registry.delete(oldest);
  }
}
