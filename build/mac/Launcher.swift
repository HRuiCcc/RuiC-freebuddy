// FreeBuddy.app 的原生外壳。
//
// 只做四件事：
//   1. 画一个带 logo 的启动窗，把真实进度显示出来（进度文案来自 Node 启动器的 [FB-STEP] 标记）
//   2. 用包里自带的 Node 运行时跑 src/launcher.mjs —— 接管 WorkBuddy 并注入面板
//   3. 成功就自动收起窗口，WorkBuddy 已在最前面
//   4. 顺带提供「停止 FreeBuddy」（摘面板 + 释放唤醒锁 + 停守护进程）和「查看日志」
//
// 所有真正的活都在 Node 侧；这里不复制一份业务逻辑，避免两边说法不一致。
import AppKit
import SwiftUI

let appVersion = "0.1.0"

// MARK: - 路径

enum Paths {
  /// 包内资源根：…/FreeBuddy.app/Contents/Resources
  static var resources: URL {
    Bundle.main.resourceURL ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Resources")
  }
  /// 随包分发的 Node 运行时（自包含，不依赖用户机器上的 node）
  static var node: URL { resources.appendingPathComponent("runtime/node/bin/node") }
  /// FreeBuddy 源码树（仓库 src/ 的原样拷贝）
  static var srcRoot: URL { resources.appendingPathComponent("freebuddy") }
  static var launcherJS: URL { srcRoot.appendingPathComponent("src/launcher.mjs") }
  static var stopJS: URL { srcRoot.appendingPathComponent("src/stop.mjs") }
  static var daemonLog: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/FreeBuddy/logs/daemon.log")
  }
}

// MARK: - 状态机

enum LaunchState: Equatable {
  case idle
  case running
  case finished
  case failed(String)

  var isRunning: Bool { self == .running }
  var isFinished: Bool { self == .finished }
}

// MARK: - 模型

@MainActor
final class FreeBuddyModel: ObservableObject {
  @Published var state: LaunchState = .idle
  @Published var stageText = "准备启动…"
  @Published var lines: [String] = []

  private var child: Process?
  private let maxKeptLines = 400

  func begin() {
    guard state != .running else { return }
    lines.removeAll()
    state = .running
    stageText = "正在准备…"
    append("FreeBuddy v\(appVersion) —— 接管 WorkBuddy 并注入面板")
    spawn(Paths.launcherJS, parseStages: true)
  }

  /// 起一个子进程跑指定的 node 脚本；stdout / stderr 合并逐行读回。
  /// 只有启动器那条线解析 [FB-STEP] 标记，别的脚本只是原样显示输出。
  private func spawn(_ script: URL, parseStages: Bool) {
    guard FileManager.default.isExecutableFile(atPath: Paths.node.path) else {
      fail("包内 Node 运行时缺失：\(Paths.node.path)")
      return
    }
    guard FileManager.default.fileExists(atPath: script.path) else {
      fail("找不到脚本：\(script.path)")
      return
    }

    let p = Process()
    p.executableURL = Paths.node
    p.arguments = [script.path]

    var env = ProcessInfo.processInfo.environment
    // 让 Node 侧 spawn 出来的 open / caffeinate 等系统命令能找到；同时不把宿主环境的
    // ELECTRON_RUN_AS_NODE 之类透传给 WorkBuddy（Node 侧还会再清一遍，这里是双保险）。
    env["PATH"] = "\(Paths.node.deletingLastPathComponent().path):/usr/bin:/bin:/usr/sbin:/sbin"
    env["FB_FROM_APP"] = "1"
    env.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
    env.removeValue(forKey: "ELECTRON_NO_ATTACH_CONSOLE")
    env.removeValue(forKey: "ELECTRON_FORCE_IS_PACKAGED")
    p.environment = env

    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe

    // 逐行切分；最后一段没有换行的「半行」也即时显示，避免界面卡着不动
    let splitter = LineSplitter { [weak self] line in
      Task { @MainActor in self?.consume(line, parseStages: parseStages) }
    }
    pipe.fileHandleForReading.readabilityHandler = { h in
      let data = h.availableData
      guard !data.isEmpty else {
        h.readabilityHandler = nil
        return
      }
      if let text = String(data: data, encoding: .utf8) { splitter.feed(text) }
    }

    p.terminationHandler = { [weak self] proc in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.child = nil
        self.finish(code: proc.terminationStatus)
      }
    }

    do {
      try p.run()
    } catch {
      fail("无法启动：\(error.localizedDescription)")
      return
    }
    child = p
  }

  /// 收一行输出：标记行进阶段栏，其余进日志区。
  private func consume(_ raw: String, parseStages: Bool) {
    let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !line.isEmpty else { return }
    if parseStages, line.hasPrefix("[FB-STEP] ") {
      stageText = String(line.dropFirst("[FB-STEP] ".count))
      return
    }
    append(line)
  }

  private func append(_ text: String) {
    lines.append(text)
    if lines.count > maxKeptLines { lines.removeFirst(lines.count - maxKeptLines) }
  }

  private func finish(code: Int32) {
    switch code {
    case 0:
      state = .finished
      stageText = "面板已注入 —— 看 WorkBuddy 窗口右下角"
    case 2:
      fail("没找到 WorkBuddy 客户端", hint: "请先安装 WorkBuddy（本机应存在 /Applications/WorkBuddy.app）")
    case 3:
      fail(
        "WorkBuddy 没能在调试模式下启动",
        hint: "多半是单实例逻辑接管了这次启动：请完全退出 WorkBuddy 后再点一次「启动 FreeBuddy」")
    case 4:
      fail("本机守护进程没能启动", hint: "看 ~/Library/Application Support/FreeBuddy/logs/daemon.log")
    default:
      fail("启动失败（退出码 \(code)）", hint: "日志在 ~/Library/Application Support/FreeBuddy/logs/daemon.log")
    }
  }

  private func fail(_ message: String, hint: String? = nil) {
    state = .failed(message)
    stageText = message
    append("✗ " + message)
    if let hint { append("  " + hint) }
  }

  /// 停止 FreeBuddy：摘面板 + 释放唤醒锁 + 停守护进程（不关 WorkBuddy）
  func stop() {
    guard !state.isRunning else { return }
    state = .running
    stageText = "正在停掉 FreeBuddy…"
    append("停止：摘掉面板、释放唤醒锁、结束守护进程（WorkBuddy 保持运行）")
    spawn(Paths.stopJS, parseStages: false)
  }

  func openLogs() {
    let log = Paths.daemonLog
    if FileManager.default.fileExists(atPath: log.path) {
      NSWorkspace.shared.open(log)
    } else {
      let dir = Paths.daemonLog.deletingLastPathComponent()
      if FileManager.default.fileExists(atPath: dir.path) { NSWorkspace.shared.open(dir) }
    }
  }

  /// 把 WorkBuddy 顶到前台（不动面板，只做激活）
  func focusWorkBuddy() {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["-a", "/Applications/WorkBuddy.app"]
    try? task.run()
  }
}

/// 把可能被切断的字节流切回整行（UTF-8 多字节字符不会被切坏）
final class LineSplitter {
  private var buffer = ""
  private let onLine: (String) -> Void

  init(onLine: @escaping (String) -> Void) { self.onLine = onLine }

  func feed(_ text: String) {
    buffer += text
    while let idx = buffer.firstIndex(of: "\n") {
      let line = String(buffer[buffer.startIndex..<idx])
      buffer = String(buffer[buffer.index(after: idx)...])
      if !line.trimmingCharacters(in: .whitespaces).isEmpty { onLine(line) }
    }
    // 半行也先显示：把「正在等待…」这类不换行的进度及时带出来
    let tail = buffer.trimmingCharacters(in: .whitespaces)
    if !tail.isEmpty { onLine(tail) }
  }
}

// MARK: - 界面

/// 与应用图标同源的 F 字标（同一个几何比例，只是画在 SwiftUI 里）
struct LogoMark: View {
  var size: CGFloat = 56

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              Color(red: 122 / 255, green: 122 / 255, blue: 232 / 255),
              Color(red: 74 / 255, green: 74 / 255, blue: 190 / 255),
              Color(red: 56 / 255, green: 56 / 255, blue: 158 / 255),
            ],
            startPoint: .topLeading, endPoint: .bottomTrailing))

      GeometryReader { geo in
        let w = geo.size.width
        let barW = w * 0.144
        let barH = w * 0.134
        let stemX = w * 0.328
        let stemTop = w * 0.676
        let stemBottom = w * 0.324
        let armRight = w * 0.672
        let midRight = w * 0.605
        let midY = w * 0.5
        let r = min(barW, barH) / 2

        ZStack(alignment: .topLeading) {
          // 竖笔
          RoundedRectangle(cornerRadius: r, style: .continuous)
            .fill(.white)
            .frame(width: barW, height: stemTop - stemBottom)
            .offset(x: stemX, y: w - stemTop)
          // 上横
          RoundedRectangle(cornerRadius: r, style: .continuous)
            .fill(.white)
            .frame(width: armRight - stemX, height: barH)
            .offset(x: stemX, y: w - stemTop)
          // 中横
          RoundedRectangle(cornerRadius: r, style: .continuous)
            .fill(.white)
            .frame(width: midRight - stemX, height: barH)
            .offset(x: stemX, y: w - midY - barH / 2)
          // 右上角信号点
          Circle()
            .fill(Color(red: 199 / 255, green: 199 / 255, blue: 255 / 255))
            .frame(width: w * 0.117, height: w * 0.117)
            .offset(x: w * 0.672, y: w * 0.148)
        }
      }
      .frame(width: size, height: size)
    }
    .frame(width: size, height: size)
  }
}

struct LogBox: View {
  let lines: [String]

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(lines.enumerated()), id: \.offset) { idx, line in
            Text(line)
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .id(idx)
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
      }
      .background(Color.primary.opacity(0.045))
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.08))
      )
      .onChange(of: lines.count) { _, count in
        guard count > 0 else { return }
        withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(count - 1, anchor: .bottom) }
      }
    }
  }
}

struct ContentView: View {
  @ObservedObject var model: FreeBuddyModel

  private var accent: Color { Color(red: 91 / 255, green: 91 / 255, blue: 214 / 255) }

  private var statusSymbol: String {
    switch model.state {
    case .idle: return "circle.dashed"
    case .running: return "arrow.triangle.2.circlepath"
    case .finished: return "checkmark.circle.fill"
    case .failed: return "exclamationmark.triangle.fill"
    }
  }

  private var statusColor: Color {
    switch model.state {
    case .finished: return Color(red: 18 / 255, green: 128 / 255, blue: 92 / 255)
    case .failed: return Color(red: 192 / 255, green: 57 / 255, blue: 43 / 255)
    default: return accent
    }
  }

  private var primaryTitle: String { model.state.isFinished ? "打开 WorkBuddy" : "启动 FreeBuddy" }
  private var primaryIcon: String { model.state.isFinished ? "macwindow" : "play.fill" }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        LogoMark(size: 56)
        VStack(alignment: .leading, spacing: 3) {
          Text("FreeBuddy").font(.system(size: 17, weight: .semibold))
          Text("WorkBuddy 本机增强面板 · v\(appVersion)")
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }
        Spacer()
      }

      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: statusSymbol)
          .foregroundStyle(statusColor)
          .symbolEffect(.pulse, options: .repeating, isActive: model.state.isRunning)
        Text(model.stageText)
          .font(.system(size: 12.5))
          .fixedSize(horizontal: false, vertical: true)
          .lineLimit(2)
        Spacer(minLength: 0)
        if model.state.isRunning {
          ProgressView().controlSize(.small).scaleEffect(0.8)
        }
      }

      LogBox(lines: model.lines)
        .frame(minHeight: 108, idealHeight: 150, maxHeight: 240)

      HStack(spacing: 8) {
        Button {
          if model.state.isFinished { model.focusWorkBuddy() } else { model.begin() }
        } label: {
          Label(primaryTitle, systemImage: primaryIcon).frame(minWidth: 92)
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .tint(accent)
        .disabled(model.state.isRunning)

        Button("停止 FreeBuddy…") { model.stop() }
          .disabled(model.state.isRunning)

        Spacer()

        Button("查看日志") { model.openLogs() }
          .buttonStyle(.link)
      }
    }
    .padding(20)
    .frame(width: 520)
    .background(.regularMaterial)
  }
}

// MARK: - 入口

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let model = FreeBuddyModel()
  private var window: NSWindow?
  private var successTimer: Timer?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)

    // 点关闭就当退出，不留后台壳子（面板本身跑在守护进程里，不依赖这个窗口）
    NotificationCenter.default.addObserver(
      forName: NSWindow.willCloseNotification, object: nil, queue: .main
    ) { _ in
      NSApp.terminate(nil)
    }

    let hosting = NSHostingController(rootView: ContentView(model: model))
    let w = NSWindow(contentViewController: hosting)
    w.title = "FreeBuddy"
    w.styleMask = [.titled, .closable, .miniaturizable]
    w.isReleasedWhenClosed = false
    w.center()
    w.makeKeyAndOrderFront(nil)
    window = w
    NSApp.activate(ignoringOtherApps: true)

    // 双击就开跑：启动 → 接管 WorkBuddy → 注入面板 → 成功即收起窗口
    model.begin()
    watchForSuccess()
  }

  /// 成功后延时把窗口收起来：给用户看一眼结果的时间，WorkBuddy 已经在最前面了。
  private func watchForSuccess() {
    successTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
      Task { @MainActor [weak self] in
        guard let self else { timer.invalidate(); return }
        guard self.model.state.isFinished, self.window?.isVisible == true else { return }
        timer.invalidate()
        try? await Task.sleep(for: .seconds(2.2))
        self.window?.orderOut(nil)
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
enum FreeBuddyApp {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
  }
}
