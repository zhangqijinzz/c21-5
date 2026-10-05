import type {
  LatencyProject,
  LedgerBreakdown,
  RequestNode,
  ScenarioSnapshot,
  SimulationLedger,
  SimulationResult,
} from "../../shared/domain/types";

export interface LedgerDelta {
  key: keyof LedgerBreakdown;
  label: string;
  baselineMs: number;
  comparisonMs: number;
  deltaMs: number;
}

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
  ledgerDelta?: LedgerDelta[];
}

export const LEDGER_CATEGORY_LABELS: Record<keyof LedgerBreakdown, string> = {
  baseMs: "基础耗时",
  jitterMs: "波动影响",
  timeoutCutMs: "超时截断",
  retryMs: "期望重试",
  backoffMs: "退避等待",
  fallbackMs: "降级加权",
  queueMs: "资源排队",
};

const LEDGER_CATEGORY_KEYS = Object.keys(
  LEDGER_CATEGORY_LABELS,
) as (keyof LedgerBreakdown)[];

function sumBreakdown(ledger: SimulationLedger): LedgerBreakdown {
  const totals: LedgerBreakdown = {
    baseMs: 0,
    jitterMs: 0,
    timeoutCutMs: 0,
    retryMs: 0,
    backoffMs: 0,
    fallbackMs: 0,
    queueMs: 0,
  };
  for (const entry of ledger.entries)
    for (const key of LEDGER_CATEGORY_KEYS) totals[key] += entry.breakdown[key];
  return totals;
}

export function compareLedgers(
  baseline: SimulationLedger,
  comparison: SimulationLedger,
): LedgerDelta[] {
  const before = sumBreakdown(baseline);
  const after = sumBreakdown(comparison);
  return LEDGER_CATEGORY_KEYS.map((key) => ({
    key,
    label: LEDGER_CATEGORY_LABELS[key],
    baselineMs: before[key],
    comparisonMs: after[key],
    deltaMs: after[key] - before[key],
  })).sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs));
}

function describeNodeChanges(
  before: RequestNode,
  after: RequestNode,
): string[] {
  const changes: string[] = [];
  if (before.durationMs !== after.durationMs)
    changes.push(
      `${before.name} · 耗时 ${before.durationMs} → ${after.durationMs} ms`,
    );
  if (before.jitterMs !== after.jitterMs)
    changes.push(
      `${before.name} · 波动 ±${before.jitterMs} → ±${after.jitterMs} ms`,
    );
  if (before.timeoutMs !== after.timeoutMs)
    changes.push(
      `${before.name} · 超时 ${before.timeoutMs} → ${after.timeoutMs} ms`,
    );
  if (before.retryCount !== after.retryCount)
    changes.push(
      `${before.name} · 重试 ${before.retryCount} → ${after.retryCount} 次`,
    );
  if (before.failureRate !== after.failureRate)
    changes.push(
      `${before.name} · 失败率 ${before.failureRate} → ${after.failureRate}%`,
    );
  if (before.fallbackNodeId !== after.fallbackNodeId)
    changes.push(`${before.name} · 降级目标已调整`);
  if (before.dependencyIds.join("|") !== after.dependencyIds.join("|"))
    changes.push(`${before.name} · 前置依赖已调整`);
  return changes;
}

export function compareScenarios(
  baseline: ScenarioSnapshot,
  comparison: ScenarioSnapshot,
): ScenarioComparison {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const comparisonNodes = new Map(
    comparison.nodes.map((node) => [node.id, node]),
  );
  const changes = [
    ...baseline.nodes.flatMap((node) => {
      const next = comparisonNodes.get(node.id);
      return next
        ? describeNodeChanges(node, next)
        : [`${node.name} · 已从对照方案移除`];
    }),
    ...comparison.nodes
      .filter((node) => !baselineNodes.has(node.id))
      .map((node) => `${node.name} · 新增请求节点`),
  ];
  if (baseline.concurrencyLimit !== comparison.concurrencyLimit)
    changes.unshift(
      `并发上限 · ${baseline.concurrencyLimit ?? "不限"} → ${comparison.concurrencyLimit ?? "不限"}`,
    );
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
    ...(baseline.ledger && comparison.ledger
      ? { ledgerDelta: compareLedgers(baseline.ledger, comparison.ledger) }
      : {}),
  };
}

export function saveScenario(
  project: LatencyProject,
  result: SimulationResult,
  name: string,
): LatencyProject {
  if (
    result.warnings.some(
      (warning) => warning.includes("检测到循环") || warning.includes("不能"),
    )
  )
    return project;
  const snapshot: ScenarioSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || `方案 ${project.scenarios.length + 1}`,
    createdAt: Date.now(),
    concurrencyLimit: project.concurrencyLimit,
    nodes: structuredClone(project.nodes),
    completionMs: result.completionMs,
    criticalPath: [...result.criticalPath],
    ledger: structuredClone(result.ledger),
  };
  return {
    ...project,
    scenarios: [snapshot, ...project.scenarios],
    updatedAt: Date.now(),
  };
}

export function removeScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  return {
    ...project,
    scenarios: project.scenarios.filter(
      (scenario) => scenario.id !== scenarioId,
    ),
    updatedAt: Date.now(),
  };
}

export function restoreScenario(
  project: LatencyProject,
  scenarioId: string,
): LatencyProject {
  const snapshot = project.scenarios.find(
    (scenario) => scenario.id === scenarioId,
  );
  if (!snapshot) return project;
  return {
    ...project,
    nodes: structuredClone(snapshot.nodes),
    concurrencyLimit: snapshot.concurrencyLimit,
    updatedAt: Date.now(),
  };
}
