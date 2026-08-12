#!/bin/bash
# 刀 C 手测臂：api 起在本会话名下，[EVENT] voice_heard 才捞得到
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "/Users/yuqiaohuang/MyProjects/AI Commander-voice-input"
export PORT=3022
exec npm run dev --workspace=apps/server
