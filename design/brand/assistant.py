"""Build AI Pilot assistant character SVGs (DES-3): mechanic robot head, five states, two colorways.

Usage: python design/brand/assistant.py
"""
from pathlib import Path

OUT = Path(__file__).parent / "assistant"
GRAPHITE = "#0F1012"
CHAMPAGNE = "#D4B483"

# head: the robot silhouette; face: cut-out details (eyes, band, mouth)
COLORWAYS = {
    "on-champagne": (GRAPHITE, CHAMPAGNE),  # assistant button, champagne tile
    "on-graphite": (CHAMPAGNE, GRAPHITE),  # dark surfaces, light-theme button (graphite circle)
}


def eyes(head, face, px, py):
    return (
        f'<circle cx="25" cy="38" r="4.6" fill="{face}"/><circle cx="39" cy="38" r="4.6" fill="{face}"/>'
        f'<circle cx="{25 + px}" cy="{38 + py}" r="2" fill="{head}"/>'
        f'<circle cx="{39 + px}" cy="{38 + py}" r="2" fill="{head}"/>'
    )


def stroke(d, color, width=2.4):
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round"/>'


STATES = {
    # waiting for input
    "idle": lambda h, f: eyes(h, f, 0.8, 0.4) + stroke("M27 46q5 3.5 10 0", f),
    # voice input in progress
    "listening": lambda h, f: eyes(h, f, 0, 0)
    + f'<ellipse cx="32" cy="47" rx="2.2" ry="2.6" fill="{f}"/>'
    + stroke("M55 33q3 5 0 10", h, 2.2)
    + stroke("M59 30q5 8 0 16", h, 2.2),
    # request is processing
    "thinking": lambda h, f: eyes(h, f, 1.6, -1.6) + stroke("M28 47h8", f),
    # answer found
    "happy": lambda h, f: stroke("M21 39.5q4-5 8 0M35 39.5q4-5 8 0", f, 2.8) + stroke("M26 45q6 5.5 12 0", f, 2.6),
    # not sure / could not help
    "unsure": lambda h, f: eyes(h, f, -1.2, 1.4) + stroke("M26.5 47.5q2.75-2.5 5.5 0t5.5 0", f),
}


def head(h, f):
    return (
        f'<rect x="14" y="20" width="36" height="34" rx="11" fill="{h}"/>'
        f'<path d="M14 24C14 14 22 9 32 9C42 9 50 14 50 21L58 23.5Q59 27 55 27.5L14 27.5Z" fill="{h}"/>'
        f'<rect x="14" y="26.5" width="36" height="2.6" fill="{f}"/>'
        f'<circle cx="32" cy="16" r="2.4" fill="{f}"/>'
    )


OUT.mkdir(exist_ok=True)
for state, draw in STATES.items():
    for name, (h, f) in COLORWAYS.items():
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">'
            f"<title>AI Pilot</title>{head(h, f)}{draw(h, f)}</svg>\n"
        )
        (OUT / f"ai-pilot-{state}-{name}.svg").write_text(svg, encoding="utf-8", newline="\n")
        print("wrote", f"ai-pilot-{state}-{name}.svg")
