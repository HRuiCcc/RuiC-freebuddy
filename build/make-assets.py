# -*- coding: utf-8 -*-
"""FreeBuddy brand assets -- drawn programmatically with Pillow (no Codex, no network).

Outputs (all under build/):
  icon.png            1024x1024 app icon
  icon-256.png        256x256 (electron-builder needs >=256 px)
  icon.ico            multi-size Windows icon
  installerSidebar.bmp 164x314  classic installer welcome/finish panel (logo + wordmark)
  installerHeader.bmp  150x57   installer header strip (logo + product name)
  logo-preview.png    1280x720  preview sheet for the user

Mark: indigo rounded tile + white speech bubble + amber bolt  ("buddy talk" + "boost").
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))

ACCENT_TOP = (122, 122, 244)
ACCENT_BOT = (75, 70, 198)
WHITE = (255, 255, 255)
AMBER = (245, 165, 36)
INK = (22, 24, 29)

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_CJK_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"


def font(path, size):
    for p in (path, FONT_BOLD, FONT_REG):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def gradient(size, top, bot):
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(int(round(top[i] + (bot[i] - top[i]) * t)) for i in range(3))
    return img.resize((w, h), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


BOLT = [
    (0.10, -0.56), (-0.30, 0.06), (-0.03, 0.06),
    (-0.13, 0.56), (0.30, -0.08), (0.02, -0.08),
]


def draw_bubble_and_bolt(d, cx, cy, s, bubble_fill=WHITE, bolt_fill=AMBER):
    """Speech bubble of width ~s centred at (cx, cy), bolt inside."""
    bw, bh = s, s * 0.82
    cy = cy - s * 0.04
    x0, y0 = cx - bw / 2, cy - bh / 2
    x1, y1 = cx + bw / 2, cy + bh / 2
    r = s * 0.245
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=bubble_fill)
    # tail (bottom-left), tucked under the bubble's rounded corner
    tx0 = cx - s * 0.30
    d.polygon([(tx0, y1 - r * 1.1), (tx0 - s * 0.05, y1 + s * 0.25), (tx0 + s * 0.26, y1 - r * 0.85)], fill=bubble_fill)
    pts = [(cx + px * s * 0.62, cy - s * 0.01 + py * s * 0.62) for px, py in BOLT]
    d.polygon(pts, fill=bolt_fill)


def make_app_icon(size=1024):
    S = size
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    g = gradient((S, S), ACCENT_TOP, ACCENT_BOT).convert("RGBA")
    mask = rounded_mask((S, S), int(S * 0.225))
    icon.paste(g, (0, 0), mask)
    d = ImageDraw.Draw(icon)
    # soft top-left highlight, blurred so it never shows a hard seam
    hl = Image.new("L", (S, S), 0)
    ImageDraw.Draw(hl).ellipse([-S * 0.55, -S * 1.05, S * 0.95, S * 0.30], fill=30)
    hl = hl.filter(ImageFilter.GaussianBlur(S * 0.06))
    icon.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), (0, 0),
               Image.composite(hl, Image.new("L", (S, S), 0), mask))
    draw_bubble_and_bolt(d, S * 0.50, S * 0.49, S * 0.60)
    return icon


def make_sidebar():
    W, H = 164, 314
    img = gradient((W, H), ACCENT_TOP, ACCENT_BOT).convert("RGBA")
    d = ImageDraw.Draw(img)
    # bottom vignette
    for i in range(90):
        a = int(52 * (i / 90.0))
        d.rectangle([0, H - 90 + i, W, H - 89 + i], fill=(0, 0, 0, a))
    mark = make_app_icon(512).resize((92, 92), Image.LANCZOS)
    img.alpha_composite(mark, ((W - 92) // 2, 40))
    f_name = font(FONT_BOLD, 25)
    f_tag = font(FONT_REG, 12)
    f_foot = font(FONT_REG, 11)
    d.text((W / 2 + 1, 151), "FreeBuddy", font=f_name, fill=(12, 12, 22, 120), anchor="ma")
    d.text((W / 2, 150), "FreeBuddy", font=f_name, fill=WHITE, anchor="ma")
    d.line([(W / 2 - 34, 186), (W / 2 + 34, 186)], fill=(255, 255, 255, 90), width=1)
    d.text((W / 2, 200), "WorkBuddy 增强面板", font=f_tag, fill=(236, 236, 252, 235), anchor="ma")
    d.text((W / 2, 220), "多账号 · 积分签到 · 用量统计", font=f_foot, fill=(214, 214, 246, 210), anchor="ma")
    d.text((W / 2, H - 34), "本机运行 · 不上传数据", font=f_foot, fill=(214, 214, 246, 200), anchor="ma")
    img.convert("RGB").save(os.path.join(HERE, "installerSidebar.bmp"), "BMP")
    return img


def make_header():
    W, H = 150, 57
    img = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    mark = make_app_icon(256).resize((40, 40), Image.LANCZOS)
    img.alpha_composite(mark, (6, (H - 40) // 2))
    f = font(FONT_BOLD, 17)
    d.text((54, H / 2 + 1), "FreeBuddy", font=f, fill=(232, 232, 240, 255), anchor="lm")
    d.text((54, H / 2), "FreeBuddy", font=f, fill=(38, 36, 92, 255), anchor="lm")
    d.line([(0, H - 1), (W, H - 1)], fill=(226, 228, 236, 255), width=1)
    img.convert("RGB").save(os.path.join(HERE, "installerHeader.bmp"), "BMP")
    return img


def make_tray(size=32):
    icon = make_app_icon(256).resize((size, size), Image.LANCZOS)
    icon.save(os.path.join(HERE, "tray.png"))
    return icon


def make_preview():
    W, H = 1280, 720
    img = Image.new("RGB", (W, H), (247, 248, 251))
    for x in range(W):
        t = x / (W - 1)
        img.paste(tuple(int(244 - 6 * t) for _ in range(3)), (x, 0, x + 1, H))
    d = ImageDraw.Draw(img)
    big = make_app_icon(512)
    img.paste(big, (96, 118), big)
    sizes = [128, 64, 48, 32, 16]
    x = 690
    y = 150
    for s in sizes:
        ic = make_app_icon(256).resize((s, s), Image.LANCZOS)
        img.paste(ic, (x, y + (128 - s) // 2), ic)
        x += s + 26
    f_h = font(FONT_CJK_BOLD, 44)
    f_s = font(FONT_REG, 19)
    d.text((690, 300), "FreeBuddy", font=f_h, fill=(28, 28, 66))
    d.text((690, 358), "WorkBuddy 增强面板 · 本机运行", font=f_s, fill=(96, 98, 116))
    d.text((690, 388), "多账号秒切 · 跨账号积分签到 · Token 用量热力图", font=f_s, fill=(96, 98, 116))
    f_f = font(FONT_REG, 16)
    d.text((98, 660), "应用图标 · 安装页侧栏 · 页眉标识 · 托盘（同源绘制）", font=f_f, fill=(124, 126, 142))
    img.save(os.path.join(HERE, "logo-preview.png"))
    return img


def main():
    icon = make_app_icon(1024)
    icon.save(os.path.join(HERE, "icon.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "icon-256.png"))
    icon.save(os.path.join(HERE, "icon.ico"),
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    make_sidebar()
    make_header()
    make_tray()
    make_preview()

    # 运行时用的副本（打进 app 里，供窗口图标 / 托盘 / 关于页使用）
    assets = os.path.join(os.path.dirname(HERE), "desktop", "assets")
    os.makedirs(assets, exist_ok=True)
    icon.save(os.path.join(assets, "icon.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(assets, "icon-256.png"))
    icon.resize((32, 32), Image.LANCZOS).save(os.path.join(assets, "tray.png"))
    print("assets written to", HERE, "and", assets)


if __name__ == "__main__":
    main()
