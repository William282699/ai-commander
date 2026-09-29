#!/bin/bash
# 试玩记录仪的全部本机台架一把跑（不含 Docker 那一个：scripts/probe-recorder-docker.sh 需另找装了 Docker 的机器）。
# 用法（worktree 根）：bash scripts/run-recorder-probes.sh [证据目录]
set -u
OUT="${1:-}"
[ -n "$OUT" ] && mkdir -p "$OUT"
PROBES=(
  "probe-recorder-store       |node --import tsx scripts/probe-recorder-store.ts"
  "probe-recorder-client      |node --import tsx scripts/probe-recorder-client.ts"
  "probe-recorder-chain       |node --import tsx scripts/probe-recorder-chain.ts"
  "probe-recorder-privacy     |node --import tsx scripts/probe-recorder-privacy.ts"
  "probe-recorder-arms        |node --import tsx scripts/probe-recorder-arms.ts ${OUT:+--evidence=$OUT/arms}"
  "probe-recorder-shutdown    |node --import tsx scripts/probe-recorder-shutdown.ts"
)
FAILED=""
for row in "${PROBES[@]}"; do
  label="${row%%|*}"; label="${label%"${label##*[![:space:]]}"}"; cmd="${row#*|}"
  if [ -n "$OUT" ]; then log="$OUT/$label.log"; else log=$(mktemp); fi
  if eval "$cmd" > "$log" 2>&1; then printf "%-28s ✅  %s\n" "$label" "$(tail -1 "$log" | cut -c1-80)"
  else printf "%-28s ❌  %s\n" "$label" "$(tail -1 "$log" | cut -c1-80)"; FAILED="$FAILED $label"; fi
  [ -z "$OUT" ] && rm -f "$log"
done
[ -z "$FAILED" ] && echo "✅ 记录仪台架全绿" || { echo "❌ 未过:$FAILED"; exit 1; }
