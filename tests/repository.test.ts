import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../src/shared/repositories/projectRepository";
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

  it("loads legacy snapshots without ledger and keeps ledgered ones intact", async () => {
    const storage = new MemoryStorage();
    const ledgerRow = {
      nodeId: EXAMPLE_PROJECT.nodes[0]?.id ?? "session",
      baseMs: 280,
      jitterMs: 40,
      timeoutTruncationMs: 0,
      expectedAttempts: 1.01,
      retryMs: 3.2,
      backoffMs: 2,
      fallbackMs: 0,
      queueMs: 0,
      totalMs: 325.2,
    };
    storage.value = {
      version: 1,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [
        {
          ...structuredClone(EXAMPLE_PROJECT),
          scenarios: [
            {
              id: "legacy",
              name: "旧快照",
              createdAt: 1_728_000_000_000,
              concurrencyLimit: null,
              nodes: structuredClone(EXAMPLE_PROJECT.nodes),
              completionMs: 1200,
              criticalPath: [EXAMPLE_PROJECT.nodes[0]?.id],
            },
            {
              id: "ledgered",
              name: "新快照",
              createdAt: 1_728_000_100_000,
              concurrencyLimit: 2,
              nodes: structuredClone(EXAMPLE_PROJECT.nodes),
              completionMs: 900,
              criticalPath: [EXAMPLE_PROJECT.nodes[0]?.id],
              ledger: [ledgerRow, { broken: true }],
            },
          ],
        },
      ],
    };
    const loaded = await new ProjectRepository(storage).load();
    const scenarios = loaded.document.projects[0]?.scenarios ?? [];
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]?.name).toBe("旧快照");
    expect(scenarios[0]?.ledger).toBeUndefined();
    expect(scenarios[0]?.completionMs).toBe(1200);
    expect(scenarios[1]?.ledger).toHaveLength(1);
    expect(scenarios[1]?.ledger?.[0]).toMatchObject({
      nodeId: ledgerRow.nodeId,
      baseMs: 280,
      queueMs: 0,
      totalMs: 325.2,
    });
  });
});
