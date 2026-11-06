#!/usr/bin/env python3
"""Compose App Store artwork around real, unmodified simulator captures."""
from pathlib import Path
import json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / "store/screenshots"
CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
LATIN = "/System/Library/Fonts/Avenir Next.ttc"
SCENES = [
    ("terminal", "远程终端", ["桌面之外，", "终端仍在手边。"], "查看输出、发送命令，接着处理手头的事。", "#B5E890"),
    ("workspaces", "工作区管理", ["多个工作区，", "一眼找到现场。"], "工作区和终端集中管理，切换轻松顺手。", "#A6D9FF"),
    ("inbox", "通知收件箱", ["任务有消息，", "回到对应终端。"], "查看任务通知，点一下继续处理。", "#C5AFF7"),
    ("settings", "输入与显示", ["输入怎么顺手，", "就怎么设置。"], "字号、实时行数和辅助键，由你决定。", "#B5E890"),
]


def font(size, bold=False, latin=False):
    return ImageFont.truetype(LATIN if latin else CJK, round(size), index=0 if latin or not bold else 2)


def make(width, height, device, scene, number):
    key, label, title, subtitle, accent = scene
    image = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(image)
    for y in range(height):
        t = y / height
        draw.line((0, y, width, y), fill=(round(25 - 12 * t), round(34 - 14 * t), round(51 - 18 * t)))
    margin = round(width * 0.075)
    # Small wordmark and a single feature headline keep the real app central.
    mark = Image.open(ROOT / "client/assets/images/splash-icon.png").convert("RGBA")
    logo_size = round(width * 0.073)
    mark = mark.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
    image.paste(mark, (margin - round(width * .014), round(height * .025)), mark)
    draw.text((margin + logo_size * .85, height * .033), "Panecast", font=font(width * .034, latin=True), fill="#F0F3FF")
    draw.text((width - margin, height * .035), "iPad" if device == "ipad" else "iPhone", font=font(width * .022, latin=True), fill="#96A5C0", anchor="rt")
    draw.text((margin, height * .083), f"0{number}  /  {label}", font=font(width * .024), fill=accent)
    title_font = font(width * (.064 if device == "ipad" else .072), bold=True)
    line_height = width * (.084 if device == "ipad" else .092)
    title_y = height * .112
    for i, line in enumerate(title):
        assert draw.textlength(line, font=title_font) <= width - 2 * margin
        draw.text((margin, title_y + i * line_height), line, font=title_font, fill="#F2F4FC" if i == 0 else accent)
    subtitle_font = font(width * (.023 if device == "ipad" else .026))
    assert draw.textlength(subtitle, font=subtitle_font) <= width - 2 * margin
    draw.text((margin, title_y + 2 * line_height + height * .009), subtitle, font=subtitle_font, fill="#B0BCD2")

    source = Image.open(STORE / "raw" / device / f"{key}.png").convert("RGB")
    screen_width = round(width * (.66 if device == "ipad" else .71))
    screen_height = round(screen_width * source.height / source.width)
    left = (width - screen_width) // 2
    top = round(height * (.29 if device == "ipad" else .245))
    bezel = round(width * .012)
    radius = round(screen_width * (.035 if device == "ipad" else .105))
    outer = (left - bezel, top - bezel, left + screen_width + bezel, top + screen_height + bezel)
    shadow = Image.new("RGBA", image.size)
    ImageDraw.Draw(shadow).rounded_rectangle((outer[0] - 8, outer[1] + 16, outer[2] + 8, outer[3] + 35), radius=radius + bezel, fill=(0, 0, 0, 135))
    shadow = shadow.filter(ImageFilter.GaussianBlur(round(width * .023)))
    image.paste(shadow, (0, 0), shadow)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(outer, radius=radius + bezel, fill="#080D15", outline="#53627B", width=max(2, round(width * .002)))
    screen = source.resize((screen_width, screen_height), Image.Resampling.LANCZOS)
    mask = Image.new("L", screen.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, screen_width, screen_height), radius=radius, fill=255)
    image.paste(screen, (left, top), mask)
    assert top + screen_height + bezel < height * .979
    draw.text((width / 2, height * .98), "应用内演示 · 实际界面", font=font(width * .018), fill="#8997AF", anchor="mm")
    return image


def main():
    groups = [
        ("iphone", 1206, 2622, "IPHONE_DYNAMIC_ISLAND_MEDIUM_DISPLAY", "IPHONE_APP_STORE", "iphone"),
        ("iphone-large", 1320, 2868, "IPHONE_DYNAMIC_ISLAND_LARGE_DISPLAY", "IPHONE_APP_STORE", "iphone"),
        ("ipad", 2064, 2752, "IPAD_13_DISPLAY", "IPAD_APP_STORE", "ipad"),
    ]
    manifest = {"locale": "zh-Hans", "groups": []}
    for folder, width, height, display, platform, device in groups:
        out = STORE / "zh-Hans" / folder
        out.mkdir(parents=True, exist_ok=True)
        files = []
        for i, scene in enumerate(SCENES, 1):
            path = out / f"panecast-{i:02}-{scene[0]}.png"
            make(width, height, device, scene, i).save(path, optimize=True)
            files.append(str(path.relative_to(ROOT)))
        manifest["groups"].append({"displayClass": display, "platform": platform, "width": width, "height": height, "files": files})
    (STORE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    previews = []
    for file in manifest["groups"][0]["files"]:
        preview = Image.open(ROOT / file)
        preview.thumbnail((300, 652))
        previews.append(preview)
    board = Image.new("RGB", (1260, 712), "#0D1421")
    for i, preview in enumerate(previews): board.paste(preview, (15 + i * 310, 30))
    board.save(STORE / "overview.png")
    print("Rendered 12 screenshots in 3 Apple-validated sizes.")


if __name__ == "__main__":
    main()
