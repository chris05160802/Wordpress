#!/usr/bin/env sh
# Starts WP 批量管家 and opens it in the browser.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 18 或更高版本：https://nodejs.org/zh-cn"
  exit 1
fi
exec node server.js --open
