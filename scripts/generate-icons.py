#!/usr/bin/env python3
"""Regenerate platform packaging icons from the master art.

Source : build/icon-dark.png  (priority icon, app-styled: navy bg, rounded corners)
Outputs:
  - build/icon.ico                  Windows  (multi-size: 16..256)
  - build/fetchpier-icon-macos.icns macOS    (16..1024)
  - build/fetchpier-icon-linux.png  Linux    (512x512)

Usage: python scripts/generate-icons.py
Requires: Pillow (PIL).

Note: no packaging target supports OS dark/light icon switching, so icon-light.png
is intentionally not consumed here.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
SRC = BUILD / "icon-dark.png"

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
LINUX_SIZE = 512


def load_master() -> Image.Image:
    if not SRC.exists():
        raise SystemExit(f"Source not found: {SRC}")
    im = Image.open(SRC).convert("RGBA")
    if im.width != im.height:
        raise SystemExit(f"Source must be square, got {im.size}")
    return im


def gen_ico(master: Image.Image) -> None:
    out = BUILD / "icon.ico"
    master.save(out, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print(f"  ok  {out.name}  ({', '.join(str(s) for s in ICO_SIZES)})")


def gen_icns(master: Image.Image) -> None:
    out = BUILD / "fetchpier-icon-macos.icns"
    # Pillow builds the icns from a 1024 master and the requested sizes.
    base = master.resize((1024, 1024), Image.LANCZOS)
    base.save(out, format="ICNS", sizes=[(s, s) for s in ICNS_SIZES])
    print(f"  ok  {out.name}  ({', '.join(str(s) for s in ICNS_SIZES)})")


def gen_linux(master: Image.Image) -> None:
    out = BUILD / "fetchpier-icon-linux.png"
    master.resize((LINUX_SIZE, LINUX_SIZE), Image.LANCZOS).save(out, format="PNG")
    print(f"  ok  {out.name}  ({LINUX_SIZE}x{LINUX_SIZE})")


def main() -> None:
    master = load_master()
    print(f"Source: {SRC.name} {master.size}")
    gen_ico(master)
    gen_icns(master)
    gen_linux(master)
    print("Done.")


if __name__ == "__main__":
    main()
