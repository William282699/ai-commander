#!/bin/bash
# 语音输入 V1 · 延迟基线臂（现状 Web Speech）——主仓库 @cb02c2b，与 worktree 同一
# 个 gemini 脑子、同一份信封，只差"耳朵"：这一边是浏览器 Web Speech 听写。
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander"
export PORT=3020
exec npm run dev --workspace=apps/server
