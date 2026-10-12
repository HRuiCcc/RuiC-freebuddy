#!/bin/bash
# 双击运行：摘掉面板、释放休眠唤醒锁、停掉守护进程（不关 WorkBuddy）。
# 等价 Windows 上的 scripts\Stop-FreeBuddy.cmd。
cd "$(dirname "$0")/.." || exit 1
node src/stop.mjs
read -n 1 -s -r -p "按任意键关闭…"
