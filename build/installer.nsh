; FreeBuddy · NSIS 自定义段（由 electron-builder 的 nsis.include 引入）
;
; 这里做三件事：
;   1) 补一个真正的「欢迎/安装页」——electron-builder 的辅助式安装向导本身不带欢迎页，
;      只有外部定义了 customWelcomePage 宏时才会插入，页面左侧那张大图就是 installerSidebar.bmp（FreeBuddy logo）。
;   2) 不写开机自启。默认跟 WorkDaddy 一样「点图标才起作用」，装完不自启。
;      （要用自启就在控制台「关于」页打开开关，那条会写 --tray：托盘常驻、不主动接管 WorkBuddy。）
;   3) 卸载时顺手清掉自启值，免得留残渣。

!include "MUI2.nsh"

; ── 1) 安装页（左侧 logo 大图 + 中文标题） ─────────────────────────────
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 FreeBuddy"
  !define MUI_WELCOMEPAGE_TEXT "FreeBuddy 是 WorkBuddy 桌面端的本机增强面板：$\r$\n\
多账号备份与秒切、跨账号积分与签到、Token 用量统计、免打扰与休眠控制。$\r$\n$\r$\n\
装好后双击桌面上的 FreeBuddy，它会直接把 WorkBuddy 打开、把面板嵌进窗口右下角 —— \
它自己没有窗口，也不改官方安装包、不改签名，不收集也不上传任何数据。$\r$\n$\r$\n\
点「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; ── 2) 开始菜单里再放一个「控制台」入口 ──────────────────────────────
; 桌面/开始菜单的主图标是「进去模式」（直接进 WorkBuddy，自己没有窗口）；
; 想手动启停、看日志、调设置时走这个 --console 入口。
!macro customInstall
  CreateShortCut "$SMPROGRAMS\FreeBuddy 控制台.lnk" "$INSTDIR\FreeBuddy.exe" "--console" "$INSTDIR\FreeBuddy.exe" 0
!macroend

; ── 3) 卸载清理 ───────────────────────────────────────────────────────
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FreeBuddy"
  Delete "$SMPROGRAMS\FreeBuddy 控制台.lnk"
!macroend
