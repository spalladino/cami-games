# Cami Driving — game design

## 1. Concept

Cami drives a round little red car up an endless, friendly road seen from above. The car always rolls
forward on its own at a calm pace; turning the phone left or right slides the car left or right, and its
front wheels turn so she can see her hands working. She steers into big bright treats (strawberries,
starfish, balloons, stars) that sparkle, sing, and fill a row of slots at the top; ten treats set off a
rainbow party. The scenery drifts from meadow to beach to town to a starry night and around again. Nothing
can go wrong: no timer, no lives, no crashes, no game over.

## 2. Perspective, layout, physics

**Perspective: top-down, vertically scrolling road, car pointing up.** Rotating the phone right moves the car
right on the screen with no depth or mirroring to decode, which is the most direct mapping a 4-year-old can get.

**Units.** `R` = road width in pixels = `min(0.36 * w, 0.6 * h)` (w, h = canvas size in CSS pixels; about 650 px
on 1920x1080). Everything in this doc measured "in R" is a multiple of that. World positions are stored as
`x` (lateral, in R, 0 = road center, + = right) and `d` (distance travelled, in R). The game converts:
`screenX = w/2 + x*R`, `screenY = carScreenY - (d - carD)*R`.

**Screen layout (landscape):**
- Road: vertical band centered at `w/2`, width `R`, full height. Ground fills both sides.
- Car: center at `x_car`, `carScreenY = 0.80 * h`. Size `0.18R` wide by `0.30R` tall.
- Treat tray (HUD): top center, 10 slots, slot size `0.08h`, slot pitch `0.095h`, center y `0.07h`, on a rounded
  white-ish pill. Trophy stars: top right, `0.07h` each, stacking leftwards from `w - 0.05h`.
- Traffic light (start/resume only): centered over the road at y `0.35h`, height `0.30h`.
- Lookahead: about 1.35R visible above the car, so a treat is on screen ~1.7 s before she reaches it.

**Car physics (per frame, dt in seconds):**
- Input `s` in -1..1 (phone is already smoothed and dead-zoned). Extra smoothing on the display:
  `sm += (s - sm) * (1 - exp(-dt / 0.08))`. If no steer message arrives for 2 s, treat `s = 0`.
- Lateral speed: `vx = sm * 0.9` R/s (full lock crosses from road center to the edge in ~0.55 s).
- Car body angle `bodyAngle = sm * 0.30` rad; front wheel angle `wheelAngle = sm * 0.55` rad. Both come
  straight from `sm`, so the car reacts within one frame.
- Forward speed: `v = 0.8` R/s on the road, constant forever. Changes ease with `v += (target - v) * (1 - exp(-dt/0.3))`.
- Keyboard (dad testing, no controller): Left/Right or A/D give `s = -1/+1`, ramped over 0.15 s; released → 0.

**Road edges (no punishment):**
- Road half-width is 0.5R. With `|x_car| <= 0.5` the car is on the road.
- `0.5 < |x_car| <= 0.82` is the shoulder (grass, sand, sidewalk): target speed drops to `0.65 * v`, the car
  jitters ±2 px at 12 Hz, dust puffs spawn every 0.1 s in the biome's `dust` color, `Sounds.setOffroad(true)`.
  If she is not steering outward (`|sm| < 0.2` or `sm` points back to the road), the car drifts back at 0.12 R/s.
- Soft bumper at `|x_car| = 0.82`: within 0.1 of the limit, outward `vx` is scaled by `(0.82 - |x|)/0.1`, so
  the car glides to a stop sideways. On first contact play `Sounds.boing()` and squash the car 10% for 0.2 s;
  re-arm after `|x| < 0.75`.
- Roadside props sit at `|x| >= 1.0`, so the car (max reach 0.91) never touches them.

## 3. Entities

All sizes in R. Hit tests are axis-aligned on centers, in R.

| Entity | Size | Spawn rule | On contact |
|---|---|---|---|
| Car | 0.18 x 0.30 | One, always | — |
| Treat | 0.16 diameter, bobs ±0.01, glows | Every 1.4–2.0R of distance (random). Lane x in {-0.3, 0, +0.3}; 70% of the time a different lane from the previous treat. 20% of spawns are a trail of 3 treats 0.5R apart (same lane, or stepping one lane across). Kind = current biome's treat. | Collect when `|dx| < 0.17` and `|dy| < 0.20`. Pop (scale 1→1.6, fade 0.25 s), 8 sparkles, the icon flies to its tray slot in 0.5 s (ease-out), slot pulses, `Sounds.collect(slotIndex)`. |
| Puddle | 0.32 x 0.20 ellipse | Every 10–14 s of play, never in the first 20 s, never in a lane holding a treat within ±0.6R of distance. | When `|dx| < 0.25` and `|dy| < 0.18`: 12 blue droplets, `Sounds.splash()`, car wiggle (`bodyAngle += 0.15*sin(t*25)` decaying over 0.6 s), speed × 0.85 for 0.6 s. Puddle switches to rippled look. Nothing is lost. |
| Prop | 0.25–0.6 (per kind) | Each side independently every 0.5–1.0R, `|x|` in 1.0–1.4 (beach: left side only; the right side is sea, which gets an occasional `boat`). Kind random from the biome's prop list. | None (decor). |
| Gate | spans road, 1.3R wide, 0.25R tall | One at each biome change, placed so it reaches the car at the boundary. | Drive under it (no hit test): `Sounds.gate()`, 20 sparkles in the new biome's accent color, palette blend starts. |
| Particles | sparkle 0.04, confetti 0.03, droplet 0.03, dust 0.05 | Spawned by events above. Life 0.4–1.2 s, simple gravity/drag. | None. |

Despawn anything more than 0.5R below the bottom edge. Missed treats just scroll away silently.

**First-ride tutorial (no text):** the first three treats after "go" are fixed: lane 0 at 1.0R ahead (a free
win), then +0.3 at 3.0R, then -0.3 at 4.8R. Normal spawning starts after the third.

**Treat counter and celebration:** the tray has 10 slots shown as faint outlines; each collected treat fills the
next slot with its own icon. At 10: the celebration (section 6) plays, the tray icons fly into a big gold
trophy star at the top right, and the tray empties. Trophies accumulate forever; after 12 they shrink to fit.

## 4. Biomes

Order loops forever: **meadow → beach → town → night → meadow ...** Each lasts **75 s** of play time (paused
time excluded), so one loop is 5 minutes. The palette blends from old to new over 3 s starting when the gate
passes the car (`scene = {from, to, mix}`); props and treats already spawned keep their kind.

| Key | meadow | beach | town | night |
|---|---|---|---|---|
| ground | `#7ED957` | `#F6DFA0` | `#E8E3D8` | `#1F3A5F` |
| groundStripe | `#6CC64A` | `#EFD08A` | `#D9D2C3` | `#24456F` |
| road | `#9AA0B5` | `#A9A7B0` | `#7D8396` | `#3B4256` |
| roadEdge | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | `#CFD8FF` |
| laneMark | `#FFE45C` | `#FF8A65` | `#FFFFFF` | `#FFE45C` |
| accent | `#FF6FB5` | `#4FC3F7` | `#FFD93D` | `#FFF6A5` |
| dust | `#5DB843` | `#E8C77A` | `#BDB6A8` | `#3C5F8F` |
| treat | `strawberry` (`#FF3B5C`) | `starfish` (`#FF9F1C`) | `balloon` (`#4D96FF`) | `star` (`#FFD700`) |
| props | `tree`, `bush`, `flowers`, `cow` | `palm`, `umbrella`, `sandcastle`; sea `boat` | `house`, `roundTree`, `lamppost` | `houseLit`, `lamppostOn`, `pine` |

Extras: beach draws sea `#4FC3F7` with white wave lines for `x > 1.15` (right side). Night draws twinkling
stars `#FFF6A5` scattered on the ground and the car's headlights (soft cone `#FFF3B0` at 35% alpha). Ground
stripes are horizontal bands 0.5R tall scrolling with the road, so speed is always visible. Every treat gets a
white 4 px outline and soft glow so it pops on any ground. The car is `#FF4D4D` body, `#BDE7FF` windshield,
`#222` wheels in every biome.

## 5. Sounds

All synthesized, gentle, master gain 0.5, nothing harsh or long.

| Function | Character |
|---|---|
| `collect(i)` | Rising two-note marimba blip (sine + quick decay); base note climbs a C-major pentatonic by slot `i` (0–9), so filling the tray sounds like a little scale. |
| `splash()` | Bubbly "bloop-bloop": two sine drops 600→200 Hz plus a short burst of lowpassed noise. |
| `boing()` | Soft cartoon spring: sine with fast vibrato sweeping 300→500→250 Hz, 0.3 s. |
| `setOffroad(on)` | While on: soft low thumps (80 Hz sine, 40 ms) every 120 ms with ±15% jitter. Fades in/out in 0.1 s. |
| `setEngine(on)` | Very quiet hum (triangle 70 Hz, slow 0.5 Hz wobble, gain 0.03). On during play, off when paused/waiting. |
| `celebrate()` | Fanfare: C-E-G-C' arpeggio on a bright triangle, then a sparkly high trill and two cute "beep-beep" car honks. ~2 s. |
| `gate()` | Whoosh (bandpassed noise sweep) followed by a wind-chime glissando of 5 high notes. |
| `light(step)` | Traffic light beep: step 0 and 1 a soft 440 Hz boop, step 2 a bright 880 Hz ding. |
| `go()` | Short friendly "vroom": sawtooth 90→220 Hz through a lowpass, 0.5 s, soft. |
| `connect()` | Happy doorbell, two tones going up (E5 → A5). |
| `disconnect()` | Gentle two tones going down (A4 → E4), quiet. |
| `setBiome(name)` | Quiet ambience: meadow occasional bird tweets, beach slow wave swish, town nothing, night crickets. |

## 6. Screens and states

`WAITING → STARTING → PLAYING ⇄ PAUSED`, with `PAUSED → STARTING` on resume. Celebration overlays PLAYING.

**WAITING** (no controller, for dad). Left half: a tiny meadow patch where the red car drives slow circles,
wheels turning, with puffs of sparkles. Right half: a white card with the QR code (`/qr.svg`, about 0.45h square),
the controller URL under it in large monospace, and three short lines: "Scan with the phone, open in Chrome",
"Accept the certificate warning once (Advanced → Proceed)", "Or press ← → to test with the keyboard". Bottom
banner, pulsing until clicked: "Click anywhere to turn on sound" with a speaker icon; after the click it shows
"Sound on" with a check. Any click or key on the page calls `Sounds.unlock()`.
In the middle of the island, inside the car's lap, a green **Start** button with "Phone connected ✓" or
"No phone yet" under it; it pulses once a phone is connected.
- Controller connects → `Sounds.connect()`, and the game keeps waiting. It never starts by itself.
- Start: click the Start button, press Enter/Space or an arrow key, or tap the smiley on the phone's wheel →
  waiting screen fades out in 0.6 s → STARTING. Without a phone it starts in keyboard mode (a phone that
  connects later takes over steering).

**STARTING** (3 s). Road and car visible, forward speed 0. The traffic light shows red, yellow, green one per
second with `Sounds.light(0/1/2)`. Steering already slides the car sideways, so she discovers the wheel before
the car moves. On green: `Sounds.go()`, `setEngine(true)`, forward speed eases up to 0.8 R/s.

**PLAYING.** As above. If audio is still locked, a small crossed-out speaker sits in the top-left corner; clicking
it unlocks audio. No other HUD, no text.

**Celebration** (every 10 treats; the game keeps running and steering keeps working). A rainbow arc grows over the
road in 0.6 s, holds, and fades by 3 s; 80 confetti pieces burst from the top; `Sounds.celebrate()`; the tray icons
fly into the new trophy star. Treat spawning pauses for those 3 s so nothing is missed during the party.

**PAUSED** (controller disconnected for more than 1.5 s while not in keyboard mode). World freezes and dims to
50%; the car shows closed eyes on the windshield and floating "Z"s; `Sounds.disconnect()`, `setEngine(false)`.
A card for dad: "The steering wheel phone disconnected. Reopen this on the phone:", the URL, and a small QR.
When the controller returns → `Sounds.connect()` → STARTING (traffic light again) → PLAYING with all state kept.

## 7. Art API — `public/js/art.js`

Global `Art` object, pure drawing, no state beyond caches. Conventions: pixel units in CSS pixels (the game sets
the devicePixelRatio transform before calling). `x, y` are the **center** of what is drawn unless noted. `t` is
seconds (float) for idle animation. `scene` is `{from, to, mix}` with biome keys from section 4 (`mix` 0..1 blends
`from` → `to`). `scroll` is total distance travelled in pixels (monotonic; take it modulo the pattern length).
Every function must `save()`/`restore()` the context.

| Function | Draws |
|---|---|
| `Art.palette(scene)` | Returns the blended palette object (keys from section 4, hex strings) for particles and HUD. |
| `Art.drawGround(ctx, w, h, scene, roadCx, R, scroll, t)` | Fills the whole canvas: ground, scrolling stripes, beach sea, night stars. |
| `Art.drawRoad(ctx, roadCx, R, h, scene, scroll, t)` | Road band of width `R` centered at `roadCx`, full height: edges and scrolling dashed center line. |
| `Art.drawProp(ctx, kind, x, y, size, t)` | One roadside prop (kinds in section 4); `size` is its width in px. |
| `Art.drawTreat(ctx, kind, x, y, size, t, alpha)` | One treat with outline, glow and bob; `size` is diameter. Used on road, in flight and in the tray. |
| `Art.drawPuddle(ctx, x, y, w, h, t, rippleAge)` | Puddle ellipse; `rippleAge` seconds since splashed, or -1 if untouched. |
| `Art.drawCar(ctx, x, y, w, h, bodyAngle, wheelAngle, t, opts)` | The car. `opts = {squash: 0..1, headlights: bool, sleeping: bool}`. Rotation around center. |
| `Art.drawGate(ctx, roadCx, y, R, toBiome, t)` | Arch over the road showing the next biome's treat icon. |
| `Art.drawParticle(ctx, p)` | `p = {kind: 'sparkle'|'confetti'|'droplet'|'dust', x, y, size, rot, life (1→0), color}`. |
| `Art.drawTray(ctx, w, h, kinds, pulseSlot, pulseT, t)` | Top HUD: 10 slots, filled with `kinds` (array of treat keys, length 0–10); `pulseSlot` index to bounce (`-1` none), `pulseT` 0..1 progress. |
| `Art.drawTrophies(ctx, w, h, count, t)` | Gold trophy stars at the top right. |
| `Art.drawRainbow(ctx, w, h, progress, t)` | Celebration rainbow; `progress` 0..1 over its 3 s life (grow, hold, fade). |
| `Art.drawTrafficLight(ctx, x, y, height, step)` | Traffic light; `step` 0 red, 1 yellow, 2 green. |
| `Art.drawWaiting(ctx, w, h, t, qrImg, url, soundOn, phone, hover)` | Full waiting screen (section 6). `qrImg` is a loaded `Image` or null (draw a placeholder). `phone`: a phone is connected; `hover`: the mouse is over Start. |
| `Art.waitingStartButton(w, h)` | `{x, y, w, h}` of the waiting screen's Start button (for the click hit test). |
| `Art.drawPaused(ctx, w, h, t, qrImg, url)` | Dim overlay plus the dad card (section 6), drawn over the frozen frame. |
| `Art.drawSoundOff(ctx, x, y, size)` | Crossed-out speaker icon (top-left hint while audio is locked); x, y = top-left. |

Draw order per frame: ground, road, puddles, props, treats, gate, car, particles, rainbow, tray, trophies,
traffic light, sound-off icon, paused overlay.

## 8. Sound API — `public/js/sounds.js`

Global `Sounds` object over one lazily created `AudioContext`.

- `Sounds.unlock()` — create/resume the AudioContext. Call on every click/keydown on the game page (idempotent).
  Needed because the phone's gestures don't count: dad must click or press a key on the computer once.
- `Sounds.isUnlocked()` → bool (`ctx.state === 'running'`).
- One-shots: `collect(i)`, `splash()`, `boing()`, `celebrate()`, `gate()`, `light(step)`, `go()`, `connect()`, `disconnect()`.
- Toggles (safe to call every frame, only act on change): `setOffroad(on)`, `setEngine(on)`, `setBiome(name)`.
- Every function is a silent no-op while locked; nothing throws.
