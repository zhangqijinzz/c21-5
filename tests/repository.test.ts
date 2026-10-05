import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
import { simulateProject } from "../src/shared/domain/simulation";
import { saveScenario } from "../src/features/scenarios/scenarioViewModel";
import {
  EXAMPLE_PROJECT,
  type WorkspaceDocument,
} from "../src/shared/domain/types";

class MemoryStorage {
  value: unknown = undefined;
  failWrite = false;
  async read(): Promise<unknown> {
    return this.value;
  }
  async write(value: WorkspaceDocument): Promise<void> {
    if (this.failWrite) throw new Error("simulated IndexedDB quota failure");
    this.value = structuredClone(value);
  }
}

describe("project repository recovery", () => {
  beforeEach(() => localStorage.clear());

  it("provides a usable example when both stores are empty or damaged", async () => {
    const storage = new MemoryStorage();
    storage.value = { version: 99, projects: "broken" };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.document.projects[0]?.nodes.length).toBeGreaterThan(0);
  });

  it("restores the local recovery copy when IndexedDB data is malformed", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await repository.save(document);
    storage.value = { version: 1, projects: [{ id: 5, nodes: [] }] };
    const loaded = await repository.load();
    expect(loaded.recovered).toBe(true);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(
      EXAMPLE_PROJECT.nodes.length,
    );
  });

  it("keeps readable projects while dropping malformed project rows and broken edges", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...EXAMPLE_PROJECT,
          nodes: [
            { ...EXAMPLE_PROJECT.nodes[0], dependencyIds: ["missing"] },
            { damaged: true },
          ],
        },
        { id: 9, title: null },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    expect(loaded.document.projects).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes).toHaveLength(1);
    expect(loaded.document.projects[0]?.nodes[0]?.dependencyIds).toEqual([]);
    expect(loaded.recovered).toBe(true);
  });

  it("keeps a local recovery copy when IndexedDB saving fails", async () => {
    const storage = new MemoryStorage();
    storage.failWrite = true;
    const repository = new ProjectRepository(storage);
    const document: WorkspaceDocument = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [structuredClone(EXAMPLE_PROJECT)],
    };
    await expect(repository.save(document)).rejects.toThrow(
      "IndexedDB quota failure",
    );
    storage.failWrite = false;
    const loaded = await repository.load();
    expect(loaded.document.projects[0]?.id).toBe(EXAMPLE_PROJECT.id);
    expect(loaded.recovered).toBe(true);
  });

  it("loads legacy snapshots without ledger data and drops malformed ledgers only", async () => {
    const storage = new MemoryStorage();
    const scenarioBase = {
      id: "scenario-1",
      name: "旧方案",
      createdAt: 1_728_000_000_000,
      concurrencyLimit: null,
      nodes: structuredClone(EXAMPLE_PROJECT.nodes),
      completionMs: 1200,
      criticalPath: ["session"],
    };
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...structuredClone(EXAMPLE_PROJECT),
          scenarios: [
            scenarioBase,
            {
              ...scenarioBase,
              id: "scenario-2",
              name: "明细损坏的方案",
              ledger: { mode: "expected", entries: [{ nodeId: 7 }] },
            },
          ],
        },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    const scenarios = loaded.document.projects[0]?.scenarios;
    expect(scenarios).toHaveLength(2);
    expect(scenarios?.[0]?.completionMs).toBe(1200);
    expect(scenarios?.[0]?.ledger).toBeUndefined();
    expect(scenarios?.[1]?.ledger).toBeUndefined();
  });

  it("round-trips snapshots together with their ledger breakdown", async () => {
    const storage = new MemoryStorage();
    const repository = new ProjectRepository(storage);
    const project = structuredClone(EXAMPLE_PROJECT);
    const result = simulateProject(project);
    const withScenario = saveScenario(project, result, "带账本");
    const document: WorkspaceDocument = {
      version: 1,
      activeProjectId: project.id,
      projects: [withScenario],
    };
    await repository.save(document);
    const loaded = await repository.load();
    const scenario = loaded.document.projects[0]?.scenarios[0];
    expect(scenario?.ledger?.entries).toHaveLength(project.nodes.length);
    expect(scenario?.ledger?.criticalDurationMs).toBeCloseTo(
      scenario?.completionMs ?? Number.NaN,
      10,
    );
  });
});
