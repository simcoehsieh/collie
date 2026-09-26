#!/usr/bin/env python3
"""Inline the before/after screenshots into the sync report, so it is ONE file.

    inline_shots.py <report.html> <out.html> [--max-side PX]

Every `src="…jpg|png"` that is a relative path (resolved against report.html's directory) becomes a
data: URI. The report goes to the phone through `collie artifact add`, whose frame is
`sandbox=""` and whose store keeps files up to 5 MiB — so a relative image would not load, and a
report over the cap is refused. Over 4.5 MiB this exits 2 and says so; `--max-side` shrinks every
image's longer side with macOS `sips` first (1400 keeps a phone shot at ~650px wide, still legible).
"""

import argparse
import base64
import re
import subprocess
import sys
import tempfile
from pathlib import Path

CAP = int(4.5 * 1024 * 1024)
SRC = re.compile(r'src="(?!data:|https?:)([^"]+\.(?:jpe?g|png))"')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("out")
    ap.add_argument("--max-side", type=int)
    args = ap.parse_args()

    report = Path(args.report)
    html = report.read_text(encoding="utf-8")
    missing: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="collie-sync-inline-"))

    def encode(m: re.Match[str]) -> str:
        path = (report.parent / m.group(1)).resolve()
        if not path.is_file():
            missing.append(m.group(1))
            return m.group(0)
        if args.max_side:
            small = tmp / f"{path.parent.name}-{path.name}"  # before/ and after/ share file names
            subprocess.run(
                ["sips", "-Z", str(args.max_side), "-s", "formatOptions", "72", str(path), "--out", str(small)],
                check=True,
                capture_output=True,
            )
            path = small
        mime = "image/png" if path.suffix == ".png" else "image/jpeg"
        return f'src="data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"'

    html = SRC.sub(encode, html)
    if missing:
        print("missing images: " + ", ".join(missing), file=sys.stderr)
        return 1
    size = len(html.encode("utf-8"))
    if size > CAP:
        print(f"{size / 1048576:.2f} MiB > 4.5 MiB: re-run with --max-side 1400, or drop shots", file=sys.stderr)
        return 2
    Path(args.out).write_text(html, encoding="utf-8")
    print(f"{args.out}  {size / 1048576:.2f} MiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
