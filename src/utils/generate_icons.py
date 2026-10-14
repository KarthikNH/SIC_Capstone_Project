"""
Icon Asset Generator for Gridwatch.

Generates high-contrast, crisp transparent PNG and SVG icons for:
- Generator (synchronous turbine symbol)
- Substation (transmission tower / high-voltage node)
- Load (power consumer / distribution branch)
- Transformer (dual magnetic coupling coils)

Saves assets to both `app/public/assets/icons` and `frontend/public/assets/icons`.
"""

import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ICONS = ["generator", "substation", "load", "transformer"]

DESTINATIONS = [
    Path("app/public/assets/icons"),
    Path("frontend/public/assets/icons")
]


def create_svgs():
    svg_defs = {
        "generator": '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <circle cx="64" cy="64" r="54" fill="#2b2b2b" stroke="#ffffff" stroke-width="6"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="#d98a1f" stroke-width="4"/>
  <text x="64" y="78" font-family="Arial, sans-serif" font-size="44" font-weight="900" fill="#ffffff" text-anchor="middle">G</text>
  <path d="M 34 88 Q 49 100 64 88 T 94 88" fill="none" stroke="#ffffff" stroke-width="4"/>
</svg>''',
        "substation": '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <circle cx="64" cy="64" r="54" fill="#2b2b2b" stroke="#ffffff" stroke-width="6"/>
  <!-- Substation / Tower Pylon -->
  <polygon points="64,24 88,96 40,96" fill="none" stroke="#ffffff" stroke-width="6"/>
  <line x1="48" y1="62" x2="80" y2="62" stroke="#ffffff" stroke-width="5"/>
  <line x1="32" y1="42" x2="96" y2="42" stroke="#ffffff" stroke-width="5"/>
  <line x1="64" y1="24" x2="64" y2="96" stroke="#d98a1f" stroke-width="3"/>
  <circle cx="64" cy="24" r="5" fill="#d98a1f"/>
  <circle cx="32" cy="42" r="4" fill="#d98a1f"/>
  <circle cx="96" cy="42" r="4" fill="#d98a1f"/>
</svg>''',
        "load": '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <circle cx="64" cy="64" r="54" fill="#2b2b2b" stroke="#ffffff" stroke-width="6"/>
  <!-- Power Load / Downward Demand Arrow -->
  <polygon points="64,98 34,54 50,54 50,30 78,30 78,54 94,54" fill="#d98a1f" stroke="#ffffff" stroke-width="4"/>
  <circle cx="64" cy="64" r="44" fill="none" stroke="#8a7767" stroke-width="3" stroke-dasharray="6,4"/>
</svg>''',
        "transformer": '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <circle cx="64" cy="64" r="54" fill="#2b2b2b" stroke="#ffffff" stroke-width="6"/>
  <!-- Interlocking Coils -->
  <circle cx="50" cy="64" r="24" fill="none" stroke="#ffffff" stroke-width="6"/>
  <circle cx="78" cy="64" r="24" fill="none" stroke="#d98a1f" stroke-width="6"/>
</svg>'''
    }
    return svg_defs


def create_pngs():
    """Create transparent crisp 256x256 PNG textures for Three.js billboard sprites."""
    png_images = {}
    size = (256, 256)

    # 1. Generator PNG
    img_gen = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img_gen)
    # Outer circle
    d.ellipse([16, 16, 240, 240], fill=(35, 38, 41, 255), outline=(255, 255, 255, 255), width=12)
    # Inner gold ring
    d.ellipse([34, 34, 222, 222], fill=None, outline=(217, 138, 31, 255), width=8)
    # Large G
    d.arc([75, 75, 181, 181], start=40, end=320, fill=(255, 255, 255, 255), width=20)
    d.line([128, 128, 175, 128], fill=(255, 255, 255, 255), width=20)
    d.line([175, 128, 175, 170], fill=(255, 255, 255, 255), width=20)
    png_images["generator"] = img_gen

    # 2. Substation PNG
    img_sub = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img_sub)
    d.ellipse([16, 16, 240, 240], fill=(35, 38, 41, 255), outline=(255, 255, 255, 255), width=12)
    # Inner ring
    d.ellipse([34, 34, 222, 222], fill=None, outline=(138, 119, 103, 255), width=6)
    # Pylon legs
    d.polygon([(128, 45), (180, 200), (76, 200)], outline=(255, 255, 255, 255), fill=None)
    d.line([(128, 45), (180, 200)], fill=(255, 255, 255, 255), width=12)
    d.line([(128, 45), (76, 200)], fill=(255, 255, 255, 255), width=12)
    d.line([(76, 200), (180, 200)], fill=(255, 255, 255, 255), width=12)
    d.line([(96, 130), (160, 130)], fill=(255, 255, 255, 255), width=10)
    d.line([(55, 88), (201, 88)], fill=(255, 255, 255, 255), width=10)
    d.line([(128, 45), (128, 200)], fill=(217, 138, 31, 255), width=8)
    png_images["substation"] = img_sub

    # 3. Load PNG
    img_load = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img_load)
    d.ellipse([16, 16, 240, 240], fill=(35, 38, 41, 255), outline=(255, 255, 255, 255), width=12)
    d.ellipse([34, 34, 222, 222], fill=None, outline=(138, 119, 103, 255), width=6)
    # Arrow down
    arrow_poly = [
        (128, 205),
        (65, 120),
        (98, 120),
        (98, 60),
        (158, 60),
        (158, 120),
        (191, 120)
    ]
    d.polygon(arrow_poly, fill=(217, 138, 31, 255), outline=(255, 255, 255, 255))
    png_images["load"] = img_load

    # 4. Transformer PNG
    img_trafo = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img_trafo)
    d.ellipse([16, 16, 240, 240], fill=(35, 38, 41, 255), outline=(255, 255, 255, 255), width=12)
    d.ellipse([50, 78, 150, 178], fill=None, outline=(255, 255, 255, 255), width=12)
    d.ellipse([106, 78, 206, 178], fill=None, outline=(217, 138, 31, 255), width=12)
    png_images["transformer"] = img_trafo

    return png_images


def main():
    svgs = create_svgs()
    pngs = create_pngs()

    for dest in DESTINATIONS:
        dest.mkdir(parents=True, exist_ok=True)
        # Write SVGs
        for name, svg_text in svgs.items():
            svg_file = dest / f"{name}.svg"
            with open(svg_file, "w", encoding="utf-8") as f:
                f.write(svg_text)
        # Write PNGs
        for name, img in pngs.items():
            png_file = dest / f"{name}.png"
            img.save(png_file, format="PNG")
        print(f"Generated icons in {dest}")


if __name__ == "__main__":
    main()
