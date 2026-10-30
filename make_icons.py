"""生成扩展图标：蓝底圆角方块 + 白色「译」字。"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "icons")
os.makedirs(OUT, exist_ok=True)

S = 512
SS = 4  # 超采样倍数

# 对角渐变 #5AA2FF -> #2E6FE8
w = S * SS
yy, xx = np.mgrid[0:w, 0:w]
t = (xx + yy) / (2 * w)
c1 = np.array([90, 168, 255], dtype=float)
c2 = np.array([40, 100, 224], dtype=float)
rgb = (c1[None, None, :] * (1 - t[..., None]) + c2[None, None, :] * t[..., None]).astype(np.uint8)

img = Image.fromarray(rgb, "RGB").convert("RGBA")

# 圆角遮罩
mask = Image.new("L", (w, w), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, w - 1], radius=int(w * 0.225), fill=255)
img.putalpha(mask)

draw = ImageDraw.Draw(img)

draw = ImageDraw.Draw(img)
font = None
for path, idx in [
    (r"C:\Windows\Fonts\msyhbd.ttc", 0),
    (r"C:\Windows\Fonts\msyh.ttc", 0),
    (r"C:\Windows\Fonts\simhei.ttf", 0),
]:
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, int(w * 0.56), index=idx)
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()

text = "译"
box = draw.textbbox((0, 0), text, font=font)
tw, th = box[2] - box[0], box[3] - box[1]
x = (w - tw) / 2 - box[0]
y = (w - th) / 2 - box[1] - w * 0.045
draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

img = img.resize((S, S), Image.LANCZOS)
for size in (128, 48, 32, 16):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))
print("icons ->", OUT)
