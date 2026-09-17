# Back to the Future — 30-Second Toyota Ad — Story Template

A shot-by-shot template for generating a personalized 30-second car ad where **our
customer is the hero** of a *Back to the Future*–style moment. The coding agent reads
this file together with `person.json` and `car.json` and produces the video, one shot at
a time, then stitches them in order.

We're borrowing the *feeling* of the movie — the ordinary-life-to-impossible-leap arc —
not its specifics. No DeLorean, no characters, no logos from the film. The magic is our
Toyota's confident transition from an ordinary drive into an imagined adventure.

---

## How to use this file (for the coding agent)

1. Load `person.json` — this is our **hero**. Render the same person in every shot, using
   its `reference_images` as the identity anchor and its fields for face, hair, skin tone,
   build, and wardrobe. The wardrobe stays identical across all shots.
2. Load `car.json` — this is our **hero car**. Render the same Toyota in every shot, using
   its `reference_images` and fields. Keep one color throughout (from `car.exterior.color`).
3. Generate each shot below as its own clip at the stated duration, then concatenate them
   in order 1 → 8. Total runtime is 30 seconds.
4. Follow the **Consistency rules** and **Audio & tagline** sections exactly.

Tokens like `{{person.hair.color}}` or `{{car.exterior.color}}` mean "pull this value from
the JSON." `{{HERO}}` = the person from `person.json`. `{{CAR}}` = the Toyota from `car.json`.

---

## Global settings

```yaml
runtime_seconds: 30
aspect_ratio: "9:16"          # vertical for social; switch to "16:9" for web/TV
hero: person.json             # the customer, on screen as the hero
car: car.json                 # Toyota model selected by the catalog
look: "cinematic, warm, filmic; slight grain; anamorphic flares in the leap"
arc: "ordinary world -> impossible leap -> mastery -> return transformed"
palette: "starts drab and grey; blooms to warm gold after the leap"
```

---

## The story — 8 shots

Timing adds up to 30 seconds. Each shot's `SUBJECT` is always `{{HERO}}` (same face, same
wardrobe) and, where present, `{{CAR}}` (same Toyota, same color).

### Shot 1 — Ordinary World — 4s
The "before." Our hero in a flat, everyday moment — nothing special yet. It has to feel
like a real, ordinary day so the leap lands harder.

```
SUBJECT:  {{HERO}} — full description from person.json, {{person.wardrobe.*}}
ACTION:   walking up to an ordinary storefront at dusk, a little tired, ordinary day
CAMERA:   eye-level medium shot, slow follow behind, 35mm
SETTING:  plain street / store entrance, overcast grey dusk
LIGHTING: flat, cool, grey
MOOD:     ordinary, unremarkable
STYLE:    cinematic, subtle grain
SOUND:    muted city hum
```

### Shot 2 — Call to Adventure — 3s
Something shifts. The {{CAR}} comes to life nearby — instrument glow, a soft pulse of light.
The signal that this moment is about to stop being ordinary.

```
SUBJECT:  {{HERO}} turning toward {{CAR}}
ACTION:   the Toyota comes to life — headlights and instrument-panel glow bloom; hero notices
CAMERA:   over-the-shoulder from behind hero toward the car, slow push-in, 35mm
SETTING:  same street, the car parked a few steps away
LIGHTING: warm light rising from the car against the grey
MOOD:     curiosity, "wait, what?"
STYLE:    cinematic
SOUND:    a subtle rising tone over restrained natural vehicle ambience
```

### Shot 3 — Refusal → Meeting the Mentor — 3s
A half-second of hesitation, then the car itself becomes the guide — the door presents,
the interior lights invite. The car is our mentor here, not a person.

```
SUBJECT:  {{HERO}} beside {{CAR}}, {{CAR}} interior glowing
ACTION:   hero pauses, then the door opens/handle presents; interior lights invite them in
CAMERA:   medium two-shot of hero and open door, static, 50mm
SETTING:  at the driver's door
LIGHTING: warm interior glow spilling onto the hero's face
MOOD:     invitation, quiet pull
STYLE:    cinematic
SOUND:    soft welcoming chime, low hum
```

### Shot 4 — Crossing the Threshold — 3s
The point of no return: our hero is in the seat, hand on the wheel. They commit. The
present starts to bend at the edges.

```
SUBJECT:  {{HERO}} in the driver's seat of {{CAR}}, {{car.interior.*}}
ACTION:   hero settles in, both hands on the wheel, a decisive breath; foot presses
CAMERA:   from the passenger side, slow arc toward the hero's face, 50mm
SETTING:  {{CAR}} interior — dashboard and controls matching the licensed cabin reference
LIGHTING: warm screen light on the hero, world outside going soft
MOOD:     commitment, anticipation
STYLE:    cinematic
SOUND:    deep confident whoosh building
```

### Shot 5 — The Ordeal (the leap) — 7s
Our signature impossible moment. The {{CAR}}'s silent, instant launch tears the dull world
into streaks of light and folds it forward around the hero. This is the gasp — it gets the
most seconds on purpose.
*If your video tool caps clip length below 7s, split this into two clips of ~3.5s each
(build, then break-through) and concatenate them.*

```
SUBJECT:  {{HERO}} at the wheel of {{CAR}}, POV alternating with hero's face
ACTION:   confident controlled acceleration; the grey street stretches into streaks of light and
          the world bends forward around the car; hero's face lit with awe
CAMERA:   fast push-in on POV, cut to hero's face, wide 24mm
SETTING:  street dissolving into a tunnel of light
LIGHTING: brilliant streaking light trails, grey-to-gold
MOOD:     awe, exhilaration
STYLE:    cinematic, anamorphic flares
SOUND:    swelling music, a sonic bloom, restrained natural powertrain and road sound
```

### Shot 6 — The Reward — 4s
They arrive somewhere transformed — open, beautiful, golden. Hero shot: our customer calm
and fully in control, the world now responding to them.

```
SUBJECT:  {{HERO}} driving {{CAR}}, calm and powerful
ACTION:   the car glides effortlessly into a stunning open landscape; hero relaxed, in control
CAMERA:   tracking alongside the car, gentle, 50mm; then to hero's confident face
SETTING:  breathtaking open road at golden hour (coast or mountains)
LIGHTING: warm golden backlight
MOOD:     calm power, arrival
STYLE:    cinematic
SOUND:    music settles into a confident groove
```

### Shot 7 — The Road Back / Resurrection — 3s
A breath. Our hero eases back, changed — the power now feels natural, theirs.

```
SUBJECT:  {{HERO}} in {{CAR}}, at ease
ACTION:   hero eases the car to a stop at a scenic overlook, a small satisfied smile
CAMERA:   slow dolly toward the hero through the windshield, 50mm
SETTING:  scenic overlook, golden hour
LIGHTING: warm, soft
MOOD:     quiet satisfaction, ownership
STYLE:    cinematic
SOUND:    music easing, gentle
```

### Shot 8 — Return with the Elixir — 3s
The payoff. We reveal the {{CAR}} cleanly from outside for the first time, and the tagline
and logo land. The "elixir" our hero brought back *is* the car.

```
SUBJECT:  {{CAR}} full exterior, {{car.exterior.color}}; hero visible inside or beside it
ACTION:   camera pulls back off the car at the overlook; clean hero product shot; tagline appears
CAMERA:   pull-back reveal + slow crane up, wide 24mm
SETTING:  overlook at golden hour
LIGHTING: warm cinematic golden hour, clean highlights on the car
MOOD:     aspiration, arrival
STYLE:    cinematic, hero product shot
SOUND:    music resolves to a single clean note
```

---

## Consistency rules (apply to every shot)

- **Same hero, every shot.** Face, hair, skin tone, and build come from `person.json` and
  its `reference_images`. Do not let the face drift. The wardrobe is identical in all shots.
- **Same car, every shot.** Model, color, wheels, and front end come from `car.json` and its
  `reference_images`. One color only — `{{car.exterior.color}}`.
- **Continuous world.** The look starts drab/grey (shots 1–4), transforms during the leap
  (shot 5), and stays warm/golden after (shots 6–8). Keep this progression unbroken.
- **The car sounds natural.** Keep powertrain, tire and wind sound restrained beneath the music.

---

## Audio & tagline

- **Music:** one continuous cue — quiet and curious at the open, building through the leap,
  resolving to a clean note at the reveal. No lyrics competing with the moment.
- **Tagline (shot 8):** `{{TAGLINE}}` — set your line here (e.g. "Your leap starts now.").
- **Logo (shot 8):** your dealership/brand mark, clean, over the final frame.

---

## Assembly

Generate shots 1 → 8, concatenate in order, confirm total runtime is 30 seconds, and export
at `{{aspect_ratio}}`. If any shot's person or car drifts from the references, regenerate
that single shot rather than the whole sequence.

---

## Creative & legal note

We evoke the *feeling* of the famous time-jump — ordinary moment, impossible leap, transformed
arrival — using our own imagery and our Toyota's real launch. We do not use the film's car
design, characters, or logos. And we only use a real customer's likeness with their permission.
