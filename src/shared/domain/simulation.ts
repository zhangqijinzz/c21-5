import { analyzeGraph } from "./graph";
import type {
  LatencyProject,
  NodeLedgerEntry,
  RequestNode,
  SimulationLedger,
  SimulationMode,
  SimulationResult,
  TimelineEntry,
} from "./types";

const JITTER_FACTORS: Record<SimulationMode, number> = {
  low: 0,
  expected: 0.5,
  high: 1,
};

interface AttemptBreakdown {
  serviceMs: number;
  expectedAttempts: number;
  terminalFailureRate: number;
  baseMs: number;
  jitterMs: number;
  timeoutCutMs: number;
  retryMs: number;
  backoffMs: number;
  totalMs: number;
}

function breakdownAttempts(
  node: RequestNode,
  mode: SimulationMode,
): AttemptBreakdown {
  const jitterFactor = JITTER_FACTORS[mode];
  const jitterMs = node.jitterMs * jitterFactor;
  const uncappedMs = node.durationMs + jitterMs;
  const serviceMs = Math.min(
    uncappedMs,
    node.timeoutMs || Number.POSITIVE_INFINITY,
  );
  const failure = node.failureRate / 100;
  let retryMs = 0;
  let backoffMs = 0;
  let expectedAttempts = 0;
  let priorFailures = 1;
  for (let attempt = 0; attempt <= node.retryCount; attempt += 1) {
    expectedAttempts += priorFailures;
    if (attempt > 0) retryMs += priorFailures * serviceMs;
    priorFailures *= failure;
    if (attempt < node.retryCount)
      backoffMs += priorFailures * Math.min(200 * 2 ** attempt, 2_000);
  }
  return {
    serviceMs,
    expectedAttempts,
    terminalFailureRate: priorFailures,
    baseMs: node.durationMs,
    jitterMs,
    timeoutCutMs: serviceMs - uncappedMs,
    retryMs,
    backoffMs,
    totalMs: serviceMs * expectedAttempts + backoffMs,
  };
}

function emptyLedger(mode: SimulationMode): SimulationLedger {
  return {
    mode,
    jitterFactor: JITTER_FACTORS[mode],
    entries: [],
    completionMs: 0,
    criticalPath: [],
    criticalDurationMs: 0,
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
      warnings: analysis.validation.errors,
      ledger: emptyLedger(mode),
    };
  }

  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const attempts = new Map(
    project.nodes.map((node) => [node.id, breakdownAttempts(node, mode)]),
  );
  const baseDurations = new Map(
    project.nodes.map((node) => [node.id, attempts.get(node.id)?.totalMs ?? 0]),
  );
  const durations = new Map(baseDurations);
  const fallbackWeights = new Map<string, number>();
  for (const node of project.nodes) {
    const fallback = node.fallbackNodeId
      ? byId.get(node.fallbackNodeId)
      : undefined;
    if (fallback) {
      const terminalFailure = attempts.get(node.id)?.terminalFailureRate ?? 0;
      const weighted = (baseDurations.get(fallback.id) ?? 0) * terminalFailure;
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
  const ledgerEntries: NodeLedgerEntry[] = [];
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
        dependencyEntries.reduce((end, entry) => Math.max(end, entry.endMs), 0),
    );
    entries.push({
      nodeId: id,
      startMs,
      endMs,
      modeledDurationMs,
      waitMs,
      ...(predecessor ? { criticalPredecessorId: predecessor } : {}),
    });
    const attempt = attempts.get(id);
    if (attempt) {
      ledgerEntries.push({
        nodeId: id,
        serviceMs: attempt.serviceMs,
        expectedAttempts: attempt.expectedAttempts,
        terminalFailureRate: attempt.terminalFailureRate,
        breakdown: {
          baseMs: attempt.baseMs,
          jitterMs: attempt.jitterMs,
          timeoutCutMs: attempt.timeoutCutMs,
          retryMs: attempt.retryMs,
          backoffMs: attempt.backoffMs,
          fallbackMs: fallbackWeights.get(id) ?? 0,
          queueMs: waitMs,
        },
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
  const criticalPath = lastEntry ? (pathById.get(lastEntry.nodeId) ?? []) : [];
  const ledgerById = new Map(
    ledgerEntries.map((entry) => [entry.nodeId, entry]),
  );
  const criticalDurationMs = criticalPath.reduce((sum, id) => {
    const breakdown = ledgerById.get(id)?.breakdown;
    if (!breakdown) return sum;
    return (
      sum +
      breakdown.baseMs +
      breakdown.jitterMs +
      breakdown.timeoutCutMs +
      breakdown.retryMs +
      breakdown.backoffMs +
      breakdown.fallbackMs
    );
  }, 0);
  const warnings = [...analysis.validation.warnings];
  if (
    project.nodes.some(
      (node) =>
        node.timeoutMs > 0 &&
        node.durationMs + node.jitterMs * JITTER_FACTORS[mode] > node.timeoutMs,
    )
  ) {
    warnings.push("部分节点会触发超时截断，已计入重试与退避预算");
  }
  const completionMs = lastEntry?.endMs ?? 0;
  return {
    mode,
    completionMs,
    criticalPath,
    entries,
    warnings,
    ledger: {
      mode,
      jitterFactor: JITTER_FACTORS[mode],
      entries: ledgerEntries,
      completionMs,
      criticalPath,
      criticalDurationMs,
    },
  };
}
