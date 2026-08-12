#!/bin/bash
# 延迟 A/B 基线臂：主仓库 cb02c2b 的**前端**（现状 Web Speech 听写），
# 后端故意指向 knifec-api(3022)——Web Speech 回合在服务端看来就是打字回合
# （送的是 message 文本、没有 audio），所以共用后端反而更干净：
# 两臂差的只有"耳朵"这一件，LLM 那一段完全同源。
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander"
export VITE_API_URL="http://localhost:3022"
exec npm run dev --workspace=apps/web -- --port 3021
