from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "build"
OUTPUT.mkdir(exist_ok=True)

size = 1024
canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((82, 100, 942, 960), radius=218, fill=(0, 0, 0, 115))
canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(34)))

gradient = Image.new("RGBA", canvas.size)
pixels = gradient.load()
mint = (117, 222, 180)
blue = (104, 168, 255)
for y in range(size):
    for x in range(size):
        mix = min(1.0, max(0.0, (x + y) / (size * 2)))
        pixels[x, y] = tuple(round(mint[channel] * (1 - mix) + blue[channel] * mix) for channel in range(3)) + (255,)

mask = Image.new("L", canvas.size, 0)
ImageDraw.Draw(mask).rounded_rectangle((62, 62, 962, 962), radius=224, fill=255)
canvas.alpha_composite(Image.composite(gradient, Image.new("RGBA", canvas.size), mask))

shine = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
ImageDraw.Draw(shine).ellipse((-110, -350, 850, 590), fill=(255, 255, 255, 38))
canvas.alpha_composite(Image.composite(shine, Image.new("RGBA", canvas.size), mask))

font_path = Path("C:/Windows/Fonts/msyhbd.ttc")
font = ImageFont.truetype(str(font_path), 570)
draw = ImageDraw.Draw(canvas)
bounds = draw.textbbox((0, 0), "联", font=font)
text_width = bounds[2] - bounds[0]
text_height = bounds[3] - bounds[1]
position = ((size - text_width) / 2 - bounds[0], (size - text_height) / 2 - bounds[1] - 16)
draw.text((position[0] + 7, position[1] + 12), "联", font=font, fill=(4, 20, 22, 62))
draw.text(position, "联", font=font, fill=(7, 26, 27, 238))

canvas.save(OUTPUT / "icon.png", optimize=True)
canvas.save(OUTPUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
