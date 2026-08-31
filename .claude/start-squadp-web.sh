#!/bin/bash
# 队长性格刀 · web
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-squad-personality"
export VITE_API_URL="http://localhost:3026"
exec npm run dev --workspace=apps/web -- --port 3027
