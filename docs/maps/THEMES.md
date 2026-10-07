# Map themes

Six Summoner's Rift backgrounds for the coach's map visuals, one overlay language each. Every
background keeps the Riot minimap's geometry, so one coordinate contract serves them all.

The coach ships one of them: `holo`, as `data/map-backgrounds/holographic.png` at 2048 px, drawn by
`src/rift-map.ts` under the audit card's death map and the death heat map. A new overlay uses that
module rather than loading a background itself. `just charts` draws every chart that uses it.

## Coordinate contract

- Riot positions run 0..14870 on both axes, origin bottom-left. Pixel `x = X / 14870 * S`,
  `y = (1 - Y / 14870) * S`, where `S` is the image side. The board fills the whole square.
- Backgrounds are 1254 px (`basic` is the 512 px Data Dragon map, dimmed, upscaled). Draw overlays
  at 1254 and scale the finished image to the pane; never resample the background separately.
- Checked 2026-09-26: all five generated backgrounds line up with the Riot map to within a pixel
  at 1024 px (`check-*.png`).

## Themes and their overlay language

| Theme | Background | Point marker | Weight (count) | Density | Route or path | Zone | Ink |
| --- | --- | --- | --- | --- | --- | --- | --- |
| basic | Data Dragon, greyscale at 32% on #121314 | gem hexagon | 5-step multi-hue ramp per exact count | the hex grid itself | dashed polyline | tinted hex fill | white on dark cells, near-black on bright |
| blueprint | hatched drafting sheet | ring with 4 ticks + centre dot | ring radius; `×n` tag; dashed outer ring at 2+ | overlapping dashed rings | thin dashed line with arrowheads | hatched region | one ink, #d8dde2 |
| stone | matte stone relief | ember (soft glow + bright core) | ember size and colour: red, orange, gold | glow accumulates naturally | glowing trail | warm wash | #ffe9b8 |
| holo | neon line map | cyan ring with bloom | radius; magenta at 3+ with a second ring | bloom accumulates | neon line | translucent neon fill | Consolas, marker colour |
| steel | brushed metal plate | indicator lamp in a dark socket | lamp size and colour; light spill on the plate | spill accumulates | etched line | darker plate inset | #e8ebee, Consolas |
| topo | contour chart | survey dot (dark, light rim) | not on the dot; read the contours | KDE contours, 4 levels, faint fill | contour-coloured line | fill between two contours | #cfe6dd |

Rules that hold across themes:

- One family of markers per overlay. Deaths and kills on the same map use the same marker with two
  colours, never two marker styles.
- Counts appear as text only where a marker holds 3 or more; otherwise size or colour carries it.
- Nothing in an overlay may be dimmer than the background's brightest feature, or it disappears.
- Text is Segoe UI bold for numbers on markers, Consolas for tags; never smaller than 24 px at 1254.

## Planned uses

| Use | Data source | Overlay |
| --- | --- | --- |
| Deaths, last N games | audit `chart.deaths` | point marker + density (shipped first) |
| Kills and assists | timeline CHAMPION_KILL where killer or assist is me | point marker, second colour |
| Wards placed and cleared | timeline WARD_PLACED / WARD_KILL | small marker; cleared as hollow |
| First-back and roam paths | participant frames per minute | route line with minute ticks |
| Objective fights | ELITE_MONSTER_KILL ± 60 s, all champions | zone around the pit, markers for each death |
| One-trick comparison | otp_build timelines | same overlay, side by side, shared scale |

## Files

- `basic.png`, `blueprint.png`, `stone.png`, `holo.png`, `steel.png`, `topo.png`: backgrounds.
- `check-<theme>.png`: alignment proofs, Riot edges in red.
- Generation prompts: `../gpt-map-prompts.md`.
