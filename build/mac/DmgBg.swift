// 安装包（DMG）窗口背景图。
// 一幅 640×400（@2x 渲染成 1280×800）的浅色渐变底，画上「拖到应用程序」的箭头与提示语。
// 与用户系统深色/浅色无关：DMG 窗口固定用这一张暖白底，读数最清楚。
import AppKit
import CoreGraphics
import Foundation
import ImageIO

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
}

func renderBackground(scale: CGFloat = 2) -> CGImage {
  let W: CGFloat = 640, H: CGFloat = 400
  let pw = Int(W * scale), ph = Int(H * scale)
  let cs = CGColorSpaceCreateDeviceRGB()
  guard
    let ctx = CGContext(
      data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
      space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fatalError("无法创建绘图上下文") }
  ctx.scaleBy(x: scale, y: scale)

  // 底：左上偏白的浅灰渐变，避免纯白在 Finder 里显得没边
  let bg = CGGradient(
    colorsSpace: cs,
    colors: [rgb(252, 252, 254), rgb(238, 239, 247)] as CFArray,
    locations: [0, 1])!
  ctx.drawLinearGradient(
    bg, start: CGPoint(x: 0, y: H), end: CGPoint(x: W, y: 0), options: [])

  // 顶部标题
  func draw(_ text: String, size: CGFloat, weight: NSFont.Weight, color: CGColor, center: CGPoint) {
    let font = NSFont.systemFont(ofSize: size, weight: weight)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: NSColor(cgColor: color) ?? .black,
    ]
    let s = NSAttributedString(string: text, attributes: attrs)
    let line = CTLineCreateWithAttributedString(s)
    let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
    ctx.textPosition = CGPoint(x: center.x - bounds.width / 2, y: center.y - bounds.height / 2)
    CTLineDraw(line, ctx)
  }

  draw("安装 FreeBuddy", size: 21, weight: .semibold, color: rgb(22, 24, 29), center: CGPoint(x: W / 2, y: H - 46))
  draw(
    "把左边这个应用拖进右边「应用程序」就行", size: 12.5, weight: .regular, color: rgb(120, 124, 134),
    center: CGPoint(x: W / 2, y: H - 70))

  // 中间那支箭头（两个图标之间）
  let midY: CGFloat = H - 205
  let x0: CGFloat = 238, x1: CGFloat = 400
  ctx.setFillColor(rgb(150, 154, 168, 0.85))
  ctx.fill(CGRect(x: x0, y: midY - 3.5, width: x1 - x0 - 26, height: 7))
  ctx.move(to: CGPoint(x: x1 - 34, y: midY + 17))
  ctx.addLine(to: CGPoint(x: x1, y: midY))
  ctx.addLine(to: CGPoint(x: x1 - 34, y: midY - 17))
  ctx.closePath()
  ctx.fillPath()

  // 底部一行小字
  draw(
    "首次打开若被拦截：右键点 FreeBuddy → 打开", size: 11, weight: .regular, color: rgb(146, 150, 162),
    center: CGPoint(x: W / 2, y: 34))

  guard let img = ctx.makeImage() else { fatalError("无法生成位图") }
  return img
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dmg-bg.png"
let image = renderBackground()
let url = URL(fileURLWithPath: out)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
else { fatalError("无法创建输出：\(out)") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("写入失败：\(out)") }
print("已生成 \(out)")
