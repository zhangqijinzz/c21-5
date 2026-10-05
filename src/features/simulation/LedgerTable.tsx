import type {
  LatencyProject,
  NodeLedgerEntry,
  RequestNode,
  SimulationResult,
} from "../../shared/domain/types";

interface Props {
  project: LatencyProject;
  result: SimulationResult;
}

function formatMs(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ms`;
}

function formatTotal(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function percent(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}%`;
}

interface Column {
  key: keyof Pick<
    NodeLedgerEntry,
    | "baseMs"
    | "jitterMs"
    | "timeoutTruncationMs"
    | "retryMs"
    | "backoffMs"
    | "fallbackMs"
    | "queueMs"
  >;
  label: string;
  source: (
    node: RequestNode,
    entry: NodeLedgerEntry,
    ctx: {
      mode: SimulationResult["mode"];
      nodes: Map<string, RequestNode>;
      concurrencyLimit: number | null;
    },
  ) => string;
}

const columns: Column[] = [
  {
    key: "baseMs",
    label: "基础耗时",
    source: (node) => `耗时 ${node.durationMs}ms`,
  },
  {
    key: "jitterMs",
    label: "波动影响",
    source: (node, _entry, ctx) =>
      `波动 ±${node.jitterMs}ms × ${ctx.mode === "low" ? 0 : ctx.mode === "high" ? 1 : 0.5}`,
  },
  {
    key: "timeoutTruncationMs",
    label: "超时截断",
    source: (node, entry) =>
      !node.timeoutMs
        ? "未设超时"
        : entry.timeoutTruncationMs < 0
          ? `超时 ${node.timeoutMs}ms 截断`
          : `超时 ${node.timeoutMs}ms 未触发`,
  },
  {
    key: "retryMs",
    label: "期望重试",
    source: (node, entry) =>
      `期望 ${(Math.round(entry.expectedAttempts * 100) / 100).toFixed(2)} 次 · 失败率 ${node.failureRate}%`,
  },
  {
    key: "backoffMs",
    label: "退避等待",
    source: (node) =>
      node.retryCount > 0
        ? `重试 ${node.retryCount} 次 · 200ms 指数封顶 2s`
        : "不重试",
  },
  {
    key: "fallbackMs",
    label: "降级加权",
    source: (node, _entry, ctx) => {
      const fallback = node.fallbackNodeId
        ? ctx.nodes.get(node.fallbackNodeId)
        : undefined;
      if (!fallback) return "未配置降级";
      const terminalFailure =
        (node.failureRate / 100) ** (node.retryCount + 1) * 100;
      return `终败率 ${percent(terminalFailure)} × ${fallback.name}`;
    },
  },
  {
    key: "queueMs",
    label: "资源排队",
    source: (_node, _entry, ctx) =>
      ctx.concurrencyLimit
        ? `并发上限 ${ctx.concurrencyLimit} 路`
        : "不限并发",
  },
];

export default function LedgerTable({ project, result }: Props) {
  if (!result.ledger.length) return null;
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  const critical = new Set(result.criticalPath);
  const ctx = {
    mode: result.mode,
    nodes,
    concurrencyLimit: project.concurrencyLimit,
  };
  const criticalEntries = result.ledger.filter((entry) =>
    critical.has(entry.nodeId),
  );
  const totals = Object.fromEntries(
    columns.map(({ key }) => [
      key,
      criticalEntries.reduce((sum, entry) => sum + entry[key], 0),
    ]),
  ) as Record<(typeof columns)[number]["key"], number>;
  const executionTotal =
    totals.baseMs +
    totals.jitterMs +
    totals.timeoutTruncationMs +
    totals.retryMs +
    totals.backoffMs +
    totals.fallbackMs;
  return (
    <div className="ledger-card">
      <div className="timeline-head">
        <div>
          <span className="section-label">耗时账本</span>
          <span className="timeline-caption">
            逐项归因到节点参数，关键路径分项合计 = 完成预算
          </span>
        </div>
      </div>
      <div className="ledger-scroll">
        <div className="ledger-table ledger-table-head">
          <span className="ledger-node-col">节点</span>
          {columns.map((column) => (
            <span key={column.key}>{column.label}</span>
          ))}
          <span>节点合计</span>
        </div>
        {result.ledger.map((entry) => {
          const node = nodes.get(entry.nodeId);
          if (!node) return null;
          const isCritical = critical.has(entry.nodeId);
          return (
            <div
              className={`ledger-table ledger-row ${isCritical ? "is-critical" : ""}`}
              key={entry.nodeId}
            >
              <span className="ledger-node-col">
                <b>{node.name}</b>
                <small>{isCritical ? "关键路径" : "非关键路径"}</small>
              </span>
              {columns.map((column) => (
                <span className="ledger-cell" key={column.key}>
                  <b
                    className={
                      column.key === "timeoutTruncationMs" &&
                      entry[column.key] < 0
                        ? "ledger-negative"
                        : undefined
                    }
                  >
                    {formatMs(entry[column.key])}
                  </b>
                  <small>{column.source(node, entry, ctx)}</small>
                </span>
              ))}
              <span className="ledger-cell ledger-total">
                <b>{formatMs(entry.totalMs)}</b>
                <small>含排队占用</small>
              </span>
            </div>
          );
        })}
        <div className="ledger-table ledger-row ledger-summary">
          <span className="ledger-node-col">
            <b>关键路径合计</b>
            <small>{result.criticalPath.length} 个节点</small>
          </span>
          {columns.map((column) => (
            <span className="ledger-cell" key={column.key}>
              <b>
                {formatMs(totals[column.key])}
                {column.key === "queueMs" && totals.queueMs > 0 ? " *" : ""}
              </b>
            </span>
          ))}
          <span className="ledger-cell ledger-total">
            <b>{formatTotal(executionTotal)}</b>
            <small>= 完成预算 {formatTotal(result.completionMs)}</small>
          </span>
        </div>
      </div>
      <div className="model-footnote">
        每行分项相加 = 该节点建模耗时 + 排队占用；关键路径上执行分项（基础、波动、截断、重试、退避、降级）逐节点相加
        = 完成预算。
        {totals.queueMs > 0
          ? " * 资源排队与槽位前驱的执行时段重叠，已体现在关键路径结构中，不重复计入完成预算。"
          : ""}
      </div>
    </div>
  );
}
