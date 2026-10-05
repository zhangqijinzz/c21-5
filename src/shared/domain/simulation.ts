import { analyzeGraph } from "./graph";
import type {
  LatencyProject,
  NodeLedgerEntry,
  RequestNode,
  SimulationMode,
  SimulationResult,
  TimelineEntry,
} from "./types";

interface AttemptBreakdown {
  serviceMs: number;
  baseMs: number;
  jitterMs: number;
  timeoutTruncationMs: number;
  expectedAttempts: number;
  retryMs: number;
  backoffMs: number;
  totalMs: number;
}

function breakdownAttempts(
  node: RequestNode,
  mode: SimulationMode,
): AttemptBreakdown {
  const jitterFactor = mode === "low" ? 0 : mode === "high" ? 1 : 0.5;
  const jitterMs = node.jitterMs * jitterFactor;
  const rawMs = node.durationMs + jitterMs;
  const serviceMs = Math.min(
    rawMs,
    node.timeoutMs || Number.POSITIVE_INFINITY,
  );
  const failure = node.failureRate / 100;
  let totalMs = 0;
  let attemptMs = 0;
  let backoffMs = 0;
  let expectedAttempts = 0;
  let priorFailures = 1;
  for (let attempt = 0; attempt <= node.retryCount; attempt += 1) {
    const attemptCost = priorFailures * serviceMs;
    totalMs += attemptCost;
    attemptMs += attemptCost;
    expectedAttempts += priorFailures;
    priorFailures *= failure;
    if (attempt < node.retryCount) {
      const backoffCost = priorFailures * Math.min(200 * 2 ** attempt, 2_000);
      totalMs += backoffCost;
      backoffMs += backoffCost;
    }
  }
  return {
    serviceMs,
    baseMs: node.durationMs,
    jitterMs,
    timeoutTruncationMs: serviceMs - rawMs,
    expectedAttempts,
    retryMs: attemptMs - serviceMs,
    backoffMs,
    totalMs,
  };
}

export function simulateProject(
  project: LatencyProject,
  mode: SimulationMode = "expected",
): SimulationResult {
  const analysis = analyzeGraph(project);
  if (analysis.validation.errors.length) {
    return {
      mode,
      completionMs: 0,
      criticalPath: [],
      entries: [],
      ledger: [],
      warnings: analysis.validation.errors,
    };
  }

  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const breakdowns = new Map(
    project.nodes.map((node) => [node.id, breakdownAttempts(node, mode)]),
  );
  const durations = new Map(
    project.nodes.map((node) => [
      node.id,
      breakdowns.get(node.id)?.totalMs ?? 0,
    ]),
  );
  const fallbackWeights = new Map<string, number>();
  for (const node of project.nodes) {
    const fallback = node.fallbackNodeId
      ? byId.get(node.fallbackNodeId)
      : undefined;
    if (fallback) {
      const terminalFailure = (node.failureRate / 100) ** (node.retryCount + 1);
      const weighted =
        (breakdowns.get(fallback.id)?.totalMs ?? 0) * terminalFailure;
      fallbackWeights.set(node.id, weighted);
      durations.set(node.id, (durations.get(node.id) ?? 0) + weighted);
    }
  }

  const concurrency =
    project.concurrencyLimit ?? Math.max(1, project.nodes.length);
  const slots = Array.from(
    { length: Math.max(1, Math.min(concurrency, project.nodes.length || 1)) },
    (_, index) => ({
      index,
      endMs: 0,
      nodeId: undefined as string | undefined,
    }),
  );
  const entries: TimelineEntry[] = [];
  const ledger: NodeLedgerEntry[] = [];
  for (const id of analysis.order) {
    const node = byId.get(id);
    if (!node) continue;
    const slot = slots.reduce(
      (best, candidate) => (candidate.endMs < best.endMs ? candidate : best),
      slots[0]!,
    );
    const dependencyEntries = node.dependencyIds
      .map((dependencyId) =>
        entries.find((entry) => entry.nodeId === dependencyId),
      )
      .filter((entry): entry is TimelineEntry => Boolean(entry));
    const latestDependency = dependencyEntries.reduce<
      TimelineEntry | undefined
    >(
      (latest, entry) =>
        !latest || entry.endMs > latest.endMs ? entry : latest,
      undefined,
    );
    const startMs = Math.max(slot.endMs, latestDependency?.endMs ?? 0);
    const resourceBlocked = slot.endMs > (latestDependency?.endMs ?? 0);
    const predecessor = resourceBlocked
      ? slot.nodeId
      : latestDependency?.nodeId;
    const modeledDurationMs = durations.get(id) ?? 0;
    const endMs = startMs + modeledDurationMs;
    const waitMs = Math.max(
      0,
      startMs -
        dependencyEntries.reduce(
          (end, entry) => Math.max(end, entry.endMs),
          0,
        ),
    );
    entries.push({
      nodeId: id,
      startMs,
      endMs,
      modeledDurationMs,
      waitMs,
      ...(predecessor ? { criticalPredecessorId: predecessor } : {}),
    });
    const breakdown = breakdowns.get(id);
    if (breakdown) {
      ledger.push({
        nodeId: id,
        baseMs: breakdown.baseMs,
        jitterMs: breakdown.jitterMs,
        timeoutTruncationMs: breakdown.timeoutTruncationMs,
        expectedAttempts: breakdown.expectedAttempts,
        retryMs: breakdown.retryMs,
        backoffMs: breakdown.backoffMs,
        fallbackMs: fallbackWeights.get(id) ?? 0,
        queueMs: waitMs,
        totalMs: modeledDurationMs + waitMs,
      });
    }
    slot.endMs = endMs;
    slot.nodeId = id;
  }

  const lastEntry = entries.reduce<TimelineEntry | undefined>(
    (latest, entry) => (!latest || entry.endMs > latest.endMs ? entry : latest),
    undefined,
  );
  const pathById = new Map<string, string[]>();
  for (const entry of entries)
    pathById.set(entry.nodeId, [
      ...(entry.criticalPredecessorId
        ? (pathById.get(entry.criticalPredecessorId) ?? [])
        : []),
      entry.nodeId,
    ]);
  const warnings = [...analysis.validation.warnings];
  if (
    project.nodes.some(
      (node) =>
        node.timeoutMs > 0 &&
        node.durationMs +
          node.jitterMs *
            (mode === "high" ? 1 : mode === "expected" ? 0.5 : 0) >
          node.timeoutMs,
    )
  ) {
    warnings.push("部分节点会触发超时截断，已计入重试与退避预算");
  }
  return {
    mode,
    completionMs: lastEntry?.endMs ?? 0,
    criticalPath: lastEntry ? (pathById.get(lastEntry.nodeId) ?? []) : [],
    entries,
    ledger,
    warnings,
  };
}
