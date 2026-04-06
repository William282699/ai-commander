// ============================================================
// AI Commander — OrgTree (Phase 2)
// Three-column top-down tree: Chen | Marcus | Emily side by side.
// Each column auto-scales when nodes overflow.
// Drag & drop between columns to transfer squads.
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
  onTransferSquad: (squadId: string, newOwner: CommanderKey) => void;
}

// ── Root commander config ──

const ROOT_COMMANDERS: { key: CommanderKey; label: string; avatar: string }[] = [
  { key: "chen", label: "Chen", avatar: "⚔️" },
  { key: "marcus", label: "Marcus", avatar: "🎖️" },
  { key: "emily", label: "Emily", avatar: "📦" },
];

// ── Helpers ──

function getStatusColor(squad: Squad, units: Map<number, Unit>): string {
  const unitIds = squad.unitIds;
  if (unitIds.length === 0) return "#64748b";
  let hasAttacking = false;
  let hasMoving = false;
  for (const id of unitIds) {
    const u = units.get(id);
    if (!u || u.state === "dead") continue;
    if (u.state === "attacking" || u.state === "defending") hasAttacking = true;
    if (u.state === "moving" || u.state === "patrolling") hasMoving = true;
  }
  if (hasAttacking) return "#ef4444";
  if (hasMoving) return "#eab308";
  return "#22c55e";
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

/** Check if a squad (and all sub-squads for commanders) has zero alive units */
function isSquadWiped(squad: Squad, squads: Squad[], units: Map<number, Unit>): boolean {
  if (squad.unitIds.length > 0 && getAliveCount(squad.unitIds, units) > 0) return false;
  // For commanders, check children recursively
  const children = squads.filter(s => s.parentSquadId === squad.id);
  for (const child of children) {
    if (!isSquadWiped(child, squads, units)) return false;
  }
  // A squad with no unitIds and no children isn't "wiped" — it's empty
  return squad.unitIds.length > 0 || children.length > 0;
}

// ── Constants ──

const LINE_COLOR = "rgba(0, 212, 255, 0.15)";
const VERT_GAP = 20;

// ── Component ──

export function OrgTree({ squads, units, state, onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader, onTransferSquad }: OrgTreeProps) {
  const [dragSquadId, setDragSquadId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  return (
    <div style={treeContainerStyle}>
      {/* Three columns side by side */}
      <div style={columnsRowStyle}>
        {ROOT_COMMANDERS.map((cmd) => {
          const cmdSquads = squads.filter((s) => s.ownerCommander === cmd.key);
          const allRootSquads = cmdSquads.filter(s => !s.parentSquadId);
          const rootSquads = allRootSquads.filter(s => !isSquadWiped(s, squads, units));
          const fallenSquads = allRootSquads.filter(s => isSquadWiped(s, squads, units));
          const aliveCount = cmdSquads.filter(s => !isSquadWiped(s, squads, units)).length;

          return (
            <div
              key={cmd.key}
              style={columnStyle}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragSquadId) {
                  const sq = squads.find((s) => s.id === dragSquadId);
                  if (sq) {
                    if (sq.ownerCommander !== cmd.key) {
                      // Cross-commander transfer
                      onTransferSquad(dragSquadId, cmd.key);
                    } else if (sq.parentSquadId) {
                      // Same commander, detach from parent
                      onRemoveFromParent(dragSquadId);
                    }
                  }
                }
                setDragSquadId(null);
                setDropTargetId(null);
              }}
            >
              {/* Commander header */}
              <div style={columnHeaderStyle}>
                <span style={{ fontSize: 14 }}>{cmd.avatar}</span>
                <span style={{ fontWeight: "bold", fontSize: 11 }}>{cmd.label}</span>
                <span style={{ color: "var(--hud-text-dim)", fontSize: 9 }}>({aliveCount})</span>
              </div>

              {/* Divider line */}
              <div style={{ height: 1, background: "var(--hud-border-dim)", margin: "2px 0" }} />

              {/* Tree content — auto-scaled to fit column */}
              <AutoScaleColumn>
                {rootSquads.length === 0 ? (
                  <div style={{ color: "var(--hud-text-dim)", fontSize: 10, padding: "8px 0" }}>(empty)</div>
                ) : (
                  <>
                    <div style={{ width: 1, height: VERT_GAP / 2, background: LINE_COLOR }} />
                    {rootSquads.length === 1 ? (
                      <TreeNode
                        squad={rootSquads[0]}
                        squads={squads}
                        units={units}
                        state={state}
                        dragSquadId={dragSquadId}
                        dropTargetId={dropTargetId}
                        onDragStart={setDragSquadId}
                        onDragEnd={() => { setDragSquadId(null); setDropTargetId(null); }}
                        onDropTarget={setDropTargetId}
                        onSelectUnits={onSelectUnits}
                        onMoveSquad={onMoveSquad}
                        onRemoveFromParent={onRemoveFromParent}
                        onRenameLeader={onRenameLeader} onTransferSquad={onTransferSquad}
                      />
                    ) : (
                      <>
                        <HorizontalBar count={rootSquads.length} />
                        <div style={childrenRowStyle}>
                          {rootSquads.map(sq => (
                            <div key={sq.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 0 }}>
                              <div style={{ width: 1, height: VERT_GAP / 2, background: LINE_COLOR }} />
                              <TreeNode
                                squad={sq}
                                squads={squads}
                                units={units}
                                state={state}
                                dragSquadId={dragSquadId}
                                dropTargetId={dropTargetId}
                                onDragStart={setDragSquadId}
                                onDragEnd={() => { setDragSquadId(null); setDropTargetId(null); }}
                                onDropTarget={setDropTargetId}
                                onSelectUnits={onSelectUnits}
                                onMoveSquad={onMoveSquad}
                                onRemoveFromParent={onRemoveFromParent}
                                onRenameLeader={onRenameLeader} onTransferSquad={onTransferSquad}
                              />
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
              </AutoScaleColumn>

            </div>
          );
        })}
      </div>

      {/* ── Fallen squads — global section at bottom ── */}
      {(() => {
        const allFallen = squads.filter(s => !s.parentSquadId && isSquadWiped(s, squads, units));
        if (allFallen.length === 0) return null;
        return (
          <div className="hud-org-kia">
            <div className="hud-org-kia__header" style={{ marginBottom: 4 }}>
              ✝ K.I.A. ({allFallen.length})
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {allFallen.map(sq => (
                <span key={sq.id} style={{ fontSize: 10, color: "var(--hud-accent-red)" }}>
                  {sq.leaderName} ({sq.id})
                </span>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── TreeNode ──

interface TreeNodeProps {
  squad: Squad;
  squads: Squad[];
  units: Map<number, Unit>;
  state: GameState;
  dragSquadId: string | null;
  dropTargetId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDropTarget: (id: string | null) => void;
  onSelectUnits: (unitIds: number[]) => void;
  onMoveSquad: (squadId: string, newParentId: string) => void;
  onRemoveFromParent: (squadId: string) => void;
  onRenameLeader: (squadId: string, newName: string) => void;
  onTransferSquad: (squadId: string, newOwner: CommanderKey) => void;
}

function TreeNode({
  squad, squads, units, state,
  dragSquadId, dropTargetId,
  onDragStart, onDragEnd, onDropTarget,
  onSelectUnits, onMoveSquad, onRemoveFromParent, onRenameLeader, onTransferSquad,
}: TreeNodeProps) {
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

  const isCrossCommander = (() => {
    if (!dragSquadId) return false;
    const draggedSquad = squads.find((s) => s.id === dragSquadId);
    return draggedSquad ? draggedSquad.ownerCommander !== squad.ownerCommander : false;
  })();

  const willPromote = (() => {
    if (!dragSquadId || dragSquadId === squad.id) return false;
    const draggedSquad = squads.find((s) => s.id === dragSquadId);
    if (!draggedSquad) return false;
    if (draggedSquad.role !== "leader") return false;
    if (squad.role !== "leader") return false;
    if (isDescendantOrSelf(state, dragSquadId, squad.id)) return false;
    const targetDepth = getSquadDepth(state, squad.id);
    if (targetDepth + 1 > 3) return false;
    return true;
  })();

  const canDrop = (() => {
    if (!dragSquadId || dragSquadId === squad.id) return false;
    const draggedSquad = squads.find((s) => s.id === dragSquadId);
    if (!draggedSquad) return false;
    if (draggedSquad.role !== "leader") return false;
    if (squad.role !== "commander" && squad.role !== "leader") return false;
    if (isDescendantOrSelf(state, dragSquadId, squad.id)) return false;
    const targetDepth = getSquadDepth(state, squad.id);
    if (squad.role === "leader") {
      if (targetDepth + 1 > 3) return false;
    } else {
      const draggedSubtreeDepth = getMaxSubtreeDepth(state, dragSquadId);
      if (targetDepth + draggedSubtreeDepth > 3) return false;
    }
    return true;
  })();

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
    <div style={treeNodeContainerStyle}>
      {/* Node box */}
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
            if (isCrossCommander) {
              // First transfer to this commander, then move under this squad
              onTransferSquad(dragSquadId, squad.ownerCommander);
              // After transfer, ownerCommander matches, so moveSquadUnder will work
              setTimeout(() => onMoveSquad(dragSquadId, squad.id), 0);
            } else {
              onMoveSquad(dragSquadId, squad.id);
            }
          }
          onDragEnd();
        }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
        style={{
          ...nodeBoxStyle,
          opacity: isDragging ? 0.4 : 1,
          borderColor: isDropTarget
            ? (willPromote ? "#8b5cf6" : "#3b82f6")
            : flash ? "#fbbf24" : statusColor,
          background: isDropTarget
            ? (willPromote ? "rgba(139, 92, 246, 0.15)" : "rgba(59, 130, 246, 0.15)")
            : flash ? "rgba(251, 191, 36, 0.2)" : undefined,
          boxShadow: flash ? "0 0 8px rgba(251, 191, 36, 0.5)" : "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 2, justifyContent: "center" }}>
          <span style={{ fontSize: 10 }}>{icon}</span>
          <span
            ref={editRef}
            contentEditable={editing}
            suppressContentEditableWarning
            onKeyDown={editing ? handleEditKeyDown : undefined}
            onBlur={editing ? handleEditBlur : undefined}
            style={{
              fontWeight: "bold",
              color: editing ? "#fbbf24" : "var(--hud-text-primary)",
              fontSize: 10,
              outline: editing ? "1px solid #fbbf24" : "none",
              padding: editing ? "0 2px" : 0,
              borderRadius: 2,
              minWidth: 14,
            }}
          >
            {squad.leaderName}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 2, justifyContent: "center", fontSize: 8 }}>
          <span style={{ color: "var(--hud-text-dim)" }}>{squad.id}</span>
          <span style={{ color: statusColor, fontWeight: "bold" }}>{totalUnits}</span>
          {squad.role === "commander" && <span style={{ color: "#8b5cf6", fontWeight: "bold" }}>CMD</span>}
          {isDropTarget && willPromote && <span style={{ color: "#fbbf24", fontWeight: "bold" }}>⬆</span>}
        </div>
      </div>

      {/* Children below */}
      {children.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
          <div style={{ width: 1, height: VERT_GAP / 2, background: LINE_COLOR }} />

          {children.length === 1 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
              <div style={{ width: 1, height: VERT_GAP / 2, background: LINE_COLOR }} />
              <TreeNode
                squad={children[0]} squads={squads} units={units} state={state}
                dragSquadId={dragSquadId} dropTargetId={dropTargetId}
                onDragStart={onDragStart} onDragEnd={onDragEnd} onDropTarget={onDropTarget}
                onSelectUnits={onSelectUnits} onMoveSquad={onMoveSquad}
                onRemoveFromParent={onRemoveFromParent} onRenameLeader={onRenameLeader} onTransferSquad={onTransferSquad}
              />
            </div>
          ) : (
            <div style={{ width: "100%" }}>
              <HorizontalBar count={children.length} />
              <div style={childrenRowStyle}>
                {children.map(child => (
                  <div key={child.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, minWidth: 0 }}>
                    <div style={{ width: 1, height: VERT_GAP / 2, background: LINE_COLOR }} />
                    <TreeNode
                      squad={child} squads={squads} units={units} state={state}
                      dragSquadId={dragSquadId} dropTargetId={dropTargetId}
                      onDragStart={onDragStart} onDragEnd={onDragEnd} onDropTarget={onDropTarget}
                      onSelectUnits={onSelectUnits} onMoveSquad={onMoveSquad}
                      onRemoveFromParent={onRemoveFromParent} onRenameLeader={onRenameLeader} onTransferSquad={onTransferSquad}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── AutoScaleColumn: renders at full size first, measures, then scales to fit ──

function AutoScaleColumn({ children }: { children: React.ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const update = () => {
      // Temporarily reset scale to measure natural size
      inner.style.transform = "none";
      const outerW = outer.clientWidth;
      const innerW = inner.scrollWidth;
      const newScale = (innerW > outerW && outerW > 0)
        ? Math.max(0.3, outerW / innerW)
        : 1;
      inner.style.transform = newScale < 1 ? `scale(${newScale})` : "none";
      setScale(newScale);
    };

    // Use RAF to measure after render
    const raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  });

  return (
    <div ref={outerRef} style={{
      flex: 1,
      overflow: "hidden",
      width: "100%",
    }}>
      <div
        ref={innerRef}
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          transformOrigin: "top left",
          width: "max-content",
          minWidth: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── HorizontalBar ──

function HorizontalBar({ count }: { count: number }) {
  const halfChild = 100 / (2 * count);
  return (
    <div style={{ position: "relative", width: "100%", height: 1 }}>
      <div style={{
        position: "absolute",
        left: `${halfChild}%`,
        right: `${halfChild}%`,
        height: 1,
        background: LINE_COLOR,
      }} />
    </div>
  );
}

// ── Styles ──

const treeContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: "4px 2px",
  fontFamily: "var(--hud-font-mono)",
};

const columnsRowStyle: React.CSSProperties = {
  display: "flex",
  width: "100%",
  height: "100%",
  gap: 0,
};

const columnStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  borderRight: "1px solid var(--hud-border-dim)",
  padding: "4px 2px",
  overflow: "hidden",
};

const columnHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--hud-text-primary)",
  background: "var(--hud-bg-tertiary)",
  border: "1px solid var(--hud-border-dim)",
  whiteSpace: "nowrap",
  fontFamily: "var(--hud-font-display)",
  fontWeight: 600,
};

const childrenRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  width: "100%",
};

const treeNodeContainerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  flex: 1,
  minWidth: 0,
};

const nodeBoxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  padding: "3px 6px",
  border: "1px solid",
  cursor: "pointer",
  userSelect: "none",
  transition: "background 0.15s, border-color 0.15s, box-shadow 0.15s",
  minWidth: 48,
  maxWidth: 80,
  whiteSpace: "nowrap",
  background: "var(--hud-bg-secondary)",
  fontFamily: "var(--hud-font-mono)",
};
