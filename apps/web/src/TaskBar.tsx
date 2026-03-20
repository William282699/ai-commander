// ============================================================
// AI Commander — TaskBar UI (Prompt 3)
// Displays active TaskCards with priority, status, and cancel.
// Pure display + light interaction — does not modify GameState.
// ============================================================

import { useState } from "react";
import type { TaskCard, TaskPriority } from "@ai-commander/shared";

interface Props {
  tasks: TaskCard[];
  onChangePriority: (taskId: string, priority: TaskPriority) => void;
  onCancel: (taskId: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  assigned: "已分配",
  moving: "移动中",
  engaged: "交战中",
  holding: "执行中",
  failing: "告急",
  completed: "完成",
  cancelled: "已取消",
};

const STATUS_COLORS: Record<string, string> = {
  assigned: "#94a3b8",
  moving: "#38bdf8",
  engaged: "#f97316",
  holding: "#22c55e",
  failing: "#ef4444",
  completed: "#6b7280",
  cancelled: "#6b7280",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "#64748b",
  normal: "#94a3b8",
  high: "#f59e0b",
  critical: "#ef4444",
};

const PRIORITY_CYCLE: TaskPriority[] = ["low", "normal", "high", "critical"];

const CMD_LABELS: Record<string, string> = {
  combat: "Chen",
  ops: "Marcus",
  logistics: "Emily",
};

export function TaskBar({ tasks, onChangePriority, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const activeTasks = tasks.filter(t => t.status !== "completed" && t.status !== "cancelled");

  const displayTasks = expanded ? activeTasks : activeTasks.slice(0, 5);

  return (
    <div style={{
      position: "absolute",
      bottom: 8,
      left: 8,
      width: 220,
      maxHeight: expanded ? 400 : 260,
      overflow: "hidden",
      fontFamily: "monospace",
      fontSize: 11,
      zIndex: 120,
      pointerEvents: "auto",
    }}>
      <div style={{
        background: "rgba(15, 23, 42, 0.9)",
        border: "1px solid #334155",
        borderRadius: 6,
        padding: 6,
      }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
          padding: "0 2px",
        }}>
          <span style={{ color: "#e2e8f0", fontWeight: "bold", fontSize: 11 }}>
            TASKS ({activeTasks.length})
          </span>
          {activeTasks.length > 5 && (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                background: "none",
                border: "none",
                color: "#64748b",
                cursor: "pointer",
                fontSize: 10,
                padding: 0,
              }}
            >
              {expanded ? "收起" : `+${activeTasks.length - 5}`}
            </button>
          )}
        </div>

        <div style={{ maxHeight: expanded ? 360 : 220, overflowY: "auto" }}>
          {activeTasks.length === 0 && (
            <div style={{ color: "#475569", fontSize: 10, padding: "4px 2px", textAlign: "center" }}>
              暂无任务
            </div>
          )}
          {displayTasks.map((task) => (
            <div
              key={task.id}
              style={{
                background: task.priority === "critical"
                  ? "rgba(239, 68, 68, 0.15)"
                  : "rgba(30, 41, 59, 0.8)",
                border: `1px solid ${task.priority === "critical" ? "#dc2626" : "#1e293b"}`,
                borderRadius: 4,
                padding: "4px 6px",
                marginBottom: 3,
              }}
            >
              {/* Title + Commander */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{
                  color: "#e2e8f0",
                  fontWeight: task.priority === "critical" ? "bold" : "normal",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 140,
                }}>
                  {task.title}
                </span>
                <span style={{ color: "#64748b", fontSize: 9 }}>
                  {CMD_LABELS[task.commander] ?? task.commander}
                </span>
              </div>

              {/* Status + Priority + Squads */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                <span style={{
                  color: STATUS_COLORS[task.status] ?? "#94a3b8",
                  fontSize: 10,
                  fontWeight: task.status === "failing" ? "bold" : "normal",
                }}>
                  {STATUS_LABELS[task.status] ?? task.status}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {task.assignedSquads.length > 0 && (
                    <span style={{ color: "#64748b", fontSize: 9 }}>
                      {task.assignedSquads.join(",")}
                    </span>
                  )}
                  <button
                    onClick={() => {
                      const idx = PRIORITY_CYCLE.indexOf(task.priority);
                      const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
                      onChangePriority(task.id, next);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: PRIORITY_COLORS[task.priority] ?? "#94a3b8",
                      fontSize: 9,
                      fontWeight: "bold",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {task.priority.toUpperCase()}
                  </button>
                </div>
              </div>

              {/* Constraint badge */}
              {task.constraint && (
                <div style={{ marginTop: 2 }}>
                  <span style={{
                    background: "rgba(239, 68, 68, 0.2)",
                    color: "#fca5a5",
                    fontSize: 9,
                    padding: "1px 4px",
                    borderRadius: 2,
                  }}>
                    {task.constraint}
                  </span>
                </div>
              )}

              {/* Cancel button */}
              {task.status !== "completed" && task.status !== "cancelled" && (
                <div style={{ marginTop: 3, textAlign: "right" }}>
                  {confirmCancel === task.id ? (
                    <span style={{ fontSize: 9 }}>
                      <span style={{ color: "#94a3b8" }}>确认取消？</span>
                      <button
                        onClick={() => { onCancel(task.id); setConfirmCancel(null); }}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#ef4444",
                          cursor: "pointer",
                          fontSize: 9,
                          padding: "0 4px",
                        }}
                      >
                        是
                      </button>
                      <button
                        onClick={() => setConfirmCancel(null)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#64748b",
                          cursor: "pointer",
                          fontSize: 9,
                          padding: "0 4px",
                        }}
                      >
                        否
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmCancel(task.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#64748b",
                        cursor: "pointer",
                        fontSize: 9,
                        padding: 0,
                      }}
                    >
                      取消任务
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
