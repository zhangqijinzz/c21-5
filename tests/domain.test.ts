import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/shared/domain/graph";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  addRequestNode,
  toggleDependency,
} from "../src/features/graph-editor/graphViewModel";

describe("request dependency graph", () => {
  it("orders a DAG and detects a cycle before simulation", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    expect(analyzeGraph(project).order).toHaveLength(project.nodes.length);
    const cyclic = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    };
    expect(analyzeGraph(cyclic).validation.errors.join(" ")).toContain(
      "循环依赖",
    );
    expect(simulateProject(cyclic).entries).toHaveLength(0);
  });

  it("rejects cyclic edges and accepts valid dependencies", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
    };
    const accepted = toggleDependency(project, "profile", "flags");
    expect(accepted.error).toBeUndefined();
    const rejected = toggleDependency(accepted.project, "flags", "profile");
    expect(rejected.error).toContain("循环");
    expect(rejected.project).toEqual(accepted.project);
  });

  it("schedules independent roots in parallel and serializes them at concurrency one", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2).map((node) => ({
        ...node,
        durationMs: 300,
        jitterMs: 0,
        timeoutMs: 1000,
        retryCount: 0,
        failureRate: 0,
      })),
    };
    const parallel = simulateProject(project);
    const serial = simulateProject({ ...project, concurrencyLimit: 1 });
    expect(parallel.completionMs).toBe(300);
    expect(serial.completionMs).toBe(600);
    expect(serial.entries[1]?.waitMs).toBe(300);
  });

  it("applies jitter modes, timeout caps, bounded retries, and fallback probability", () => {
    const node = {
      id: "a",
      name: "slow",
      durationMs: 1200,
      jitterMs: 400,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 1,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const fallback = {
      ...node,
      id: "b",
      name: "fallback",
      durationMs: 200,
      jitterMs: 0,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [node, fallback] };
    const low = simulateProject(project, "low");
    const expected = simulateProject(project, "expected");
    const high = simulateProject(project, "high");
    expect(low.completionMs).toBeLessThanOrEqual(expected.completionMs);
    expect(expected.completionMs).toBeLessThanOrEqual(high.completionMs);
    expect(high.warnings.join(" ")).toContain("超时");
    expect(high.entries[0]?.modeledDurationMs).toBe(1650);
    const invalid = {
      ...project,
      nodes: [{ ...node, retryCount: 9 }, fallback],
    };
    expect(simulateProject(invalid).entries).toHaveLength(0);
  });

  it("creates an editable request node with safe defaults", () => {
    const project = { ...EXAMPLE_PROJECT, nodes: [] };
    const next = addRequestNode(project);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.durationMs).toBe(400);
    expect(next.nodes[0]?.dependencyIds).toEqual([]);
  });

  it("itemizes every node's budget and reconciles the ledger with the total", () => {
    for (const mode of ["low", "expected", "high"] as const) {
      const result = simulateProject(EXAMPLE_PROJECT, mode);
      expect(result.ledger.entries).toHaveLength(EXAMPLE_PROJECT.nodes.length);
      for (const entry of result.ledger.entries) {
        const timeline = result.entries.find(
          (item) => item.nodeId === entry.nodeId,
        );
        const items = Object.values(entry.breakdown).reduce(
          (sum, value) => sum + value,
          0,
        );
        expect(items).toBeCloseTo(entry.totalMs, 10);
        expect(entry.totalMs).toBeCloseTo(
          (timeline?.modeledDurationMs ?? 0) + (timeline?.waitMs ?? 0),
          10,
        );
        expect(entry.breakdown.queueMs).toBeCloseTo(timeline?.waitMs ?? 0, 10);
      }
      expect(result.ledger.criticalDurationMs).toBeCloseTo(
        result.completionMs,
        10,
      );
    }
  });

  it("breaks a truncated, retried, degraded node down to exact line items", () => {
    const node = {
      id: "a",
      name: "slow",
      durationMs: 1200,
      jitterMs: 400,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 1,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const fallback = {
      ...node,
      id: "b",
      name: "fallback",
      durationMs: 200,
      jitterMs: 0,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [node, fallback] };
    const { ledger } = simulateProject(project, "high");
    const entry = ledger.entries.find((item) => item.nodeId === "a");
    expect(entry?.breakdown).toEqual({
      baseMs: 1200,
      jitterMs: 400,
      timeoutCutMs: -600,
      retryMs: 500,
      backoffMs: 100,
      fallbackMs: 50,
      queueMs: 0,
    });
    expect(entry?.expectedAttempts).toBeCloseTo(1.5, 10);
    expect(entry?.terminalFailureRate).toBeCloseTo(0.25, 10);
    expect(entry?.totalMs).toBe(1650);
  });

  it("attributes serialization at the concurrency limit to resource queueing", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      concurrencyLimit: 1,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2).map((node) => ({
        ...node,
        durationMs: 300,
        jitterMs: 0,
        timeoutMs: 1000,
        retryCount: 0,
        failureRate: 0,
      })),
    };
    const { ledger, completionMs } = simulateProject(project);
    expect(completionMs).toBe(600);
    expect(ledger.entries[0]?.breakdown.queueMs).toBe(0);
    expect(ledger.entries[1]?.breakdown.queueMs).toBe(300);
    expect(ledger.criticalDurationMs).toBe(600);
  });
});
