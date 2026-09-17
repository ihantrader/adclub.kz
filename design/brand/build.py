"""Build Asia Drive Club brand SVGs (DES-2) from Onest glyph outlines.

The AD / CLUB lockup is drawn from font outlines (no font needed to display it).
The rule and the word CLUB span exactly the ink width of AD.

Usage: python design/brand/build.py   (needs fonttools and brotli; downloads Onest from Google Fonts)
"""
import io
import re
import urllib.request
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT = Path(__file__).parent
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"}

GRAPHITE = "#0F1012"
CHAMPAGNE = "#D4B483"
IVORY = "#F6F3EC"
WHITE = "#FFFFFF"

# Proportions relative to the AD cap height (approved: version 1, "thin CLUB")
H_AD = 300.0
GAP1 = 0.16  # AD baseline -> rule top
RULE = 0.055  # rule thickness
GAP2 = 0.16  # rule bottom -> CLUB cap top
H_CLUB = 0.27  # CLUB cap height


def load_onest(weight):
    css = urllib.request.urlopen(
        urllib.request.Request(f"https://fonts.googleapis.com/css2?family=Onest:wght@{weight}", headers=UA)
    ).read().decode()
    url = re.search(r"/\* latin \*/[^}]*?url\((https://[^)]+)\)", css).group(1)
    return TTFont(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers=UA)).read()))


BOLD = load_onest(800)
MEDIUM = load_onest(500)


def fmt(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def glyph(font, ch):
    gs = font.getGlyphSet()
    name = font.getBestCmap()[ord(ch)]
    pen = BoundsPen(gs)
    gs[name].draw(pen)
    return gs, name, pen.bounds


def outline(font, ch, scale, dx, baseline):
    gs, name, _ = glyph(font, ch)
    pen = SVGPathPen(gs, ntos=fmt)
    gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, dx, baseline)))
    return pen.getCommands()


def cap_height(font):
    return font["OS/2"].sCapHeight


def build_ad():
    scale = H_AD / cap_height(BOLD)
    _, a_name, a = glyph(BOLD, "A")
    _, _, d = glyph(BOLD, "D")
    xa = -a[0] * scale
    xd = xa + BOLD["hmtx"][a_name][0] * scale
    path = outline(BOLD, "A", scale, xa, H_AD) + " " + outline(BOLD, "D", scale, xd, H_AD)
    return path, xd + d[2] * scale


AD_PATH, WIDTH = build_ad()


def build_club():
    rule_top = H_AD * (1 + GAP1)
    rule_bottom = rule_top + RULE * H_AD
    parts = [f"M0 {fmt(rule_top)}H{fmt(WIDTH)}V{fmt(rule_bottom)}H0Z"]
    scale = H_CLUB * H_AD / cap_height(MEDIUM)
    baseline = rule_bottom + (GAP2 + H_CLUB) * H_AD
    letters = [(ch, glyph(MEDIUM, ch)[2]) for ch in "CLUB"]
    inks = [(b[2] - b[0]) * scale for _, b in letters]
    gap = (WIDTH - sum(inks)) / (len(letters) - 1)
    cursor = 0.0
    for (ch, b), ink in zip(letters, inks):
        parts.append(outline(MEDIUM, ch, scale, cursor - b[0] * scale, baseline))
        cursor += ink + gap
    return " ".join(parts), baseline


CLUB_PATH, HEIGHT = build_club()
LOCKUP_PATH = AD_PATH + " " + CLUB_PATH


def svg(view_w, view_h, body, title):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(view_w)} {fmt(view_h)}" role="img">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def placed(path, w, h, color, canvas, fraction):
    """Path of size w x h scaled to `fraction` of canvas width (limited by height) and centered."""
    k = min(canvas * fraction / w, canvas * fraction / h)
    tx, ty = (canvas - w * k) / 2, (canvas - h * k) / 2
    return f'<path fill="{color}" transform="translate({fmt(tx)} {fmt(ty)}) scale({k:.5f})" d="{path}"/>'


def write(name, content):
    (OUT / name).write_text(content, encoding="utf-8")
    print("wrote", name)


TITLE = "Asia Drive Club"

# Logo: AD / CLUB lockup and the AD-only mark for small sizes
for suffix, color in (("champagne", CHAMPAGNE), ("graphite", GRAPHITE), ("white", WHITE)):
    write(f"logo-{suffix}.svg", svg(WIDTH, HEIGHT, f'<path fill="{color}" d="{LOCKUP_PATH}"/>', TITLE))
    write(f"mark-ad-{suffix}.svg", svg(WIDTH, H_AD, f'<path fill="{color}" d="{AD_PATH}"/>', TITLE))

# iOS / store icon: full-bleed square, the system applies the mask
write(
    "app-icon.svg",
    svg(1024, 1024, f'<rect width="1024" height="1024" fill="{GRAPHITE}"/>'
        + placed(LOCKUP_PATH, WIDTH, HEIGHT, CHAMPAGNE, 1024, 0.56), TITLE),
)
write(
    "app-icon-light.svg",
    svg(1024, 1024, f'<rect width="1024" height="1024" fill="{IVORY}"/>'
        + placed(LOCKUP_PATH, WIDTH, HEIGHT, GRAPHITE, 1024, 0.56), TITLE),
)

# Android adaptive icon: 108dp canvas, content must stay inside the 66dp safe circle
write("android-icon-background.svg", svg(432, 432, f'<rect width="432" height="432" fill="{GRAPHITE}"/>', TITLE))
write("android-icon-foreground.svg", svg(432, 432, placed(LOCKUP_PATH, WIDTH, HEIGHT, CHAMPAGNE, 432, 0.44), TITLE))
write("android-icon-monochrome.svg", svg(432, 432, placed(LOCKUP_PATH, WIDTH, HEIGHT, WHITE, 432, 0.44), TITLE))

# Small sizes (<= 48 px): AD only
write("android-notification-icon.svg", svg(96, 96, placed(AD_PATH, WIDTH, H_AD, WHITE, 96, 0.84), TITLE))
write(
    "favicon.svg",
    svg(64, 64, f'<rect width="64" height="64" rx="14" fill="{GRAPHITE}"/>'
        + placed(AD_PATH, WIDTH, H_AD, CHAMPAGNE, 64, 0.72), TITLE),
)

# Splash: lockup on graphite (the platform centers it)
write("splash.svg", svg(1284, 2778, f'<rect width="1284" height="2778" fill="{GRAPHITE}"/>'
    + f'<g transform="translate(0 747)">{placed(LOCKUP_PATH, WIDTH, HEIGHT, CHAMPAGNE, 1284, 0.34)}</g>', TITLE))
