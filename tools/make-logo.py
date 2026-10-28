#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成产品 logo（assets/logo.png）。

⚠️ 这是**开发期构建脚本**，不属于运行时依赖链：
   装机链路仍然零第三方依赖（不依赖 python3），本脚本只在改品牌时手工跑一次。
   产物已随包提交，目标机不需要执行它。

用法：
    python tools/make-logo.py                 # 生成 assets/logo.png
    python tools/make-logo.py --scale 3       # 生成 3 倍图（印刷用）

设计：
   · 左侧徽标 = 圆角方章（蓝→青渐变）+ 白色盾牌 + 蓝色脉冲线
     —— 盾=只读防护，脉冲=诊断；两笔就说完「安全 + 运维」。
   · 右侧字标 = 小安 / soc-agent / 副行 / GitHub 地址
   · 白底不透明：进文档、进 PPT、进 IM 都不会变黑底。
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# ── 品牌色（与 tools/patcher.mjs 里的 ANSI 渐变同源）──
INK = (22, 33, 44)
SUB = (90, 102, 117)
LINK = (30, 111, 217)
GRAD_TOP = (30, 111, 217)
GRAD_BOTTOM = (20, 163, 139)
WHITE = (255, 255, 255)

NAME_CN = "小安"
NAME_EN = "soc-agent"
TAGLINE = "安全运维智能体 · 只读诊断 · 全程可审计"
REPO = "github.com/hughliat/soc-agent"

FONT_CANDIDATES = {
    "cn_bold": [r"C:\Windows\Fonts\msyhbd.ttc", "/System/Library/Fonts/PingFang.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"],
    "cn": [r"C:\Windows\Fonts\msyh.ttc", "/System/Library/Fonts/PingFang.ttc",
           "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"],
    "mono": [r"C:\Windows\Fonts\consolab.ttf", "/System/Library/Fonts/Menlo.ttc",
             "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
    "mono_r": [r"C:\Windows\Fonts\consola.ttf", "/System/Library/Fonts/Menlo.ttc",
               "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"],
}


def load(kind, size):
    for p in FONT_CANDIDATES[kind]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    sys.exit(f"找不到可用字体：{kind}（请在 FONT_CANDIDATES 里补一个本机字体路径）")


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def gradient(size, top, bottom):
    g = Image.new("RGB", (1, size), top)
    d = ImageDraw.Draw(g)
    for y in range(size):
        t = y / max(size - 1, 1)
        d.point((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))


def badge(size, radius_ratio=0.23):
    """圆角方章 + 白盾 + 脉冲线。"""
    S = size
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = rounded_mask(S, int(S * radius_ratio))
    out.paste(gradient(S, GRAD_TOP, GRAD_BOTTOM), (0, 0), mask)

    d = ImageDraw.Draw(out)
    # 盾牌（几何多边形，不依赖字体）
    cx = S * 0.5
    top = S * 0.235
    sh_w = S * 0.235          # 半宽
    shoulder = S * 0.33
    waist = S * 0.545
    tip = S * 0.775
    shield = [
        (cx, top),
        (cx + sh_w, shoulder),
        (cx + sh_w, waist),
        (cx, tip),
        (cx - sh_w, waist),
        (cx - sh_w, shoulder),
    ]
    d.polygon(shield, fill=WHITE + (255,))

    # 脉冲线（诊断）——画在盾内，用章体的蓝色
    lw = max(int(S * 0.036), 3)
    wave = [
        (cx - S * 0.135, S * 0.475),
        (cx - S * 0.055, S * 0.475),
        (cx - S * 0.015, S * 0.395),
        (cx + S * 0.045, S * 0.565),
        (cx + S * 0.085, S * 0.475),
        (cx + S * 0.135, S * 0.475),
    ]
    d.line(wave, fill=GRAD_TOP + (255,), width=lw, joint="curve")
    for pt in (wave[0], wave[-1]):
        d.ellipse([pt[0] - lw / 2, pt[1] - lw / 2, pt[0] + lw / 2, pt[1] + lw / 2],
                  fill=GRAD_TOP + (255,))
    return out


def build(scale=2):
    S = 128 * scale                      # 徽标边长
    pad = 10 * scale
    canvas_w, canvas_h = 560 * scale, 150 * scale
    img = Image.new("RGBA", (canvas_w, canvas_h), WHITE + (255,))
    img.alpha_composite(badge(S), (pad, (canvas_h - S) // 2))

    d = ImageDraw.Draw(img)
    x = pad + S + int(24 * scale)
    f_cn = load("cn_bold", int(52 * scale))
    f_en = load("mono", int(25 * scale))
    f_tag = load("cn", int(16 * scale))
    f_repo = load("mono_r", int(14 * scale))

    d.text((x, int(20 * scale)), NAME_CN, font=f_cn, fill=INK + (255,))
    cn_w = d.textlength(NAME_CN, font=f_cn)
    d.text((x + cn_w + int(12 * scale), int(38 * scale)), NAME_EN, font=f_en, fill=(58, 74, 92, 255))
    d.text((x, int(84 * scale)), TAGLINE, font=f_tag, fill=SUB + (255,))
    d.text((x, int(112 * scale)), REPO, font=f_repo, fill=LINK + (255,))

    bbox = img.convert("RGB").getbbox()
    img = img.crop((0, 0, min(bbox[2] + pad, canvas_w), canvas_h))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=2, help="缩放倍数，默认 2（@2x）")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "assets", "logo.png"))
    a = ap.parse_args()

    img = build(a.scale)
    out = os.path.abspath(a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, "PNG", optimize=True)
    print(f"已生成 {out}（{img.width}×{img.height}）")


if __name__ == "__main__":
    main()
