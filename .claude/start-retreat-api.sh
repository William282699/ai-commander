#!/bin/bash
# 改令链 · api：起在本会话名下，preview_logs 才捞得到日志
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-retreat-scope"
export PORT=3028
exec npm run dev --workspace=apps/server
