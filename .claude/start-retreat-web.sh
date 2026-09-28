#!/bin/bash
# 改令链 · web
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-retreat-scope"
export VITE_API_URL="http://localhost:3028"
exec npm run dev --workspace=apps/web -- --port 3029
