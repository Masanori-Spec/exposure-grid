# ExposureGrid

An offline browser tool for converting the exposure timing of Krita TVPaint CSV animations to another integer frame rate. Japanese and English, with no runtime services or dependencies.

**Verified release:** [both hosted jobs passed](https://github.com/Masanori-Spec/exposure-grid/actions/runs/37415185525) for the application at `c7e2d66133302f4d1d147c581100cce00b3f17b3`: 116 Node 22 tests, 18 Python checks, 28 sandboxed browser scenarios, actual exact/rounded ZIP downloads reopened in official Krita 5.3.4, and independently reviewed responsive/print evidence. See [verification scope](docs/VERIFICATION.md) for the tested profile and limits.

## Use

1. Build with `npm run build`, then open `dist/exposure-grid.html` directly in a browser. It works from a local file without a server
2. Try the original sample, or use Krita's document **Save As → CSV** workflow
3. ZIP the CSV and its matching `.frames` folder together at the archive root
4. Choose a target FPS and exact or rounded timing policy
5. Review the layers, every boundary's rational timing error, and total duration
6. Download the new ZIP, extract it, and open the renamed CSV in Krita

Keep your original `.kra`. This tool cannot recover features already lost during CSV export. It is not a complete Krita project converter or a verified TVPaint importer.

## What changes, and what stays intact

Changing FPS alone changes playback speed. ExposureGrid instead maps each exposure boundary to the target frame grid, including the clip's exclusive ending. Drawing references, blank exposures, and the layer stack remain in their existing order. PNG bytes are validated and copied without re-encoding.

- **Exact:** succeeds only if every exposure boundary and the clip ending align exactly
- **Rounded:** nearest target frame, with halfway cases rounded forward; the UI shows signed rational timing errors and requires acknowledgment when any boundary moves in time
- **Collapsed exposure:** blocks the whole conversion. No drawing or blank is silently removed or merged
- **Receipt:** the ZIP includes a complete JSON record of source/target boundaries and durations. Reimporting a tool-generated ZIP validates that receipt against the CSV before using it

For example, 24 FPS with six source frames can become eight frames at 30 FPS: 1/4 second becomes 4/15 second, a +1/60-second change. Rounded conversion does not promise exact timing preservation.

## Supported input

- One root `name.csv` in Krita's TVPaint CSV 1.0 form, with matching `name.frames/` PNG files
- Integer-valued FPS 1–120, including serialization such as `12.000000`
- Zero-based contiguous rows, square pixels, progressive frames
- Distinct, visible, full-opacity, normal-blend ordinary paint layers, each with at least one nonblank exposure
- Non-interlaced, canvas-sized, 8-bit RGB/RGBA PNGs
- Safe ASCII file/directory names; UTF-8 project and layer names
- Conventional stored or deflated single-volume ZIPs, including ordinary directory records and data descriptors

Folder overrides, missing or unreferenced assets, inconsistent metadata, entirely blank layers, duplicate/case-ambiguous paths, ZIP links, encryption, ZIP64, unsafe names, and unsupported archive extensions are rejected. Groups, masks, transform/opacity animation, audio, and arbitrary `.kra` metadata are outside the profile. Do not add unrelated files or operating-system metadata folders to the ZIP.

## Limits and privacy

- 100,000 frames, 64 layers, 20,000 total exposures
- 16 MiB CSV, 32 MiB individual file/receipt, 128 MiB total package, 136 MiB compressed ZIP ceiling
- PNG decode limit: 64 MiB per image and 256 MiB across the package
- ZIP entries: 4,096, including directory entries and the output receipt; adversarial alternate-directory metadata is bounded to 32,768 header checks; raw-deflate framing has a 4,194,304-unit aggregate work limit and yields periodically
- Timeline bars show at most the first 100 exposures per layer, with an explicitly labeled remainder. Every boundary remains accessible through pagination and in the complete receipt

Files stay in memory in the current tab. There are no uploads, accounts, telemetry, or network dependencies. Only the selected language is saved locally. The built HTML's content policy blocks network connections.

Exports snapshot the reviewed settings, receipt, and image bytes before asynchronous validation. Changing the source, timing, name, or acknowledgment invalidates a pending download. File-chooser cancellation leaves existing reviewed work intact.

## Development and verification

Requires Node.js 22+ and Python 3. The core and build have no package dependencies. Playwright is a pinned test-only dependency.

```sh
npm ci --ignore-scripts
npm test
python3 -m unittest discover -s tests -p '*_test.py' -v
npm run build
npm run prepare:gate
python3 scripts/native-gate.py --verify-inputs-only
```

`npm run dev` serves the app on localhost:4173. The hosted browser workflow uses sandboxed Chrome on Ubuntu 22.04; it does not disable the browser sandbox. It checks Japanese/English desktop/mobile layouts, keyboard access, actual downloads, malformed input, receipt mismatch, cancellation, pagination, and stale asynchronous operations.

Browser print uses the current boundary page only, labeled with page/range/total, output name, mode, and acknowledgment state. The complete JSON receipt always remains the full record. Test PDFs are independently text-checked and rasterized for visual review.

The actual browser-downloaded exact and rounded ZIPs are independently extracted by Python's standard-library ZIP reader. Those exact CSV/PNG/receipt bytes feed the official native consumer, without substituting regenerated outputs.

### Official native gate

The workflow downloads a pinned, SHA-256-verified stable Krita 5.3.4 AppImage from a KDE-listed non-university mirror into temporary hosted storage. No local GUI installation, Krita source build, or plugin is required. Vendor binaries never enter the source or app artifacts.

The external CLI harness imports CSV into native KRA files, checks native FPS/range/layers/keyframes, reopens the KRA, and renders every frame. A hand-authored independent oracle checks every RGBA pixel. Exact, rounded, original-source, and deliberately shifted cases are included. The shifted control must both match its intended altered pixels and fail the original timing expectation. Fresh input/output directories prevent stale results from satisfying the gate.

## Evidence, alternatives, and rights

The opportunity is a small integration improvement over manually repositioning unequal exposures or adding a constant number of holds. It is not a novelty or patent claim. See [research](docs/research.md).

No project-wide open-source license has been selected for original code or artwork. All fixture artwork is original. No Krita source, binary, or extension is bundled. See [third-party notices](THIRD_PARTY_NOTICES.md).

## Preview

Japanese rounded-timing review, captured from the verified offline app. English is also available.

![ExposureGrid desktop showing rounded timing, layer exposures, and per-boundary rational errors](docs/preview-desktop-ja.png)
