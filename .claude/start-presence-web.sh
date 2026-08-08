#!/bin/bash
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-presence"
export VITE_API_URL="http://localhost:3002"
exec npm run dev --workspace=apps/web -- --port 3005
