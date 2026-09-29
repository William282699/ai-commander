#!/bin/bash
# ============================================================
# 试玩记录仪 T15：Docker 生产镜像 ＋ 挂载目录 ＋ 两种停机信号 ＋ 换容器后再下载。
#
# 需要一台装了 Docker 的机器（本任务的开发机上没有 Docker，这个脚本**没有在这里跑过**）。
# 不连任何真模型（密钥置空）、不碰线上 Fly、不推任何镜像。用法（worktree 根）：
#   bash scripts/probe-recorder-docker.sh <证据目录>
# 判定（任何一条不满足就 FAIL，退出码 1）：
#   ① docker stop -t 5（SIGTERM）与 docker kill --signal=SIGINT 两种各一次：容器 5 秒内自己退出
#      （不是被 SIGKILL：退出码不是 137），日志里有 “[shutdown] … drain done … leftover=0”；
#   ② 停机前已应答的每个命令请求，其服务端事实都在挂载目录里，并有服务端生产者的“最后序号”；
#   ③ 删掉容器、用同一挂载目录起新容器，同一局的 ZIP 还能下载，且包内 manifest 的各文件 sha256 自洽。
# ★已知风险（本机进程链实测，见 scripts/probe-recorder-shutdown.ts）：现在的 CMD 是
#   `npm run start --workspace=apps/server`，npm 收到信号约 3 ms 就先退出，而服务端排空要 ~40 ms。
#   容器里 npm 是 PID 1，它一退出整个容器即被收掉——①② 很可能 FAIL。修法落在 Dockerfile 的 CMD
#   （例如直接 `node --import tsx apps/server/src/index.ts`），属部署文件，须用户另批，本脚本不改它。
# ============================================================
set -u
OUT="${1:?usage: probe-recorder-docker.sh <evidence dir>}"
mkdir -p "$OUT"
IMG="aic-recorder-probe:local"
DATA="$(mktemp -d)"
ADMIN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
PORT=18091
FAIL=0
say() { echo "$*" | tee -a "$OUT/summary.txt"; }

docker build -t "$IMG" . > "$OUT/build.log" 2>&1 || { say "FAIL docker build"; exit 1; }

run_container() {
  docker run -d --name "$1" -p "$PORT:8080" -v "$DATA:/data/recorder" \
    -e RECORDER_COLLECT=on -e RECORDER_DATA_DIR=/data/recorder -e RECORDER_ADMIN_TOKEN="$ADMIN" -e RECORDER_BUILD=docker-probe \
    -e GEMINI_API_KEY= -e DEEPSEEK_API_KEY= "$IMG" > /dev/null
  for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && return 0; sleep 1; done
  say "FAIL container $1 did not become healthy"; docker logs "$1" > "$OUT/$1.log" 2>&1; return 1
}

traffic() { # $1=runId → 打 40 个命令请求（全部拿到应答），打印应答数
  local tok; tok=$(curl -s -X POST -H "Authorization: Bearer $ADMIN" "http://127.0.0.1:$PORT/api/rec/admin/invites" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
  curl -s -X POST -H 'Content-Type: application/json' -H "X-Rec-Invite: $tok" "http://127.0.0.1:$PORT/api/rec/events" \
    -d "{\"v\":1,\"run\":\"$1\",\"events\":[{\"v\":1,\"eid\":\"cDockerProbe01:1\",\"pid\":\"cDockerProbe01\",\"seq\":1,\"run\":\"$1\",\"src\":\"client\",\"type\":\"run_start\",\"ct\":1,\"d\":{\"scenario\":\"el_alamein\"}}]}" > /dev/null
  local n=0
  for i in $(seq 1 40); do
    curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -H "X-Rec-Invite: $tok" -H "X-Rec-Run: $1" \
      "http://127.0.0.1:$PORT/api/command" -d "{\"digest\":\"DIGEST\",\"message\":\"m$i\",\"channel\":\"combat\",\"traceId\":\"t-docker-$i\"}" &
  done
  wait
  echo 40
}

check_disk() { # $1=runId $2=expected
  node -e '
    const fs=require("fs"); const f=process.argv[1]+"/runs/"+process.argv[2]+".jsonl";
    const l=fs.readFileSync(f,"utf8").trim().split("\n").map(JSON.parse);
    const req=l.filter(x=>x.type==="srv_request").length, close=l.filter(x=>x.type==="srv_producer_close").length;
    console.log(`requests=${req}/${process.argv[3]} producer_close=${close}`);
    process.exit(req===Number(process.argv[3]) && close>=1 ? 0 : 1);' "$DATA" "$1" "$2"
}

for MODE in SIGTERM SIGINT; do
  NAME="aic-rec-$MODE"
  run_container "$NAME" || { FAIL=1; continue; }
  RUN="rDocker${MODE}$(node -e 'console.log(require("crypto").randomBytes(4).toString("hex"))')"
  N=$(traffic "$RUN")
  T0=$(node -e 'console.log(Date.now())')
  if [ "$MODE" = SIGTERM ]; then docker stop -t 5 "$NAME" > /dev/null; else docker kill --signal=SIGINT "$NAME" > /dev/null; for i in $(seq 1 50); do [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break; sleep 0.1; done; fi
  T1=$(node -e 'console.log(Date.now())')
  CODE=$(docker inspect -f '{{.State.ExitCode}}' "$NAME"); RUNNING=$(docker inspect -f '{{.State.Running}}' "$NAME")
  docker logs "$NAME" > "$OUT/$NAME.log" 2>&1
  MS=$((T1-T0))
  say "$MODE: stopped in ${MS}ms exit=$CODE running=$RUNNING drain: $(grep -o '\[shutdown\] recorder drain.*' "$OUT/$NAME.log" | head -1)"
  if [ "$RUNNING" = true ] || [ "$CODE" = 137 ] || [ "$MS" -gt 5000 ]; then say "FAIL $MODE: not a self-exit within 5s"; FAIL=1; fi
  grep -q 'recorder drain done .*leftover=0' "$OUT/$NAME.log" || { say "FAIL $MODE: no completed drain in logs"; FAIL=1; }
  if ! check_disk "$RUN" "$N" | tee -a "$OUT/summary.txt"; then say "FAIL $MODE: server facts not all on disk / no producer close"; FAIL=1; fi
  docker rm "$NAME" > /dev/null
  LAST_RUN="$RUN"
done

# ③ 换容器：同一挂载目录起新容器，再下载同一局
NAME="aic-rec-replaced"
if run_container "$NAME"; then
  curl -s -H "Authorization: Bearer $ADMIN" -o "$OUT/after-replace.zip" "http://127.0.0.1:$PORT/api/rec/admin/runs/$LAST_RUN/zip"
  if node --import tsx --input-type=module -e '
      const { readZip } = await import("./apps/server/src/recorder/zip.ts");
      const crypto = await import("node:crypto"); const fs = await import("node:fs");
      const files = readZip(fs.readFileSync(process.argv[1])); const man = JSON.parse(files.get("manifest.json").toString());
      for (const f of man.files) if (crypto.createHash("sha256").update(files.get(f.name)).digest("hex") !== f.sha256) throw new Error("sha mismatch " + f.name);
      console.log("zip after container replacement: " + man.files.length + " files, checksums ok, lines=" + man.cutoff.lines);
    ' "$OUT/after-replace.zip" 2>&1 | tee -a "$OUT/summary.txt"; then :; else say "FAIL download after replacement"; FAIL=1; fi
  docker rm -f "$NAME" > /dev/null
else FAIL=1; fi
rm -rf "$DATA"
[ $FAIL = 0 ] && say "✅ probe-recorder-docker: ALL PASS" || { say "❌ probe-recorder-docker: FAILED (see above)"; exit 1; }
