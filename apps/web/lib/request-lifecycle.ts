export type RequestPhase =
  | "recording"
  | "finalizing"
  | "transcribing"
  | "responding"
  | "playing"
  | "completed"
  | "cancelled";

export interface RequestLifecycle {
  phase: RequestPhase;
  startedAt: number;
  updatedAt: number;
}

export type RequestLifecycleRegistry = Map<string, RequestLifecycle>;

const terminalPhases = new Set<RequestPhase>(["completed", "cancelled"]);

export function beginRequest(
  registry: RequestLifecycleRegistry,
  requestId: string,
  phase: RequestPhase,
  now = Date.now()
): void {
  registry.set(requestId, { phase, startedAt: now, updatedAt: now });
  pruneSettledRequests(registry);
}

export function transitionRequest(
  registry: RequestLifecycleRegistry,
  requestId: string,
  phase: RequestPhase,
  now = Date.now()
): boolean {
  const current = registry.get(requestId);
  if (!current || terminalPhases.has(current.phase)) {
    return false;
  }

  registry.set(requestId, { ...current, phase, updatedAt: now });
  return true;
}

export function canAcceptRequestEvent(
  registry: RequestLifecycleRegistry,
  requestId: string,
  allowedPhases?: readonly RequestPhase[]
): boolean {
  const current = registry.get(requestId);
  if (!current || terminalPhases.has(current.phase)) {
    return false;
  }

  return !allowedPhases || allowedPhases.includes(current.phase);
}

export function settleRequest(
  registry: RequestLifecycleRegistry,
  requestId: string,
  phase: "completed" | "cancelled",
  now = Date.now()
): void {
  const current = registry.get(requestId);
  registry.set(requestId, {
    phase,
    startedAt: current?.startedAt ?? now,
    updatedAt: now
  });
  pruneSettledRequests(registry);
}

export function cancelActiveRequests(
  registry: RequestLifecycleRegistry,
  now = Date.now()
): string[] {
  const cancelled: string[] = [];

  for (const [requestId, lifecycle] of registry) {
    if (!terminalPhases.has(lifecycle.phase)) {
      registry.set(requestId, { ...lifecycle, phase: "cancelled", updatedAt: now });
      cancelled.push(requestId);
    }
  }

  pruneSettledRequests(registry);
  return cancelled;
}

function pruneSettledRequests(registry: RequestLifecycleRegistry): void {
  const maximumEntries = 200;
  if (registry.size <= maximumEntries) {
    return;
  }

  for (const [requestId, lifecycle] of registry) {
    if (terminalPhases.has(lifecycle.phase)) {
      registry.delete(requestId);
    }
    if (registry.size <= maximumEntries) {
      return;
    }
  }
}
