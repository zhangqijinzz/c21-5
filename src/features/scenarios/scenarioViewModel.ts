import type {
  LatencyProject,
  NodeLedgerEntry,
  RequestNode,
  ScenarioSnapshot,
  SimulationResult,
} from "../../shared/domain/types";

export const LEDGER_CATEGORIES = [
  { key: "baseMs", label: "基础耗时" },
  { key: "jitterMs", label: "波动影响" },
  { key: "timeoutTruncationMs", label: "超时截断" },
  { key: "retryMs", label: "期望重试" },
  { key: "backoffMs", label: "退避等待" },
  { key: "fallbackMs", label: "降级加权" },
  { key: "queueMs", label: "资源排队" },
] as const;

export type LedgerCategoryKey = (typeof LEDGER_CATEGORIES)[number]["key"];

export interface LedgerShift {
  key: LedgerCategoryKey;
  label: string;
  baselineMs: number;
  comparisonMs: number;
  deltaMs: number;
}

export interface ScenarioComparison {
  deltaMs: number;
  changes: string[];
  outcome: "faster" | "slower" | "equal";
  ledgerShift?: LedgerShift[];
}

function sumCategory(
  entries: NodeLedgerEntry[],
  key: LedgerCategoryKey,
): number {
  return entries.reduce((sum, entry) => sum + entry[key], 0);
}

export function summarizeLedger(
  snapshot: ScenarioSnapshot,
): Record<LedgerCategoryKey, number> | undefined {
  if (!snapshot.ledger?.length) return undefined;
  const critical = new Set(snapshot.criticalPath);
  const onCriticalPath = snapshot.ledger.filter((entry) =>
    critical.has(entry.nodeId),
  );
  const entries = onCriticalPath.length ? onCriticalPath : snapshot.ledger;
  return Object.fromEntries(
    LEDGER_CATEGORIES.map(({ key }) => [key, sumCategory(entries, key)]),
  ) as Record<LedgerCategoryKey, number>;
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
  const baselineLedger = summarizeLedger(baseline);
  const comparisonLedger = summarizeLedger(comparison);
  const ledgerShift =
    baselineLedger && comparisonLedger
      ? LEDGER_CATEGORIES.map(({ key, label }) => ({
          key,
          label,
          baselineMs: baselineLedger[key],
          comparisonMs: comparisonLedger[key],
          deltaMs: comparisonLedger[key] - baselineLedger[key],
        }))
      : undefined;
  return {
    deltaMs: comparison.completionMs - baseline.completionMs,
    changes,
    outcome:
      comparison.completionMs < baseline.completionMs
        ? "faster"
        : comparison.completionMs > baseline.completionMs
          ? "slower"
          : "equal",
    ...(ledgerShift ? { ledgerShift } : {}),
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
