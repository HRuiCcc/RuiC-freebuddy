#!/bin/bash
# 把 FreeBuddy 打包成可分发的 macOS 应用与安装包。
#
#   用法：  bash build/mac/package-mac.sh
#
# 产物（默认落在 ./build/mac/out/）：
#   FreeBuddy.app          双击即用（包内自带 Node 运行时，不依赖本机 node）
#   FreeBuddy-0.1.0.dmg    安装包：拖进「应用程序」即可
#
# 全程只用到系统自带工具：swiftc / iconutil / sips / hdiutil / codesign。
# 不依赖 Xcode 全量安装，也不联网。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"
APP="$OUT/FreeBuddy.app"
VERSION="$(/usr/bin/python3 -c "import json,sys;print(json.load(open('$REPO/package.json'))['version'])")"
DMG="$OUT/FreeBuddy-$VERSION.dmg"

# 包内的 Node 运行时来源：FB_NODE_DIR 指定 → 否则用 PATH 上的 node 反推安装根目录
# （要的是「官方发行包」那种 <root>/bin/node 结构；单文件可执行也能用，见下）
NODE_SRC="${FB_NODE_DIR:-}"
if [ -z "${NODE_SRC}" ] || [ ! -x "${NODE_SRC}/bin/node" ]; then
  NODE_BIN="$(command -v node || true)"
  if [ -z "${NODE_BIN}" ]; then
    echo "找不到可用的 node：请装 Node ≥ 22.5，或用 FB_NODE_DIR=/path/to/node-vXX 指定" >&2
    exit 1
  fi
  NODE_SRC="$(cd "$(dirname "${NODE_BIN}")/.." && pwd)"
fi

echo "仓库：${REPO}"
echo "版本：${VERSION}"
echo "Node 运行时：${NODE_SRC} （$("${NODE_SRC}/bin/node" -v)）"

# ── 0) 前置检查 ──
"$NODE_SRC/bin/node" -e "require('node:sqlite')" 2>/dev/null || {
  echo "✗ 这个 Node 没有内建 node:sqlite，FreeBuddy 需要 ≥ 22.5" >&2
  exit 1
}

# ── 1) 编译原生启动器 ──
echo "编译启动器…"
SDK="$(xcrun --show-sdk-path)"
swiftc -O -parse-as-library \
  -target arm64-apple-macosx14.0 \
  -sdk "$SDK" \
  -framework SwiftUI -framework AppKit \
  -o "$HERE/FreeBuddy-bin" "$HERE/Launcher.swift"

# ── 2) 生成图标 ──
echo "生成图标…"
swiftc -O -target arm64-apple-macosx13.0 -sdk "$SDK" \
  -framework AppKit -framework CoreGraphics -framework ImageIO \
  -o "$HERE/icongen" "$HERE/IconGen.swift"
"$HERE/icongen" "$HERE/icon_1024.png" >/dev/null

rm -rf "$HERE/FreeBuddy.iconset"
mkdir -p "$HERE/FreeBuddy.iconset"
for s in 16 32 64 128 256 512; do
  sips -Z $s "$HERE/icon_1024.png" --out "$HERE/FreeBuddy.iconset/icon_${s}x${s}.png" >/dev/null
done
for s in 32 64 256 512; do
  sips -Z $((s * 2)) "$HERE/icon_1024.png" --out "$HERE/FreeBuddy.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$HERE/FreeBuddy.iconset" -o "$HERE/FreeBuddy.icns"

# ── 3) 组装 .app ──
echo "组装 FreeBuddy.app…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime/node/bin" "$APP/Contents/Resources/freebuddy"

cp "$HERE/FreeBuddy-bin" "$APP/Contents/MacOS/FreeBuddy"
chmod +x "$APP/Contents/MacOS/FreeBuddy"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$HERE/FreeBuddy.icns" "$APP/Contents/Resources/FreeBuddy.icns"

# 包内 Node：只要那一个二进制。
# FreeBuddy 零 npm 依赖、只用内建模块（node:sqlite / node:crypto / WebSocket / fetch），
# 连带 npm 的 lib/ 都不需要 —— 省掉 210MB。
cp "$NODE_SRC/bin/node" "$APP/Contents/Resources/runtime/node/bin/node"
cp "$NODE_SRC/LICENSE" "$APP/Contents/Resources/runtime/node/LICENSE" 2>/dev/null || true

# 源码树：只带运行时要用的（src/ + package.json + LICENSE），开发用的 tools / docs 不进安装包
cp -R "$REPO/src" "$APP/Contents/Resources/freebuddy/src"
cp "$REPO/package.json" "$APP/Contents/Resources/freebuddy/package.json"
cp "$REPO/LICENSE" "$APP/Contents/Resources/freebuddy/LICENSE"

# 清掉可能被带进来的临时产物
find "$APP/Contents/Resources/freebuddy" -name '.DS_Store' -delete 2>/dev/null || true

# ── 4) 签名（ad-hoc） ──
# 包内 node 自带官方签名、逐个保持原样；这里只签我们自己的启动器与 .app 外壳。
echo "签名（ad-hoc）…"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/FreeBuddy" >/dev/null 2>&1
codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1
codesign --verify --deep --strict "$APP" && echo "  签名校验通过"

# ── 5) 打 DMG ──
# 两段式：先做一个可写盘摆好卷图标与图标布局，再压成 UDZO 分发。
# Finder 布局那步要 AppleScript 遥控 Finder；没有自动化权限时跳过，
# 图标位置退回默认排布，安装包依然可用。
VOLNAME="FreeBuddy ${VERSION}"

# 脚本里一律用绝对路径：$HERE 是相对路径时，脚本内不 cd 就会拷到不存在的地方
ICNS="$(cd "$(dirname "$HERE/FreeBuddy.icns")" && pwd)/FreeBuddy.icns"
DMBG="$(cd "$HERE" && pwd)/dmg-bg.png"

echo "生成安装包背景…"
swiftc -O -target arm64-apple-macosx14.0 -sdk "$SDK" \
  -framework AppKit -framework CoreGraphics -framework ImageIO \
  -o "$HERE/dmgbg" "$HERE/DmgBg.swift"
"$HERE/dmgbg" "$DMBG" >/dev/null

echo "制作安装包…"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/应用程序"
mkdir -p "$STAGE/.background"
cp "$DMBG" "$STAGE/.background/dmg-bg.png"

# 卷里留一份简短说明，用户不用去翻 README
cat >"$STAGE/安装说明.txt" <<EOF
FreeBuddy ${VERSION} —— 安装

1. 把左边的「FreeBuddy」拖到右边的「应用程序」里。
2. 到「启动台 / 应用程序」双击 FreeBuddy 即可。

首次打开如果被 macOS 拦下（提示"无法验证开发者"）：
   在「访达」里右键点 FreeBuddy → 打开 → 再点「打开」；
   或者对 FreeBuddy.app 执行一次：
   xattr -dr com.apple.quarantine /Applications/FreeBuddy.app

FreeBuddy 做的事：把 WorkBuddy 以调试端口方式接管，并把本机增强面板注入进去。
面板在 WorkBuddy 窗口右下角。想摘掉面板：双击 FreeBuddy 点「停止 FreeBuddy…」。

数据目录：~/Library/Application Support/FreeBuddy/
日志：    ~/Library/Application Support/FreeBuddy/logs/daemon.log
EOF

TMP_DMG="$HERE/freebuddy-rw.dmg"
MOUNT_POINT="/Volumes/$VOLNAME"   # 仅用于探测同名残留与提示
rm -f "$DMG" "$TMP_DMG"

# 上一轮如果没卸干净，同名卷会占住挂载点：这时新镜像根本挂不上，
# 而 mkdir/SetFile 又会"成功"写进那个旧卷 —— 最后打出来的包是旧的。
detach_if_present() {
  [ -d "$MOUNT_POINT" ] || return 0
  echo "  发现同名卷还挂着，先卸掉"
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || hdiutil detach "$MOUNT_POINT" -force -quiet 2>/dev/null || true
  for i in 1 2 3 4 5; do
    [ -d "$MOUNT_POINT" ] || return 0
    sleep 1
  done
  return 1
}
if ! detach_if_present; then
  echo "卸载不掉 $MOUNT_POINT：请手动处理后再打包" >&2
  exit 1
fi

hdiutil create -volname "$VOLNAME" -srcfolder "$STAGE" -ov -format UDRW -fs HFS+ "$TMP_DMG" >/dev/null

# -nobrowse：不弹 Finder 窗口。
# 注意：同名卷还占着时，系统会把新镜像挂成 "<卷名> 1"，于是所有写入都落在旧卷上，
# 打出来的包永远是旧的。所以这里从 attach 输出里取「真实挂载点」，不靠拼路径。
MOUNT_DIR=""
ATTACH_OUT="$(hdiutil attach "$TMP_DMG" -nobrowse -noautoopen 2>&1)"
MOUNT_DIR="$(printf '%s\n' "$ATTACH_OUT" | sed -n 's|^.*\(/Volumes/.*\)$|\1|p' | tail -1)"
MOUNTED=0
if [ -n "$MOUNT_DIR" ] && [ -d "$MOUNT_DIR" ]; then
  MOUNTED=1
  if [ "$MOUNT_DIR" != "$MOUNT_POINT" ]; then
    echo "  注意：实际挂载点是 $MOUNT_DIR（不是 $MOUNT_POINT），按真实挂载点操作" >&2
  fi
fi
if [ "$MOUNTED" -ne 1 ]; then
  echo "临时镜像没能挂载，安装包降级为简易版" >&2
fi

# 窗口大小 / 背景 / 图标位置：遥控 Finder 摆一次。
# 没有自动化权限时这步整体跳过 —— 图标位置退回默认排布，包照样能装。
if [ "$MOUNTED" -eq 1 ]; then
  # 单项摆位失败不影响其余项；最后的 close/eject 一定执行，免得卡住后续卸卷
  osascript <<APPLESCRIPT >/dev/null 2>&1 || echo "  （Finder 布局跳过：没有自动化权限，图标用默认排布）"
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {220, 160, 860, 560}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 104
    try
      set background picture of opts to file ".background:dmg-bg.png"
    end try
    try
      set position of item "FreeBuddy.app" of container window to {150, 215}
    end try
    try
      set position of item "应用程序" of container window to {470, 215}
    end try
    try
      set position of item "安装说明.txt" of container window to {310, 375}
    end try
    update without registering applications
    delay 1
    close
  end tell
end tell
APPLESCRIPT
fi

# 卷图标：icns 放根目录 + 让 Finder 认「自定义图标」标记。
# 顺序很关键：必须放在 Finder 摆布局之后 —— 实测 Finder 在改窗口布局时会把
# 根目录下的 .VolumeIcon.icns 一并清掉，先写后写就白写了。
DBG="$HERE/dmg-build.log"
{
  echo "时间：$(date)"
  echo "ICNS=$ICNS 存在=$([ -f "$ICNS" ] && echo 是 || echo 否)"
  echo "MOUNT_DIR=$MOUNT_DIR"
  echo "MOUNTED=$MOUNTED"
} >"$DBG" 2>&1

if [ "$MOUNTED" -eq 1 ]; then
  if cp "$ICNS" "$MOUNT_DIR/.VolumeIcon.icns" 2>>"$DBG"; then
    SetFile -a V "$MOUNT_DIR/.VolumeIcon.icns" 2>/dev/null || true
    if SetFile -a C "$MOUNT_DIR" 2>/dev/null; then
      echo "  卷图标已设置"
    else
      echo "  卷图标文件已就位（自定义图标标记没打上，多数系统仍会读到）"
    fi
    echo "  写入确认：$([ -f "$MOUNT_DIR/.VolumeIcon.icns" ] && echo 在 || echo 不在)" >>"$DBG"
  else
    echo "  卷图标拷贝失败，细节见 $DBG" >&2
  fi
fi

# 卸卷：Finder 可能还攥着句柄。多留一拍让文件系统把元数据落盘，
# 再走 hdiutil detach（比 Finder 的 eject 可控，实测这条路径稳定）。
if [ "$MOUNTED" -eq 1 ]; then
  sync
  sleep 2
  for i in 1 2 3 4 5; do
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 && break
    sleep 1
    hdiutil detach "$MOUNT_DIR" -force -quiet >/dev/null 2>&1 && break
    sleep 1
  done
fi
if [ -d "$MOUNT_DIR" ]; then
  echo "临时镜像没能卸载，稍后手动 hdiutil detach \"$MOUNT_DIR\" 即可" >&2
  exit 1
fi

hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
rm -f "$TMP_DMG"
rm -rf "$STAGE"

echo
echo "完成"
echo "App: ${APP}"
echo "DMG: ${DMG} （$(du -sh "${DMG}" | cut -f1)）"
