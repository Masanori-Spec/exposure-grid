# ExposureGrid

Source-only feasibility stage for an offline, exposure-preserving Krita TVPaint CSV timing converter. **The native consumer gate is not yet verified. No product UI has been built.**

## Why this exists

Changing animation FPS alone changes playback speed. ExposureGrid maps existing exposure boundaries onto another integer-FPS timeline while retaining the drawing references, layer order, and blank exposures. It is intended to replace manually repositioning a mixed-length exposure sheet.

Existing Krita controls can move frames or add the same number of holds to selected exposures. Multiplying unequal exposure lengths is a different operation. This is a bounded integration improvement, not a novelty or patent claim. See [research](docs/research.md).

## Current supported profile

- A root `name.csv` in Krita's exported TVPaint CSV 1.0 form and matching `name.frames/` PNGs
- Integer-valued FPS from 1 to 120, including decimal serialization such as `12.000000`
- Zero-based contiguous rows, square pixels, progressive frames
- Distinct, visible, full-opacity, normal-blend ordinary layers, each containing at least one nonblank exposure
- Non-interlaced, canvas-sized, 8-bit RGB/RGBA PNG images
- Explicit blank exposures and repeated-image holds

Unsupported metadata, folder overrides, missing or unreferenced assets, duplicate/case-ambiguous paths, unsafe names, and inconsistent counts are rejected. Loading performs structural PNG preflight; every export additionally validates the zlib stream, exact decoded scanline length, and row filters, with 64 MiB per-image and 256 MiB aggregate decoded limits. PNG bytes remain unchanged. Before expansion or download, exports enforce a 16 MiB CSV cap, a 32 MiB review-receipt cap, and a 128 MiB total package cap. CSV cannot convey the complete Krita project. Groups, masks, transform/opacity animation, audio, color-management variants, and arbitrary project metadata are outside this profile. Exporting a `.kra` with unsupported features can already lose those features before this tool sees the CSV; this tool cannot detect everything discarded upstream.

This initial implementation exposes a core module and tests. ZIP ingestion and the browser product are intentionally deferred until official native verification succeeds.

## Timing policy

Each source exposure boundary `k`, including the exclusive clip end, maps by integer half-up rounding:

`floor((2 * k * targetFPS + sourceFPS) / (2 * sourceFPS))`

- Exact mode requires every boundary and the ending to land exactly on target frames
- Rounded mode reports signed rational timing error for each boundary and for total duration
- A collapsed exposure blocks conversion. No drawing or blank is silently dropped or merged
- Output CSV and its matching `.frames` directory receive the same new basename
- Image bytes are copied unchanged; a JSON review receipt records timing changes

## Verify locally without Krita

Requires Node.js 22+ and Python 3. No npm packages are needed at this stage.

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py' -v
npm run prepare:gate
```

## Official native gate

The hosted workflow downloads the pinned, hash-verified official stable Krita 5.3.4 AppImage from a KDE-listed non-university mirror into temporary test storage. It does not build Krita from source, include the binary in this project, or use an extension/plugin. The external harness invokes only the application's CLI:

1. Open the original 12 FPS / 24-frame CSV and the 24 FPS / 48-frame converted CSV, exporting each to a native KRA
2. Inspect native KRA XML for FPS, inclusive clip range, the two-layer stack, opacity/blend/visibility, and the exact raster keyframe positions
3. Reopen each native KRA and run Krita's `--export-sequence`
4. Compare all 256 RGBA pixels on every source frame and all 48 target frames against a hand-authored oracle
5. Verify the shifted control's exact native keys and intended pixels, then require the unchanged original oracle to reject only frame 12
6. Check SHA-256 identity of all five original and exported PNG files

Each invocation uses a fresh native-output directory, so a no-op CLI cannot pass by reusing stale results. The oracle is handwritten in `fixtures/oracle.json` and does not import converter code. Fixtures are original 16×16 artwork. CI artifacts include native KRA files, exported PNG sequences, XML metadata, logs, and the machine-readable gate result. Opening successfully is not sufficient for a PASS.

## Rights and dependencies

No project-wide open-source license has been selected for original code or artwork. No Krita source or binary is bundled. Krita's own licenses and vendor notices remain with its official distribution. The external test harness does not import Krita's extension API. See [third-party notices](THIRD_PARTY_NOTICES.md).
