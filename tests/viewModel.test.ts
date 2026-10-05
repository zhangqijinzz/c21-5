import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  compareScenarios,
  restoreScenario,
  saveScenario,
  summarizeLedger,
} from "../src/features/scenarios/scenarioViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  EXAMPLE_PROJECT,
  type ScenarioSnapshot,
} from "../src/shared/domain/types";

describe("project and scenario view models", () => {
  it("creates a project and switches the active project", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const created = createProject(initial, 100);
    expect(created.projects).toHaveLength(2);
    expect(created.activeProjectId).not.toBe(EXAMPLE_PROJECT.id);
    expect(selectProject(created, EXAMPLE_PROJECT.id).activeProjectId).toBe(
      EXAMPLE_PROJECT.id,
    );
  });

  it("duplicates a project and remaps its dependency identities", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const duplicated = duplicateProject(initial, EXAMPLE_PROJECT, 10);
    const copy = duplicated.projects[0];
    expect(copy?.nodes[2]?.dependencyIds).toEqual([copy?.nodes[0]?.id]);
    expect(copy?.nodes[4]?.fallbackNodeId).toBe(copy?.nodes[3]?.id);
    expect(copy?.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(copy?.scenarios).toEqual([]);
  });

  it("saves a complete snapshot and restores its parameters", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const result = simulateProject(baseline);
    const saved = saveScenario(baseline, result, "并发方案");
    expect(saved.scenarios).toHaveLength(1);
    const changed = {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, durationMs: 999 })),
    };
    const restored = restoreScenario(changed, saved.scenarios[0]?.id ?? "");
    expect(restored.nodes[0]?.durationMs).toBe(baseline.nodes[0]?.durationMs);
  });

  it("describes node and concurrency differences between snapshots", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const baselineSnapshot = saveScenario(
      baseline,
      simulateProject(baseline),
      "不限并发",
    ).scenarios[0];
    const changed = {
      ...baseline,
      concurrencyLimit: 1,
      nodes: baseline.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 900 } : node,
      ),
    };
    const changedSnapshot = saveScenario(
      changed,
      simulateProject(changed),
      "串行优化",
    ).scenarios[0];
    if (!baselineSnapshot || !changedSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(baselineSnapshot, changedSnapshot);
    expect(comparison.deltaMs).toBeGreaterThan(0);
    expect(comparison.changes.join(" ")).toContain("并发上限");
    expect(comparison.changes.join(" ")).toContain("耗时");
  });

  it("keeps the ledger inside the snapshot and reconciles with its budget", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
    };
    const saved = saveScenario(
      baseline,
      simulateProject(baseline),
      "带账本方案",
    );
    const snapshot = saved.scenarios[0];
    expect(snapshot?.ledger).toHaveLength(baseline.nodes.length);
    const summary = snapshot ? summarizeLedger(snapshot) : undefined;
    expect(summary).toBeDefined();
    if (!snapshot || !summary) return;
    const execution =
      summary.baseMs +
      summary.jitterMs +
      summary.timeoutTruncationMs +
      summary.retryMs +
      summary.backoffMs +
      summary.fallbackMs;
    expect(execution).toBeCloseTo(snapshot.completionMs, 8);
  });

  it("shows which ledger categories pushed the budget up", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const baselineSnapshot = saveScenario(
      baseline,
      simulateProject(baseline),
      "基准",
    ).scenarios[0];
    const changed = {
      ...baseline,
      nodes: baseline.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              durationMs: node.durationMs + 400,
              retryCount: 2,
              failureRate: 10,
            }
          : node,
      ),
    };
    const changedSnapshot = saveScenario(
      changed,
      simulateProject(changed),
      "加重",
    ).scenarios[0];
    if (!baselineSnapshot || !changedSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(baselineSnapshot, changedSnapshot);
    const shift = comparison.ledgerShift;
    expect(shift).toBeDefined();
    const baseShift = shift?.find((item) => item.key === "baseMs");
    const retryShift = shift?.find((item) => item.key === "retryMs");
    const backoffShift = shift?.find((item) => item.key === "backoffMs");
    expect(baseShift?.deltaMs).toBeGreaterThan(0);
    expect(retryShift?.deltaMs).toBeGreaterThan(0);
    expect(backoffShift?.deltaMs).toBeGreaterThan(0);
    const pushed = (shift ?? []).filter((item) => item.deltaMs > 0);
    expect(pushed.length).toBeGreaterThan(0);
  });

  it("compares legacy snapshots without ledger data gracefully", () => {
    const legacy: ScenarioSnapshot = {
      id: "legacy-1",
      name: "旧快照",
      createdAt: 1_728_000_000_000,
      concurrencyLimit: null,
      nodes: structuredClone(EXAMPLE_PROJECT.nodes),
      completionMs: 1200,
      criticalPath: [EXAMPLE_PROJECT.nodes[0]?.id ?? ""],
    };
    const current = saveScenario(
      EXAMPLE_PROJECT,
      simulateProject(EXAMPLE_PROJECT),
      "新快照",
    ).scenarios[0];
    if (!current) throw new Error("Scenario fixture should be saved");
    const comparison = compareScenarios(legacy, current);
    expect(comparison.ledgerShift).toBeUndefined();
    expect(comparison.deltaMs).toBe(current.completionMs - 1200);
    expect(summarizeLedger(legacy)).toBeUndefined();
  });
});
