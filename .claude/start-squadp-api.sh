#!/bin/bash
# 队长性格刀 · api：起在本会话名下，preview_logs 才捞得到日志
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-squad-personality"
export PORT=3026
exec npm run dev --workspace=apps/server
