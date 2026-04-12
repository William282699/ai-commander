#!/bin/bash
export PATH="/opt/homebrew/opt/node.js/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
exec npm run dev --workspace=apps/web -- --port 3003
