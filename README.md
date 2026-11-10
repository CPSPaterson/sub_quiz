# Sydney Suburb Quiz

An interactive map quiz for 724 Greater Sydney suburbs. Zoom and pan the map freely, on
satellite imagery (no place names) or a plain background.

**Modes**
- **Name them all**: type suburb names, and each one turns green on the map as you get it.
  Matching ignores case and punctuation, and treats Mount/Mt and Saint/St as the same.
  If a name is the start of a longer one ("Bondi" / "Bondi Beach"), it waits a second
  or for Enter before accepting.
- **Find on map**: a suburb is named, and you click it. Green = first try, orange = 2–3 tries,
  red = missed. After 3 wrong clicks, or a skip, the map zooms to the answer.

**Regions**: play all of Sydney or one of 10 regions (groups of council areas). Suburbs
outside the chosen region are dimmed. The ⤢ button zooms back out to the region.

## Running

It needs a local web server (browsers block loading the data from `file://`). Either:

```bash
python3 -m http.server 5500     # then open http://localhost:5500
npm start                       # same, using http-server via npx
```

The whole app is static files (~1.6 MB of data), so you can copy the folder to any computer
or host it on GitHub Pages / Netlify. All paths are relative, so it works from a
sub-folder such as `cpsp-labs.com/sub_quiz/`.

Background maps (all free, no API keys, labels removed so they don't give answers away):
- **Street**: OpenFreeMap vector tiles, drawn with MapLibre GL
- **Satellite**: Esri World Imagery
- **Outlines only**: no background, works offline

## Files

- `index.html`, `src/app.js`, `src/style.css`: the app
- `src/names.js`: name matching and small helpers
- `src/data/suburbs.geojson`: simplified suburb boundaries used by the app
- `tests/basic.test.js`: run with `npm test` (Node's built-in test runner)

## Rebuilding the suburb data

1. `suburbjsons/suburb/*.geojson`: all NSW suburbs (raw source)
2. `suburbjsons/filter.py`: keeps Greater Sydney → `suburbjsons/almost.geojson` (needs `shapely`)
3. `tools/build_data.py`: simplifies and shrinks that → `src/data/suburbs.geojson` (no dependencies).
   It also drops water-only areas and tags each suburb with a region using council boundaries
   in `suburbjsons/lga.geojson` (ABS 2021 LGAs). Edit `WATER_ONLY` and `REGIONS` at the top to change them.

```bash
python3 tools/build_data.py     # optional args: input output tolerance_degrees
```
