#!/bin/bash
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-voice-input"
export VITE_API_URL="http://localhost:3022"
exec npm run dev --workspace=apps/web -- --port 3023
