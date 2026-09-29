#!/bin/bash
# ============================================================
# 试玩记录仪 T15：Docker 生产镜像 ＋ 挂载目录 ＋ 两种停机信号 ＋ 换容器后再下载。
#
# 需要 Docker。这台 Mac 用 Colima（`brew install colima docker && colima start`）；2026-09-28 在这里真跑过，
# 结果见 ~/MyProjects/_archive/playtest-recorder-v1-20260928/review-fable-20260928/docker/。
# 不连任何真模型（密钥置空）、不碰线上 Fly、不推任何镜像。用法（worktree 根）：
#   bash scripts/probe-recorder-docker.sh <证据目录>
# 判定（任何一条不满足就 FAIL，退出码 1）：
#   ① docker stop -t 5（SIGTERM）与 docker kill --signal=SIGINT 两种各一次：容器 5 秒内自己退出
#      （不是被 SIGKILL：退出码不是 137），日志里有 “[shutdown] … drain done … leftover=0”；
#   ② 停机前已应答的每个命令请求，其服务端事实都在挂载目录里，并有服务端生产者的“最后序号”；
#   ③ 删掉容器、用同一挂载目录起新容器，同一局的 ZIP 还能下载，且包内 manifest 的各文件 sha256 自洽。
# ★容器实测（2026-09-28，Colima）：旧 CMD `npm run start --workspace=apps/server` 两种信号都 FAIL——
#   SIGTERM 时 npm 641 ms 退出码 1、node 没排空就被收；SIGINT 时 npm 当 PID 1 干脆不理，容器 5 秒内不停。
#   改成直接 `node --import tsx apps/server/src/index.ts` 后两种信号都 ~130 ms 排空退出 0，换容器再下载也过。
#   Dockerfile 已按此改（用户批准）；本脚本照 Dockerfile 建镜像，不自己改 CMD。
# 两处曾撞过的脚本坑：容器没自己停下来时必须 `docker rm -f`，否则残留容器占着端口把下一轮全污染；
#   数据目录要放在家目录下（Colima 只共享 $HOME，macOS 的 mktemp 不理 TMPDIR）。
# ============================================================
set -u
OUT="${1:?usage: probe-recorder-docker.sh <evidence dir>}"
mkdir -p "$OUT"
IMG="aic-recorder-probe:local"
DATA="$(mktemp -d "${RECORDER_PROBE_TMP:-$HOME}/rec-docker-probe.XXXXXX")"   # 家目录下：Colima 只共享 $HOME
ADMIN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
PORT=18091
FAIL=0
say() { echo "$*" | tee -a "$OUT/summary.txt"; }

docker rm -f aic-rec-SIGTERM aic-rec-SIGINT aic-rec-replaced > /dev/null 2>&1   # 上一轮残留（没停下来的容器会占着端口）
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
  docker rm -f "$NAME" > /dev/null 2>&1   # 没自己停下来的也强杀，否则占着端口污染下一轮
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
