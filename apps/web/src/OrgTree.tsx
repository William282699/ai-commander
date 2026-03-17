// ============================================================
// AI Commander — OrgTree (Phase 2)
// Tree view of squad hierarchy with drag & drop.
// ============================================================

import React, { useState, useCallback, useRef, useEffect } from "react";
import type { Squad, Unit, CommanderKey } from "@ai-commander/shared";
import { collectUnitsUnder, getChildren, getSquadDepth, isDescendantOrSelf, getMaxSubtreeDepth } from "@ai-commander/shared";
import type { GameState } from "@ai-commander/shared";

// ── Props ──

export interface OrgTreeProps {
  squads: Squad[];
  units: Map<number, Unit>;
  state: GameState;
  onSelectUnits: (unitIds: number[]) => void;
  onMoveSquad: (squadId: string, newParentId: string) => void;
  onRemoveFromParent: (squadId: string) => void;
  onRenameLeader: (squadId: string, newName: string) => void;
}

// ── Root commander config ──

const ROOT_COMMANDERS: { key: CommanderKey; label: string; avatar: string }[] = [
  { key: "chen", label: "Chen", avatar: "⚔️" },
  { key: "marcus", label: "Marcus", avatar: "🎖️" },
  { key: "emily", label: "Emily", avatar: "📦" },
];

// ── Status colors ──

function getStatusColor(squad: Squad, units: Map<number, Unit>): string {
  const unitIds = squad.unitIds;
  if (unitIds.length === 0) return "#64748b"; // grey for commander
  let hasAttacking = false;
  let hasMoving = false;
  for (const id of unitIds) {
    const u = units.get(id);
    if (!u || u.state === "dead") continue;
    if (u.state === "attacking" || u.state === "defending") hasAttacking = true;
    if (u.state === "moving" || u.state === "patrolling") hasMoving = true;
  }
  if (hasAttacking) return "#ef4444"; // red
  if (hasMoving) return "#eab308"; // yellow
  return "#22c55e"; // green - idle
}

function getUnitTypeIcon(squad: Squad, units: Map<number, Unit>): string {
  const counts = new Map<string, number>();
  for (const id of squad.unitIds) {
    const u = units.get(id);
    if (!u || u.state === "dead") continue;
    counts.set(u.type, (counts.get(u.type) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) { best = type; bestCount = count; }
  }
  const icons: Record<string, string> = {
    infantry: "🚶", main_tank: "🛡️", light_tank: "🚗", artillery: "💥",
    patrol_boat: "🚢", destroyer: "⚓", cruiser: "🔱", carrier: "✈️",
    fighter: "✈️", bomber: "💣", recon_plane: "🔭",
  };
  return icons[best] || "👥";
}

function getAliveCount(unitIds: number[], units: Map<number, Unit>): number {
  return unitIds.filter((id) => {
    const u = units.get(id);
    return u && u.state !== "dead";
  }).length;
}

// ── Component ──

export function OrgTree({ squads, units, state, onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader }: OrgTreeProps) {
  const [dragSquadId, setDragSquadId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  return (
    <div style={treeContainerStyle}>
      {ROOT_COMMANDERS.map((cmd) => {
        const cmdSquads = squads.filter((s) => s.ownerCommander === cmd.key && !s.parentSquadId);
        return (
          <div key={cmd.key} style={rootNodeStyle}>
            <div style={rootLabelStyle}>
              <span>{cmd.avatar}</span>
              <span style={{ fontWeight: "bold" }}>{cmd.label}</span>
              <span style={{ color: "#64748b", fontSize: 10 }}>
                ({squads.filter((s) => s.ownerCommander === cmd.key).length} squads)
              </span>
            </div>
            <div
              style={childrenContainerStyle}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Drop on root = removeFromParent
                if (dragSquadId) {
                  const sq = squads.find((s) => s.id === dragSquadId);
                  if (sq?.parentSquadId && sq.ownerCommander === cmd.key) {
                    onRemoveFromParent(dragSquadId);
                  }
                }
                setDragSquadId(null);
                setDropTargetId(null);
              }}
            >
              {cmdSquads.length === 0 && (
                <div style={{ color: "#475569", fontSize: 10, padding: "4px 0 4px 16px" }}>
                  (empty)
                </div>
              )}
              {cmdSquads.map((sq) => (
                <SquadNode
                  key={sq.id}
                  squad={sq}
                  squads={squads}
                  units={units}
                  state={state}
                  depth={1}
                  dragSquadId={dragSquadId}
                  dropTargetId={dropTargetId}
                  onDragStart={setDragSquadId}
                  onDragEnd={() => { setDragSquadId(null); setDropTargetId(null); }}
                  onDropTarget={setDropTargetId}
                  onSelectUnits={onSelectUnits}
                  onMoveSquad={onMoveSquad}
                  onRemoveFromParent={onRemoveFromParent}
                  onRenameLeader={onRenameLeader}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── SquadNode (recursive) ──

interface SquadNodeProps {
  squad: Squad;
  squads: Squad[];
  units: Map<number, Unit>;
  state: GameState;
  depth: number;
  dragSquadId: string | null;
  dropTargetId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropTarget: (id: string | null) => void;
  onSelectUnits: (unitIds: number[]) => void;
  onMoveSquad: (squadId: string, newParentId: string) => void;
  onRemoveFromParent: (squadId: string) => void;
  onRenameLeader: (squadId: string, newName: string) => void;
}

function SquadNode({
  squad, squads, units, state, depth,
  dragSquadId, dropTargetId,
  onDragStart, onDragEnd, onDropTarget,
  onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader,
}: SquadNodeProps) {
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLSpanElement>(null);
  const children = squads.filter((s) => s.parentSquadId === squad.id);

  const totalUnits = squad.role === "commander"
    ? collectUnitsUnder(state, squad.id).length
    : getAliveCount(squad.unitIds, units);

  const statusColor = getStatusColor(squad, units);
  const icon = squad.role === "commander" ? "📋" : getUnitTypeIcon(squad, units);
  const isDropTarget = dropTargetId === squad.id;
  const isDragging = dragSquadId === squad.id;

  // Whether drop would trigger auto-promotion of target leader→commander
  const willPromote = (() => {
    if (!dragSquadId || dragSquadId === squad.id) return false;
    const draggedSquad = squads.find((s) => s.id === dragSquadId);
    if (!draggedSquad) return false;
    if (draggedSquad.role !== "leader") return false;
    if (squad.role !== "leader") return false;
    if (draggedSquad.ownerCommander !== squad.ownerCommander) return false;
    if (isDescendantOrSelf(state, dragSquadId, squad.id)) return false;
    // After promotion, target stays at same depth; new child + moved squad at depth+1
    const targetDepth = getSquadDepth(state, squad.id);
    if (targetDepth + 1 > 3) return false;
    return true;
  })();

  const canDrop = (() => {
    if (!dragSquadId || dragSquadId === squad.id) return false;
    const draggedSquad = squads.find((s) => s.id === dragSquadId);
    if (!draggedSquad) return false;
    // Source must be leader
    if (draggedSquad.role !== "leader") return false;
    // Target can be commander OR leader (leader will auto-promote)
    if (squad.role !== "commander" && squad.role !== "leader") return false;
    // Same ownerCommander
    if (draggedSquad.ownerCommander !== squad.ownerCommander) return false;
    // Prevent cycle: can't drop under own descendant
    if (isDescendantOrSelf(state, dragSquadId, squad.id)) return false;
    // Depth check
    const targetDepth = getSquadDepth(state, squad.id);
    if (squad.role === "leader") {
      // After promotion: target depth stays same, child at depth+1
      if (targetDepth + 1 > 3) return false;
    } else {
      const draggedSubtreeDepth = getMaxSubtreeDepth(state, dragSquadId);
      if (targetDepth + draggedSubtreeDepth > 3) return false;
    }
    return true;
  })();

  // Tooltip: units / morale / mission
  const tooltip = (() => {
    const lines: string[] = [`${squad.leaderName} (${squad.id})`];
    lines.push(`Role: ${squad.role}`);
    lines.push(`Units: ${totalUnits}`);
    lines.push(`Morale: ${squad.morale.toFixed(1)}`);
    lines.push(`Mission: ${squad.currentMission || "idle"}`);
    if (squad.parentSquadId) lines.push(`Parent: ${squad.parentSquadId}`);
    if (children.length > 0) lines.push(`Children: ${children.map((c) => c.id).join(", ")}`);
    return lines.join("\n");
  })();

  // Flash animation on role change (promotion/demotion)
  const [flash, setFlash] = useState(false);
  const prevRoleRef = useRef(squad.role);
  useEffect(() => {
    if (prevRoleRef.current !== squad.role) {
      prevRoleRef.current = squad.role;
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 400);
      return () => clearTimeout(timer);
    }
  }, [squad.role]);

  const handleClick = useCallback(() => {
    const allIds = collectUnitsUnder(state, squad.id);
    onSelectUnits(allIds);
  }, [state, squad.id, onSelectUnits]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (squad.parentSquadId) {
      onRemoveFromParent(squad.id);
    }
  }, [squad.id, squad.parentSquadId, onRemoveFromParent]);

  const handleDoubleClick = useCallback(() => {
    setEditing(true);
    setTimeout(() => {
      if (editRef.current) {
        editRef.current.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(editRef.current);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }, 0);
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const newName = editRef.current?.textContent?.trim();
      if (newName && newName !== squad.leaderName) {
        onRenameLeader(squad.id, newName);
      }
      setEditing(false);
    }
    if (e.key === "Escape") {
      setEditing(false);
      if (editRef.current) editRef.current.textContent = squad.leaderName;
    }
  }, [squad.id, squad.leaderName, onRenameLeader]);

  const handleEditBlur = useCallback(() => {
    const newName = editRef.current?.textContent?.trim();
    if (newName && newName !== squad.leaderName) {
      onRenameLeader(squad.id, newName);
    }
    setEditing(false);
  }, [squad.id, squad.leaderName, onRenameLeader]);

  return (
    <div style={{ marginLeft: depth > 1 ? 12 : 0 }}>
      <div
        draggable
        title={tooltip}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData("text/plain", squad.id);
          onDragStart(squad.id);
        }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => {
          if (canDrop) {
            e.preventDefault();
            e.stopPropagation();
            onDropTarget(squad.id);
          }
        }}
        onDragLeave={() => {
          if (dropTargetId === squad.id) onDropTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dragSquadId && canDrop) {
            onMoveSquad(dragSquadId, squad.id);
          }
          onDragEnd();
        }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        style={{
          ...nodeStyle,
          opacity: isDragging ? 0.4 : 1,
          borderColor: isDropTarget
            ? (willPromote ? "#8b5cf6" : "#3b82f6")
            : flash
              ? "#fbbf24"
              : statusColor,
          background: isDropTarget
            ? (willPromote ? "rgba(139, 92, 246, 0.15)" : "rgba(59, 130, 246, 0.15)")
            : flash
              ? "rgba(251, 191, 36, 0.2)"
              : "rgba(15, 23, 42, 0.6)",
          boxShadow: flash ? "0 0 8px rgba(251, 191, 36, 0.5)" : "none",
        }}
      >
        <span style={{ fontSize: 12 }}>{icon}</span>
        <span
          ref={editRef}
          contentEditable={editing}
          suppressContentEditableWarning
          onKeyDown={editing ? handleEditKeyDown : undefined}
          onBlur={editing ? handleEditBlur : undefined}
          style={{
            fontWeight: "bold",
            color: editing ? "#fbbf24" : "#e2e8f0",
            fontSize: 11,
            outline: editing ? "1px solid #fbbf24" : "none",
            padding: editing ? "0 2px" : 0,
            borderRadius: 2,
            minWidth: 20,
          }}
        >
          {squad.leaderName}
        </span>
        <span style={{ color: "#64748b", fontSize: 10 }}>{squad.id}</span>
        <span style={{ color: statusColor, fontSize: 10, fontWeight: "bold" }}>
          {totalUnits}
        </span>
        {squad.role === "commander" && (
          <span style={{ color: "#8b5cf6", fontSize: 9 }}>CMD</span>
        )}
        {isDropTarget && willPromote && (
          <span style={{ color: "#fbbf24", fontSize: 9, fontWeight: "bold" }}>⬆CMD</span>
        )}
      </div>
      {children.length > 0 && (
        <div style={childrenContainerStyle}>
          {children.map((child) => (
            <SquadNode
              key={child.id}
              squad={child}
              squads={squads}
              units={units}
              state={state}
              depth={depth + 1}
              dragSquadId={dragSquadId}
              dropTargetId={dropTargetId}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDropTarget={onDropTarget}
              onSelectUnits={onSelectUnits}
              onMoveSquad={onMoveSquad}
              onRemoveFromParent={onRemoveFromParent}
              onRenameLeader={onRenameLeader}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ──

const treeContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "8px 6px",
};

const rootNodeStyle: React.CSSProperties = {
  marginBottom: 8,
};

const rootLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 6px",
  fontSize: 12,
  color: "#e2e8f0",
  borderBottom: "1px solid #1e293b",
  marginBottom: 4,
};

const childrenContainerStyle: React.CSSProperties = {
  paddingLeft: 8,
};

const nodeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 8px",
  marginBottom: 2,
  borderRadius: 4,
  border: "1px solid",
  cursor: "pointer",
  userSelect: "none",
  transition: "background 0.15s, border-color 0.15s",
};
