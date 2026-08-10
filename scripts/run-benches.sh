#!/bin/bash
# ============================================================
# AI Commander — 全家硬线一把跑
#
# 为什么入库：它原先活在会话的临时目录里，换个窗口就没了——而"换个窗口就没了的
# 断言不是回归网"（步 1→2 立的规矩，这里是同一条教训在**工装层**的复发）。
#
# 三条纪律（Fable 裁定 2026-08-09）：
#   ① 台架清单**显式枚举，不许 glob** —— glob 会把改了名的台架静默漏掉，
#      于是"全绿"是真的、"跑全了"是假的。
#   ② 清单里任何一个脚本文件不存在 ⇒ **整体 FAIL** —— 防"少跑了还全绿"。
#   ③ 末尾打印分项计数，与文件数对账。
#
# 用法（worktree 根）：
#   bash scripts/run-benches.sh                 # 跑一遍，全绿返回 0
#   bash scripts/run-benches.sh <日志目录>      # 顺带把每项的完整输出存下来
#
# 不含 `--live` / `--ab` / `--real` 等真模型模式：它们花配额、有网络波动，
# 不属于"改完代码必须全绿"的硬线，各刀自己按需手动跑。
# ============================================================
set -u
OUT="${1:-}"
[ -n "$OUT" ] && mkdir -p "$OUT"

# ── 台架清单：显式枚举。新增台架必须往这儿加一行，别指望 glob ──
#    格式：<标签> <脚本相对路径> [参数...]
CHECKS=(
  "typecheck                     |npm run typecheck"
  "approval-v4-synthetic         |npx tsx scripts/ab-approval-v4.ts --synthetic"
  "approval-v4-negctl            |npx tsx scripts/ab-approval-v4.ts --negctl"
  "battle-board                  |npx tsx scripts/ab-battle-board.ts --synthetic"
  "capture-stall                 |npx tsx scripts/ab-capture-stall.ts --synthetic"
  "command-preflight             |npx tsx scripts/ab-command-preflight.ts --synthetic"
  "commander-presence            |npx tsx scripts/ab-commander-presence.ts --synthetic"
  "dispatch-scope                |npx tsx scripts/ab-dispatch-scope.ts --synthetic"
  "emily-production              |npx tsx scripts/ab-emily-production.ts --synthetic"
  "front-escalation              |npx tsx scripts/ab-front-escalation.ts --synthetic"
  "g-knife-sites                 |npx tsx scripts/ab-g-knife.ts --sites"
  "g-knife-emily-guard           |npx tsx scripts/ab-g-knife.ts --emily-guard cb02c2b ${OUT:-/tmp}/emily-guard.md"
  "handtest-authority-synthetic  |npx tsx scripts/ab-handtest-authority.ts --synthetic"
  "handtest-authority-negctl     |npx tsx scripts/ab-handtest-authority.ts --negctl"
  "handtest-route-synthetic      |npx tsx scripts/ab-handtest-route.ts --synthetic"
  "handtest-route-negctl         |npx tsx scripts/ab-handtest-route.ts --negctl"
  "mapdata-audit                 |npx tsx scripts/ab-mapdata-audit.ts"
  "mapdata-audit-negctl          |npx tsx scripts/ab-mapdata-audit.ts --negctl"
  "pretest-polish                |npx tsx scripts/ab-pretest-polish.ts"
  "pretest-polish-negctl         |npx tsx scripts/ab-pretest-polish.ts --negctl"
  "retreat-semantics             |npx tsx scripts/ab-retreat-semantics.ts --synthetic"
  "voice-input                   |npx tsx scripts/ab-voice-input.ts --synthetic"
)

# ── 纪律②：清单点名的脚本必须都在 ──
MISSING=""
for row in "${CHECKS[@]}"; do
  script=$(echo "${row#*|}" | grep -oE 'scripts/[A-Za-z0-9_-]+\.ts' | head -1)
  [ -n "$script" ] && [ ! -f "$script" ] && MISSING="$MISSING $script"
done
if [ -n "$MISSING" ]; then
  echo "❌ 清单点名但不存在的脚本:$MISSING"
  echo "   （改名/删除台架必须同步改本清单——静默漏跑比红更危险）"
  exit 1
fi

# ── 纪律③：清单覆盖了几个 ab-* 文件？与磁盘上的实际数量对账 ──
LISTED=$(printf '%s\n' "${CHECKS[@]}" | grep -oE 'scripts/ab-[A-Za-z0-9_-]+\.ts' | sort -u | wc -l | tr -d ' ')
ONDISK=$(ls scripts/ab-*.ts 2>/dev/null | wc -l | tr -d ' ')
if [ "$LISTED" != "$ONDISK" ]; then
  echo "❌ 清单覆盖 $LISTED 个 ab-* 台架，磁盘上有 $ONDISK 个——有台架没被跑到"
  printf '%s\n' "${CHECKS[@]}" | grep -oE 'scripts/ab-[A-Za-z0-9_-]+\.ts' | sort -u > /tmp/_listed.txt
  ls scripts/ab-*.ts | sort > /tmp/_ondisk.txt
  echo "   差集："; comm -13 /tmp/_listed.txt /tmp/_ondisk.txt | sed 's/^/     /'
  rm -f /tmp/_listed.txt /tmp/_ondisk.txt
  exit 1
fi

FAILED=""
PASSED=0
for row in "${CHECKS[@]}"; do
  label="${row%%|*}"; label="${label%"${label##*[![:space:]]}"}"
  cmd="${row#*|}"
  if [ -n "$OUT" ]; then log="$OUT/$label.log"; else log=$(mktemp); fi
  if eval "$cmd" > "$log" 2>&1; then
    printf "%-32s ✅  %s\n" "$label" "$(tail -1 "$log" | cut -c1-64)"
    PASSED=$((PASSED + 1))
  else
    printf "%-32s ❌  %s\n" "$label" "$(tail -1 "$log" | cut -c1-64)"
    FAILED="$FAILED $label"
  fi
  [ -z "$OUT" ] && rm -f "$log"
done

echo
echo "口径对账：${ONDISK} 个 ab-* 台架（含 ab-voice-input）+ typecheck，各模式合计 ${#CHECKS[@]} 项检查"
echo "结果：${PASSED}/${#CHECKS[@]} 通过"
if [ -n "$FAILED" ]; then
  echo "❌ 未过:$FAILED"
  exit 1
fi
echo "✅ 全家硬线全绿"
