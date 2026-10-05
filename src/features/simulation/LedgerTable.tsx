import { ReceiptText } from "lucide-react";
import type {
  LatencyProject,
  RequestNode,
  SimulationLedger,
} from "../../shared/domain/types";

interface Props {
  project: LatencyProject;
  ledger: SimulationLedger;
}

const columns: {
  key: keyof SimulationLedger["entries"][number]["breakdown"];
  label: string;
  param: string;
}[] = [
  { key: "baseMs", label: "基础耗时", param: "预计耗时" },
  { key: "jitterMs", label: "波动影响", param: "延迟波动 × 情境" },
  { key: "timeoutCutMs", label: "超时截断", param: "超时阈值" },
  { key: "retryMs", label: "期望重试", param: "重试次数 × 失败概率" },
  { key: "backoffMs", label: "退避等待", param: "200ms 指数退避" },
  { key: "fallbackMs", label: "降级加权", param: "降级目标 × 最终失败率" },
  { key: "queueMs", label: "资源排队", param: "最大并发" },
];

function formatMs(value: number): string {
  if (Object.is(value, -0) || Math.abs(value) < 0.05) return "0";
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

function describeParams(
  node: RequestNode,
  nodes: RequestNode[],
  jitterFactor: number,
): string {
  const parts = [
    `耗时 ${node.durationMs}ms`,
    `波动 ±${node.jitterMs}ms × ${jitterFactor}`,
    `超时 ${node.timeoutMs}ms`,
    `重试 ${node.retryCount} 次`,
    `失败率 ${node.failureRate}%`,
  ];
  const fallback = node.fallbackNodeId
    ? nodes.find((item) => item.id === node.fallbackNodeId)
    : undefined;
  if (fallback) parts.push(`降级→${fallback.name}`);
  return parts.join(" · ");
}

export default function LedgerTable({ project, ledger }: Props) {
  const critical = new Set(ledger.criticalPath);
  const reconciled =
    Math.abs(ledger.criticalDurationMs - ledger.completionMs) < 1e-6;
  return (
    <div className="ledger-card">
      <div className="timeline-head">
        <div>
          <span className="section-label">
            <ReceiptText size={12} /> 耗时账本
          </span>
          <span className="timeline-caption">
            逐项拆分可定位到节点参数，关键路径各项相加等于完成预算
          </span>
        </div>
        <span
          className={`ledger-reconcile ${reconciled ? "is-balanced" : "is-off"}`}
        >
          关键路径合计 {formatMs(ledger.criticalDurationMs)} ms = 完成预算{" "}
          {formatMs(ledger.completionMs)} ms
        </span>
      </div>
      <div className="ledger-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>节点 / 参数</th>
              {columns.map((column) => (
                <th key={column.key}>
                  {column.label}
                  <small>{column.param}</small>
                </th>
              ))}
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            {ledger.entries.map((entry) => {
              const node = project.nodes.find(
                (item) => item.id === entry.nodeId,
              );
              if (!node) return null;
              return (
                <tr key={entry.nodeId}>
                  <td>
                    <b>
                      {critical.has(entry.nodeId) && (
                        <em className="ledger-critical-mark">关键</em>
                      )}
                      {node.name}
                    </b>
                    <small>
                      {describeParams(node, project.nodes, ledger.jitterFactor)}
                    </small>
                  </td>
                  {columns.map((column) => {
                    const value = entry.breakdown[column.key];
                    return (
                      <td
                        key={column.key}
                        className={value < 0 ? "ledger-negative" : ""}
                      >
                        {formatMs(value)}
                        {column.key === "retryMs" && (
                          <small>
                            期望 {entry.expectedAttempts.toFixed(2)} 次
                          </small>
                        )}
                      </td>
                    );
                  })}
                  <td className="ledger-total">{formatMs(entry.totalMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!ledger.entries.length && (
          <div className="timeline-empty">修复链路配置后即可生成账本。</div>
        )}
      </div>
      <p className="ledger-footnote">
        单位 ms。合计 =
        七项之和（含排队）；关键路径上各节点的耗时项（不含排队）相加 =
        完成预算，排队等待已与前序节点耗时重叠。
      </p>
    </div>
  );
}
