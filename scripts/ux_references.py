"""Collect bounded official UI reference images for local design review, not distribution."""
import hashlib
import html
import json
from pathlib import Path
import struct
import urllib.request

OUT = Path("artifacts/ux-references")
WAND = "https://raw.githubusercontent.com/wandb/docs/86eefc342c347f15ce6a4cda3114e9daeaccd403/images/app_ui/"
SOURCES = [
    ("mlflow-tracking", "MLflow tracking workspace", "https://mlflow.org/docs/latest/assets/images/tracking-metrics-ui-temp-ffc0da57b388076730e20207dbd7f9c4.png"),
    ("wandb-line-plot", "W&B line plot", WAND + "line_plot_example.png"),
    ("wandb-run-colors", "W&B run table and colors", WAND + "line_plots_run_table_random_colors.png"),
    ("wandb-legend-settings", "W&B panel legend settings", WAND + "plot_style_line_plot_legend.png"),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    panels = []
    for name, title, url in SOURCES:
        request = urllib.request.Request(url, headers={"User-Agent": "NSET-UI-Review/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError(f"Invalid or oversized PNG: {name}")
        width, height = struct.unpack(">II", data[16:24])
        filename = name + ".png"
        (OUT / filename).write_bytes(data)
        records.append({"name": name, "title": title, "source": url, "bytes": len(data),
                        "width": width, "height": height, "sha256": hashlib.sha256(data).hexdigest()})
        panels.append(f'<section><h2>{html.escape(title)}</h2><img src="{filename}" alt="{html.escape(title)}"><p>{width} × {height}; official documentation illustration.</p></section>')
    (OUT / "manifest.json").write_text(json.dumps(records, indent=2) + "\n")
    (OUT / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Official UI references</title>'
        '<style>body{margin:24px;background:#181a1b;color:#eee;font:14px system-ui}section{margin:0 0 32px}'
        'h2{font-size:16px}img{max-width:100%;height:auto;border:1px solid #555}p{color:#aaa}</style>'
        '<h1>Official UI references</h1><p>Local design-review references only; not redistributed in the app. '
        'These are documentation illustrations, not a claim about every current product screen.</p>'
        + "".join(panels))
    print(json.dumps({"kind": "ui-reference-bundle", "directory": str(OUT), "references": records}))


if __name__ == "__main__":
    main()
