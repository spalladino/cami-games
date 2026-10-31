#!/usr/bin/env python3
"""Build the standalone game + the corpus inspector.

Joins corpus-footprint.json and corpus-dino.json on slug, keeps only pairs where
BOTH images downloaded, base64-embeds them at display size, and renders the two
HTML files from templates/.

Usage:  python3 tools/build.py
"""
import base64
import io
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOOT_BOX, DINO_BOX = 560, 620
FOOT_Q, DINO_Q = 82, 84


def load(path, default=None):
    p = os.path.join(ROOT, path)
    if not os.path.exists(p):
        if default is not None:
            return default
        sys.exit(f"missing {path} — run tools/fetch_assets.py first")
    with open(p) as fh:
        return json.load(fh)


def embed_footprint(path):
    """Silhouettes are transparent PNGs and must stay that way so they sit on the
    game's sandy dig-circle; photographic prints fall back to JPEG."""
    im = Image.open(os.path.join(ROOT, path))
    keep_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im.thumbnail((FOOT_BOX, FOOT_BOX), Image.LANCZOS)
    buf = io.BytesIO()
    if keep_alpha:
        im.convert("RGBA").save(buf, "PNG", optimize=True)
        mime = "image/png"
    else:
        im.convert("RGB").save(buf, "JPEG", quality=FOOT_Q, optimize=True)
        mime = "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode(), buf.tell()


def embed_dino(path):
    im = Image.open(os.path.join(ROOT, path))
    keep_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
    im.thumbnail((DINO_BOX, DINO_BOX), Image.LANCZOS)
    buf = io.BytesIO()
    if keep_alpha:
        im.convert("RGBA").save(buf, "PNG", optimize=True)
        mime = "image/png"
    else:
        im.convert("RGB").save(buf, "JPEG", quality=DINO_Q, optimize=True)
        mime = "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(buf.getvalue()).decode(), buf.tell()


def render(tmpl_name, out_name, token, payload):
    with open(os.path.join(ROOT, "templates", tmpl_name)) as fh:
        tmpl = fh.read()
    if token not in tmpl:
        sys.exit(f"{tmpl_name}: token {token} not found")
    out = os.path.join(ROOT, out_name)
    with open(out, "w") as fh:
        fh.write(tmpl.replace(token, payload))
    return out, os.path.getsize(out)


def main():
    meta = load("data/dino_meta.json")
    foots = {r["slug"]: r for r in load("corpus-footprint.json") if r.get("file")}
    dinos = {r["slug"]: r for r in load("corpus-dino.json") if r.get("file")}

    entries, skipped = [], []
    for slug in sorted(set(foots) | set(dinos)):
        f, d = foots.get(slug), dinos.get(slug)
        if not f or not d:
            skipped.append((slug, "no footprint" if not f else "no dinosaur image"))
            continue
        m = meta.get(slug)
        if not m:
            skipped.append((slug, "no entry in data/dino_meta.json"))
            continue
        fp_uri, fp_bytes = embed_footprint(f["file"])
        di_uri, di_bytes = embed_dino(d["file"])
        entries.append({
            "slug": slug,
            "name": m["name"],
            "trackType": m["trackType"],
            "kidDescription": m["kid"],
            "ichnogenus": f.get("ichnogenus", ""),
            "footprint": fp_uri,
            "image": di_uri,
            "_bytes": {"footprint": fp_bytes, "dino": di_bytes},
            "_credit": {
                "footprint": {k: f.get("source", {}).get(k) for k in
                              ("author", "license", "license_url", "source_page", "commons_page", "url", "kind", "drawing")},
                "dino": {k: d.get("source", {}).get(k) for k in
                         ("author", "license", "license_url", "source_page", "commons_page", "url", "background", "modifications")},
            },
            "_files": {"footprint": f["file"], "dino": d["file"]},
        })

    if len(entries) < 3:
        sys.exit(f"only {len(entries)} complete pairs — the game needs at least 3")
    if len({e["trackType"] for e in entries}) < 3:
        sys.exit("the game needs at least 3 distinct track types for fair rounds")

    # The game payload drops the inspector-only underscore fields.
    game_payload = [{k: v for k, v in e.items() if not k.startswith("_")} for e in entries]
    g, gsize = render("game.html.tmpl", "dino-game.html",
                      "__CORPUS_JSON__", json.dumps(game_payload, ensure_ascii=False))
    c, csize = render("corpus.html.tmpl", "corpus.html",
                      "__CORPUS_JSON__", json.dumps(entries, ensure_ascii=False))

    types = {}
    for e in entries:
        types.setdefault(e["trackType"], []).append(e["slug"])

    print(f"\n{len(entries)} complete pairs:")
    for e in entries:
        print(f"  {e['slug']:22s} {e['trackType']:24s} {e['ichnogenus']}")
    print(f"\ntrack types ({len(types)}):")
    for k, v in sorted(types.items()):
        print(f"  {k:24s} {', '.join(v)}")
    if skipped:
        print("\nskipped:")
        for s, why in skipped:
            print(f"  {s:22s} {why}")
    if len(types) < 3:
        print("\nWARNING: fewer than 3 distinct track types — decoy selection will "
              "fall back to same-type dinosaurs and rounds get harder.")
    print(f"\nwrote {os.path.basename(g)} ({gsize/1e6:.2f} MB)")
    print(f"wrote {os.path.basename(c)} ({csize/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
