#!/bin/bash
# 双击运行：接管 WorkBuddy（必要时按调试端口重启它）并把面板注入进去。
# 等价 Windows 上的 scripts\Start-FreeBuddy.cmd。
cd "$(dirname "$0")/.." || exit 1
echo "正在启动 FreeBuddy…"
node src/launcher.mjs
if [ $? -ne 0 ]; then
  echo
  echo "启动过程有报错，日志在 ~/Library/Application Support/FreeBuddy/logs/daemon.log"
  read -n 1 -s -r -p "按任意键关闭…"
fi
