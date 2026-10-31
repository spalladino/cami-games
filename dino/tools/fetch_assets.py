#!/usr/bin/env python3
"""Download + normalise corpus images for the dinosaur footprint game.

Reads a candidates JSON file, downloads each image (full-size originals only --
Wikimedia's /thumb/ endpoint is throttled and returns an HTML error page), then
resizes/crops locally with PIL and writes results into assets/.

Usage:
    python3 tools/fetch_assets.py candidates.json --kind footprint
    python3 tools/fetch_assets.py candidates.json --kind dino
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageOps, ImageFilter

UA = "DinoPrintsKidsGame/1.0 (spalladino@gmail.com) curl"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_BYTES = 20_000


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def download(url, dest):
    """Fetch a URL to dest. Returns (ok, note)."""
    if "upload.wikimedia.org" in url and "/thumb/" in url:
        return False, "wikimedia /thumb/ endpoint is throttled; use the original"
    rc = subprocess.run(
        ["curl", "-sL", "--max-time", "60", "-A", UA, "-o", dest, url],
        capture_output=True,
    ).returncode
    if rc != 0:
        return False, f"curl exit {rc}"
    if not os.path.exists(dest):
        return False, "no file written"
    size = os.path.getsize(dest)
    if size < MIN_BYTES:
        os.remove(dest)
        return False, f"too small ({size} bytes) - probably an error page"
    # Reject HTML error pages masquerading as images.
    with open(dest, "rb") as fh:
        head = fh.read(512).lstrip()
    if head[:1] == b"<":
        os.remove(dest)
        return False, "server returned HTML, not an image"
    try:
        Image.open(dest).verify()
    except Exception as exc:  # noqa: BLE001
        os.remove(dest)
        return False, f"unreadable image: {exc}"
    return True, f"{size} bytes"


def process_footprint(src, dest, box=768):
    """Square-crop, autocontrast and sharpen a footprint photo.

    Kids need the print to read clearly at a glance, so we stretch the
    histogram a little and apply a gentle unsharp mask.
    """
    im = Image.open(src).convert("RGB")
    im = ImageOps.fit(im, (box, box), method=Image.LANCZOS, centering=(0.5, 0.5))
    im = ImageOps.autocontrast(im, cutoff=1)
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=110, threshold=3))
    im.save(dest, "JPEG", quality=86, optimize=True)
    return im.size


def process_dino(src, dest, box=768):
    """Fit a dinosaur restoration into a square, preserving transparency."""
    im = Image.open(src)
    has_alpha = im.mode in ("RGBA", "LA") or (
        im.mode == "P" and "transparency" in im.info
    )
    if has_alpha:
        im = im.convert("RGBA")
        im = ImageOps.contain(im, (box, box), method=Image.LANCZOS)
        canvas = Image.new("RGBA", (box, box), (0, 0, 0, 0))
        canvas.paste(im, ((box - im.width) // 2, (box - im.height) // 2), im)
        canvas.save(dest, "PNG", optimize=True)
        return canvas.size, True
    im = im.convert("RGB")
    im = ImageOps.fit(im, (box, box), method=Image.LANCZOS, centering=(0.5, 0.4))
    im.save(dest, "JPEG", quality=88, optimize=True)
    return im.size, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("candidates")
    ap.add_argument("--kind", choices=["footprint", "dino"], required=True)
    ap.add_argument("--outdir", default=None)
    args = ap.parse_args()

    outdir = args.outdir or os.path.join(
        ROOT, "assets", "footprints" if args.kind == "footprint" else "dinos"
    )
    rawdir = os.path.join(outdir, "_raw")
    os.makedirs(rawdir, exist_ok=True)

    with open(args.candidates) as fh:
        entries = json.load(fh)

    report = []
    for entry in entries:
        name = entry["dinosaur"]
        base = slug(name)
        picked = None
        for idx, cand in enumerate(entry.get("candidates", [])):
            url = cand["url"]
            ext = os.path.splitext(url.split("?")[0])[1].lower() or ".jpg"
            if ext not in (".jpg", ".jpeg", ".png", ".webp"):
                ext = ".jpg"
            raw = os.path.join(rawdir, f"{base}-{idx}{ext}")
            ok, note = download(url, raw)
            print(f"[{'ok ' if ok else 'FAIL'}] {name} #{idx}: {note}  {url[:90]}")
            if not ok:
                continue
            try:
                if args.kind == "footprint":
                    out = os.path.join(outdir, f"{base}.jpg")
                    size = process_footprint(raw, out)
                else:
                    # process_dino picks the format: PNG when the source has an
                    # alpha channel worth keeping, JPEG otherwise.
                    probe = Image.open(raw)
                    keep_alpha = probe.mode in ("RGBA", "LA") or (
                        probe.mode == "P" and "transparency" in probe.info
                    )
                    out = os.path.join(outdir, f"{base}." + ("png" if keep_alpha else "jpg"))
                    size, _ = process_dino(raw, out)
            except Exception as exc:  # noqa: BLE001
                print(f"       process failed: {exc}")
                continue
            picked = {
                "dinosaur": name,
                "slug": base,
                "file": os.path.relpath(out, ROOT),
                "size": size,
                "candidate_index": idx,
                "source": cand,
                **{
                    k: entry[k]
                    for k in ("ichnogenus", "track_type", "kid_description")
                    if k in entry
                },
            }
            break
        if picked is None:
            print(f"[MISS] {name}: no usable candidate")
        report.append(picked or {"dinosaur": name, "slug": base, "file": None})

    out_json = os.path.join(ROOT, f"corpus-{args.kind}.json")
    with open(out_json, "w") as fh:
        json.dump(report, fh, indent=2)
    got = sum(1 for r in report if r.get("file"))
    print(f"\n{got}/{len(report)} downloaded -> {out_json}")


if __name__ == "__main__":
    main()
