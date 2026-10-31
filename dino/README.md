# 🦕 Dino Detective

A footprint-guessing game for a 4-year-old. Each round shows one dinosaur
footprint and three dinosaurs; she picks who made it.

## Files

| File | What it is |
| --- | --- |
| **`dino-game.html`** | **The game.** Fully standalone — every image is base64-embedded, no network, no fonts, no CDN. Just open it (or copy it to a tablet). |
| **`corpus.html`** | The inspector "backend": all twelve footprint/dinosaur pairs with names, track types, credits and file paths. |

Everything below is only needed if you want to change the corpus.

## How it plays

- Start screen picks the round count: **4 / 6 / 8 / 10 / 12**, default **8**.
- Each round: one footprint, three dinosaurs, tap the one you think made it.
- **A wrong tap never ends the round** — the card dims and she keeps trying
  until she finds it, so every round finishes on a win. A point is scored only
  for a first-try hit, so the final score still means something.
- Correct answers get a chime, confetti, and the dinosaur's name spoken aloud
  (Web Speech API) — she can't read the labels yet.
- End screen: score, stars, a medal, and every dinosaur she met.
- **EN / ES toggle** top-right. Spanish is Rioplatense and feminine
  ("¡Sos una paleontóloga de verdad!").
- All text is **UPPERCASE** — she recognises capitals, not lower case.

## Voices

There's a small **🔊 VOICE** row under the Start button: a dropdown of every
voice the device offers plus a **TEST ▶** button. Picking one auditions it
immediately and pins it (saved in `localStorage`, per language).

Left alone, the game auto-picks Rioplatense-first:

```
es-AR → es-UY → es-PY → es-419 → es-CL → es-MX → es-CO → es-PE → es-US → es
```

Castilian (`es-ES`) is deliberately the last resort.

**On this machine** Chrome offers exactly two Spanish voices — `es-ES`
(Castilian) and `es-US` "Google español de Estados Unidos". The game picks
`es-US`, which is neutral Latin American: no Castilian *distinción*, so it's
already much closer than Spain. It is not truly Rioplatense though — no voseo
intonation, no *sh* for `ll`/`y`.

If you want an actual Argentine accent:

- **Easiest — play on an iPad/iPhone/Mac.** Apple ships an `es-AR` voice
  (Diego); the picker will select it automatically. Hit TEST ▶ to confirm.
- **Best quality on Linux — Piper neural TTS**, which has a real Argentine
  voice, `es_AR-daniela-high` (~114 MB). It isn't a browser voice, so it has to
  be bridged into `speech-dispatcher` via its generic module before Chrome sees
  it. Worth it only if you care a lot.
- **Not worth it:** `apt install mbrola-mx1 / mbrola-vz1` are the only Latin
  American voices in the Ubuntu repos, and they're dated formant synths that
  sound clearly worse than Google's `es-US`.

In devtools, `dinoVoices()` lists what the device has and `dinoVoice("es")`
shows what the game chose.

### The fairness rule

Each dinosaur has a `trackType`. The two decoys in a round are always drawn
from *different* track types than the answer, so the three candidate footprints
are never confusable for a small child. This is asserted in the build and
checked with 5,000 simulated rounds per dinosaur using `node tools/check_rounds.cjs`.

Related dinosaurs deliberately share track types: Allosaurus joins T. rex and
Spinosaurus; Apatosaurus and Brachiosaurus join Diplodocus; Deinonychus joins
Velociraptor; Iguanodon and Parasaurolophus share the new rounded three-toed
ornithopod type. Every round uses three distinct types, including its decoys.
`corpus.html` flags these shared types for inspection.

## Why the footprints are drawings

I first built a corpus of **real fossil track photographs** from Wikimedia
Commons and Flickr — Tyrannosauripus, Brontopodus, Deltapodus, Ceratopsipes,
Eubrontes, Grallator and more, all with verified trackmaker attribution. On
inspection most were unusable for a four-year-old: ceratopsian and ankylosaur
tracks read as anonymous lumpy rock, several shots had a person's arm or head
in frame, and the only dromaeosaur (two-toed) track on Commons is a line
diagram from a journal paper.

Two other things ruled the photos out:

- The three-toed theropod prints (T. rex, Dilophosaurus, Coelophysis) are only
  distinguishable *by size*, which a cropped photo cannot convey.
- The famous "Velociraptor tracks" at Tuba City, Arizona are tourist-signage
  naming — they are Early Jurassic, Dilophosaurus-grade, and predate
  Velociraptor by ~100 million years. Using them would have taught her
  something false.

So the game ships clean silhouettes instead. The real fossil photos are
still on disk under `assets/footprints/_raw/` if you ever want to revisit them.

## Credits

**The original six footprint silhouettes** — extracted from the *Dinosaur Footprints Matching
Activity* worksheet by Butterfly Creek (NZ), recoloured to a fossil brown:
<https://www.butterflycreek.co.nz/wp-content/uploads/2022/08/Dinosaur-Footprints-Activity.pdf>
This is third-party worksheet artwork included here for personal, offline play —
fine for playing with your kid, not for redistribution. **They are not in this
repository** (see `.gitignore`), and neither are the built `dino-game.html` /
`corpus.html`, which embed them. To build locally, extract the six silhouettes
from the worksheet PDF into `assets/footprints/<slug>.png` (900 × 900, transparent,
fossil brown) and run `python3 tools/build.py`. Replacing them with original
drawings, like the six CC0 ones below, would make the whole game shareable.

**Six added footprints** — original project drawings, dedicated to CC0 1.0.
Editable SVGs are in `assets/footprints/drawings/`; the game uses transparent
900 × 900 PNG exports in the same fossil brown as the original silhouettes.
These represent broad anatomical groups, not verified tracks of an exact species.
Each added dinosaur has its own editable SVG and distinct silhouette, with
asymmetric toes, shaped pads and organic edges to match the original set.
The variations are illustrations for the game, not diagnostic species differences;
related dinosaurs retain the same track group so they never compete in a round.
References:
[NPS theropod/hadrosaur tracks](https://www.nps.gov/dena/learn/nature/making-dino-prints.htm),
[US Forest Service sauropod tracks](https://www.fs.usda.gov/sites/default/files/fs_media/fs_document/Dinosaur%20Lake-Final508.pdf),
[didactyl dromaeosaur tracks](https://doi.org/10.1016/j.palaeo.2008.02.003),
[ornithopod footprint morphology review](https://doi.org/10.1371/journal.pone.0115477).

**Dinosaur life restorations** — Wikimedia Commons, all CC-BY / CC-BY-SA 4.0:

| Dinosaur | Artist | Licence |
| --- | --- | --- |
| Tyrannosaurus rex | Connor Ashbridge | CC BY 4.0 |
| Triceratops | Connor Ashbridge | CC BY-SA 4.0 |
| Spinosaurus | Connor Ashbridge | CC BY 4.0 |
| Stegosaurus | Fred Wierum | CC BY-SA 4.0 |
| Diplodocus | Fred Wierum | CC BY-SA 4.0 |
| Velociraptor | Entelognathus | CC BY-SA 4.0 |
| Allosaurus | Fred Wierum | CC BY-SA 4.0 |
| Apatosaurus | Connor Ashbridge | CC BY 4.0 |
| Brachiosaurus | DataBase Center for Life Science (DBCLS) | CC BY 4.0 |
| Deinonychus | Emily Willoughby | CC BY-SA 4.0 |
| Iguanodon | Nobu Tamura | CC BY-SA 4.0 |
| Parasaurolophus | Connor Ashbridge | CC BY-SA 4.0 |

Per-file source and new artwork license links are in `corpus.html`. New artwork
is resized to at most 900 pixels, with transparent margins trimmed where present;
original downloads are retained in `assets/dinos/_raw/`.

## Rebuilding

```bash
python3 tools/build.py          # re-embeds assets, writes both HTML files
```

Everything else is only for changing the corpus:

```
data/dino_meta.json          names (EN/ES), trackType, kid-facing description
data/dino-candidates.json    dinosaur artwork URLs (ranked; first that works wins)
data/footprint-candidates.json  the real fossil photo URLs, kept for reference
tools/fetch_assets.py        downloads + normalises into assets/
templates/*.html.tmpl        game and inspector sources; __CORPUS_JSON__ is the inject point
```

To add a dinosaur: add its footprint PNG to `assets/footprints/`, its artwork to
`assets/dinos/`, a matching entry in `data/dino_meta.json` (a new `trackType` if
its print really looks different), add it to `corpus-footprint.json` /
`corpus-dino.json`, then rebuild.

Note: `upload.wikimedia.org`'s `/thumb/` endpoint returns an HTML error page for
scripted requests — always fetch the full-size original and resize locally.
`tools/fetch_assets.py` refuses `/thumb/` URLs for this reason.
