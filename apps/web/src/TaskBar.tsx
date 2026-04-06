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
    <div className="hud-taskbar" style={{ maxHeight: expanded ? 400 : 260, overflow: "hidden" }}>
      <div className="hud-taskbar__inner">
        <div className="hud-taskbar__header">
          <span className="hud-taskbar__title">
            TASKS ({activeTasks.length})
          </span>
          {activeTasks.length > 5 && (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{
                background: "none",
                border: "none",
                color: "var(--hud-text-dim)",
                cursor: "pointer",
                fontSize: 10,
                padding: 0,
                fontFamily: "var(--hud-font-mono)",
              }}
            >
              {expanded ? "收起" : `+${activeTasks.length - 5}`}
            </button>
          )}
        </div>

        <div className="hud-taskbar__scroll hud-scroll" style={{ maxHeight: expanded ? 360 : 220 }}>
          {activeTasks.length === 0 && (
            <div className="hud-empty-state" style={{ fontSize: 10, padding: "4px 2px" }}>
              暂无任务
            </div>
          )}
          {displayTasks.map((task) => (
            <div
              key={task.id}
              className={`hud-task-card${task.priority === "critical" ? " hud-task-card--critical" : ""}`}
              style={{ borderLeftColor: STATUS_COLORS[task.status] ?? "var(--hud-text-dim)" }}
            >
              {/* Title + Commander */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{
                  color: "var(--hud-text-primary)",
                  fontWeight: task.priority === "critical" ? "bold" : "normal",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 140,
                }}>
                  {task.title}
                </span>
                <span style={{ color: "var(--hud-text-dim)", fontSize: 9 }}>
                  {CMD_LABELS[task.commander] ?? task.commander}
                </span>
              </div>

              {/* Status + Priority + Squads */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                <span style={{
                  color: STATUS_COLORS[task.status] ?? "var(--hud-text-secondary)",
                  fontSize: 10,
                  fontWeight: task.status === "failing" ? "bold" : "normal",
                }}>
                  {STATUS_LABELS[task.status] ?? task.status}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {task.assignedSquads.length > 0 && (
                    <span style={{ color: "var(--hud-text-dim)", fontSize: 9 }}>
                      {task.assignedSquads.join(",")}
                    </span>
                  )}
                  <button
                    onClick={() => {
                      const idx = PRIORITY_CYCLE.indexOf(task.priority);
                      const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
                      onChangePriority(task.id, next);
                    }}
                    className={`hud-badge hud-badge--${task.priority}`}
                    style={{
                      background: "none",
                      border: "none",
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
                  <span className="hud-badge hud-badge--critical" style={{ animation: "none" }}>
                    {task.constraint}
                  </span>
                </div>
              )}

              {/* Cancel button */}
              {task.status !== "completed" && task.status !== "cancelled" && (
                <div style={{ marginTop: 3, textAlign: "right" }}>
                  {confirmCancel === task.id ? (
                    <span style={{ fontSize: 9 }}>
                      <span style={{ color: "var(--hud-text-secondary)" }}>确认取消？</span>
                      <button
                        onClick={() => { onCancel(task.id); setConfirmCancel(null); }}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--hud-accent-red)",
                          cursor: "pointer",
                          fontSize: 9,
                          padding: "0 4px",
                          fontFamily: "var(--hud-font-mono)",
                        }}
                      >
                        是
                      </button>
                      <button
                        onClick={() => setConfirmCancel(null)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "var(--hud-text-dim)",
                          cursor: "pointer",
                          fontSize: 9,
                          padding: "0 4px",
                          fontFamily: "var(--hud-font-mono)",
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
                        color: "var(--hud-text-dim)",
                        cursor: "pointer",
                        fontSize: 9,
                        padding: 0,
                        fontFamily: "var(--hud-font-mono)",
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
