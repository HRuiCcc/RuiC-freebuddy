# -*- coding: utf-8 -*-
"""给安装包向导截屏（验收「安装页 + logo」）：
启动 Setup.exe -> 等 wizard 出来 -> 全屏抓一张 -> 关掉向导（不落盘安装）。
用法： py tools/shot-setup.py <setup.exe> <out.png> [wait_s]
"""
import os
import subprocess
import sys
import time

from PIL import ImageGrab

setup = sys.argv[1]
out = sys.argv[2]
wait_s = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0

proc = subprocess.Popen([setup], close_fds=True)
time.sleep(wait_s)

img = ImageGrab.grab()
img.save(out)
print("saved", out, img.size)

# 关掉向导（只杀我们自己刚起的那个安装程序）
try:
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-Command",
         "Get-Process -Name '%s' -ErrorAction SilentlyContinue | "
         "Where-Object { $_.MainWindowTitle -ne '' } | Stop-Process -Force" % os.path.basename(setup)[:-4]],
        timeout=20, check=False)
except Exception as e:
    print("close warn:", e)
time.sleep(1.5)
try:
    proc.kill()
except Exception:
    pass
print("wizard closed")
