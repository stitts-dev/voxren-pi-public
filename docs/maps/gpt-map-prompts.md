# Summoner's Rift background prompts for GPT image generation

Attach `map-dd.png` (the 512px Riot minimap) with every prompt. The heat map overlay relies on the
geometry of that file, so the model must restyle it, not redraw it from memory.

## Shared spec (paste under every prompt)

> Use the attached image as the exact structural reference. Keep the same square frame, the same
> board position inside the frame, and the same proportions of every lane, jungle path, river bend
> and base, so that any pixel coordinate on the attached image maps to the same place on yours.
> Output a 2048x2048 PNG. Everything outside the walkable board is solid #121314. No text, no
> numbers, no icons, no towers, no champions, no minimap markers, no glow, no lens flare, no
> watermark. Flat top-down orthographic view, no perspective, no tilt. Muted and low contrast: this
> sits underneath colored data overlays, so nothing in it may be saturated or bright.

## Prompt 1 · dark stone relief

> Restyle the attached League of Legends minimap as a dark, matte stone relief map. Walkable ground
> is a slightly raised, softly lit dark grey slab; walls are recessed near-black; the river is a
> barely darker channel with a faint cool tint; the two bases are the same dark grey with a subtle
> engraved circular pattern. Soft directional light from the top left, gentle ambient occlusion in
> the recesses, no hard shadows. Palette between #121314 and #33363a only.

## Prompt 2 · engraved blueprint

> Restyle the attached League of Legends minimap as a fine engraved blueprint on near-black paper.
> Draw the edges of all walkable space as thin, even, light-grey lines (#3d4045) with hairline
> hatching inside the walls only. The river is a double line. Bases are drawn as line art. No fills
> except the #121314 background. Crisp vector-like linework, consistent stroke weight.

## Prompt 3 · topographic

> Restyle the attached League of Legends minimap as a topographic chart. Walkable ground is a flat
> dark grey (#26282b) with three or four evenly spaced contour lines just inside its edges, each a
> notch lighter than the last; walls are #121314; the river is #1f2a2e with fine horizontal ripple
> lines. Bases carry concentric contour rings. Clean, quiet, cartographic.

## Prompt 4 · brushed metal

> Restyle the attached League of Legends minimap as brushed dark metal plate. Walkable ground is a
> brushed graphite surface with a very faint linear grain; walls are cut out to the #121314
> background with a thin bevelled edge catching light from the top left; the river is a smooth,
> slightly darker satin inlay. Overall value range #121314 to #303336. Understated, industrial.

## What to check on each result

- Lay it over `map-dd.png` at 50% opacity: lanes, river and base outlines must line up exactly.
- Nothing brighter than roughly #3a3d42 anywhere except thin edge highlights.
- The corners outside the board are solid #121314, not black and not textured.
