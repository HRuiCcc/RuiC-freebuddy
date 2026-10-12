// FreeBuddy 应用图标生成器。
// 用 CoreGraphics 程序化画一枚 1024×1024 的 macOS 风格图标，再交给 iconutil 转成 .icns。
// 配色沿用面板自身的品牌 token（--fb-accent #5b5bd6 / 深色档 #8b8bff）。
import AppKit
import CoreGraphics
import Foundation
import ImageIO

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
}

func renderIcon() -> CGImage {
  let S: CGFloat = 1024
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard
    let ctx = CGContext(
      data: nil, width: Int(S), height: Int(S), bitsPerComponent: 8, bytesPerRow: 0,
      space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { fatalError("无法创建绘图上下文") }

  // macOS 图标惯例：四周留白约 10%，圆角半径约为边长的 22.5%
  let inset: CGFloat = 92
  let squircle = CGRect(x: inset, y: inset, width: S - inset * 2, height: S - inset * 2)
  let radius: CGFloat = squircle.width * 0.225
  let shape = CGPath(roundedRect: squircle, cornerWidth: radius, cornerHeight: radius, transform: nil)

  // ── 1) 投影（让图标从背景里浮起来） ──
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 40, color: rgb(16, 18, 24, 0.32))
  ctx.addPath(shape)
  ctx.setFillColor(rgb(91, 91, 214))
  ctx.fillPath()
  ctx.restoreGState()

  // ── 2) 主体靛蓝渐变（上浅下深，对应面板主色的两个档） ──
  ctx.saveGState()
  ctx.addPath(shape)
  ctx.clip()
  let grad = CGGradient(
    colorsSpace: colorSpace,
    colors: [rgb(122, 122, 232), rgb(74, 74, 190), rgb(56, 56, 158)] as CFArray,
    locations: [0, 0.55, 1])!
  ctx.drawLinearGradient(
    grad,
    start: CGPoint(x: squircle.minX, y: squircle.maxY),
    end: CGPoint(x: squircle.maxX, y: squircle.minY),
    options: [])
  // 顶部一道柔和高光，避免大色块发闷
  let gloss = CGGradient(
    colorsSpace: colorSpace,
    colors: [rgb(255, 255, 255, 0.20), rgb(255, 255, 255, 0)] as CFArray,
    locations: [0, 1])!
  ctx.drawLinearGradient(
    gloss,
    start: CGPoint(x: 0, y: squircle.maxY),
    end: CGPoint(x: 0, y: squircle.midY),
    options: [])
  ctx.restoreGState()

  // ── 3) 白色 F 字标 ──
  // 三笔结构：竖笔 + 上横（最长）+ 中横（短），笔宽一致；下横留白，这样小尺寸下也认得出是 F。
  let barW: CGFloat = 148
  let barH: CGFloat = 138
  let stemX: CGFloat = 336
  let stemTop: CGFloat = 692
  let stemBottom: CGFloat = 332
  let armRight: CGFloat = 688
  let midRight: CGFloat = 620
  let midY: CGFloat = 512

  let barRect = { (x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGPath in
    let r = min(w, h) / 2
    return CGPath(
      roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r,
      transform: nil)
  }

  // 三笔先加起来当成一个整体，只投一次影 —— 逐笔投会叠出「一摞药丸」的错位感
  let glyph = CGMutablePath()
  glyph.addPath(barRect(stemX, stemBottom, barW, stemTop - stemBottom))  // 竖笔
  glyph.addPath(barRect(stemX, stemTop - barH, armRight - stemX, barH))  // 上横
  glyph.addPath(barRect(stemX, midY - barH / 2, midRight - stemX, barH))  // 中横

  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 26, color: rgb(20, 20, 60, 0.30))
  ctx.addPath(glyph)
  ctx.setFillColor(rgb(255, 255, 255))
  ctx.fillPath()
  ctx.restoreGState()

  // ── 4) 右上角一枚信号点：FreeBuddy 的「增强/在线」标记（补上 F 右侧上方的空缺） ──
  let dotR: CGFloat = 60
  let dotCenter = CGPoint(x: 748, y: 748)
  let dotGrad = CGGradient(
    colorsSpace: colorSpace,
    colors: [rgb(199, 199, 255), rgb(139, 139, 255)] as CFArray,
    locations: [0, 1])!
  ctx.saveGState()
  ctx.addEllipse(
    in: CGRect(x: dotCenter.x - dotR, y: dotCenter.y - dotR, width: dotR * 2, height: dotR * 2))
  ctx.clip()
  ctx.drawLinearGradient(
    dotGrad,
    start: CGPoint(x: dotCenter.x - dotR, y: dotCenter.y + dotR),
    end: CGPoint(x: dotCenter.x + dotR, y: dotCenter.y - dotR),
    options: [])
  ctx.restoreGState()

  guard let image = ctx.makeImage() else { fatalError("无法生成位图") }
  return image
}

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon_1024.png"
let image = renderIcon()
let url = URL(fileURLWithPath: outPath)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
else { fatalError("无法创建输出文件：\(outPath)") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("写入失败：\(outPath)") }
print("已生成 \(outPath)")
