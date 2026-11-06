#!/usr/bin/env python3
"""Generate app assets from the editable Panecast SVG. Requires rsvg-convert and Pillow."""
from pathlib import Path
import json
import re
import subprocess
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "client/assets"
MARK = ASSETS / "brand/panecast-mark.svg"
IMAGES = ASSETS / "images"
ICON = ASSETS / "panecast.icon"


def render(svg: str, destination: Path, size: int = 1024, opaque: bool = False):
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(destination)],
                   input=svg.encode(), check=True)
    if opaque:
        with Image.open(destination) as image:
            image.convert("RGB").save(destination, optimize=True)


def main():
    mark = MARK.read_text()
    inner = mark[mark.index(">") + 1:mark.rindex("</svg>")]
    background = '''<defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
    <stop stop-color="#24334B"/><stop offset="1" stop-color="#101827"/>
    </linearGradient></defs><rect width="1024" height="1024" fill="url(#background)"/>'''
    full = f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">{background}{inner}</svg>'
    (ASSETS / "brand/panecast-icon.svg").write_text(full + "\n")
    render(full, IMAGES / "icon.png", opaque=True)
    render(full, IMAGES / "favicon.png", size=64, opaque=True)
    render(mark, IMAGES / "splash-icon.png")
    render(mark, IMAGES / "android-icon-foreground.png")
    render(f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">{background}</svg>',
           IMAGES / "android-icon-background.png", opaque=True)
    mono = mark.replace('fill="#172337"', 'fill="none"')
    mono = re.sub(r'#[A-Fa-f0-9]{6}', '#FFFFFF', mono)
    render(mono, IMAGES / "android-icon-monochrome.png")
    (ICON / "Assets").mkdir(parents=True, exist_ok=True)
    (ICON / "Assets/terminal.svg").write_text(mark)
    config = {
        "fill": {"automatic-gradient": "extended-srgb:0.09412,0.13725,0.20784,1.00000"},
        "groups": [{"layers": [{"image-name": "terminal.svg", "name": "Panecast terminal"}],
                    "shadow": {"kind": "neutral", "opacity": 0.35},
                    "translucency": {"enabled": False, "value": 0.5}}],
        "supported-platforms": {"squares": "shared"},
    }
    (ICON / "icon.json").write_text(json.dumps(config, indent=2) + "\n")
    print("Generated iOS, Android, web, and splash assets from", MARK)


if __name__ == "__main__":
    main()
