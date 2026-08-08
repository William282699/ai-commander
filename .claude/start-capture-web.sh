#!/bin/bash
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-capture"
export VITE_API_URL="http://localhost:3009"
exec npm run dev --workspace=apps/web -- --port 3007
