# Scope and evidence

Reviewed 2026-10-06. This is a small integration opportunity, not an exhaustive novelty search.

## Demand and existing alternatives

- The [2024 frame-rate recalculation request](https://krita-artists.org/t/a-way-to-recalculate-keyframes-to-different-framerate/103440) describes manually repositioning keyframes after changing FPS. One forum request is limited demand evidence.
- The solved [scaling-keyframes discussion](https://krita-artists.org/t/animation-scaling-keyframes/113391) recommends adding holds. [Official hold implementation](https://github.com/KDE/krita/blob/v6.0.4/plugins/dockers/animation/KisAnimTimelineFramesModel.cpp) adds the same number of holds to selected exposures. For boundaries 0,3,9,15, adding three holds gives 0,6,15,24; doubling the timings gives 0,6,18,30.
- [Krita timeline documentation](https://docs.krita.org/en/reference_manual/dockers/animation_timeline.html) covers movement, holds, and frame editing. Its documented FPS control is not an exposure rescaling operation.
- [KomauchiCSV](https://github.com/oja-bitterlife/KomauchiCSV_for_Krita) uses a separate CSV dialect for clone-layer visibility control, rather than retiming an existing TVPaint CSV exposure sheet.

## Interchange semantics

The [official CSV documentation](https://docs.krita.org/en/general_concepts/file_formats/file_csv.html) specifies the matching `.csv` and `.frames` pair, PNG cels, and document open/save rather than the image-sequence import/render menus. Groups and masks are not supported by the exchange format. TVPaint's own import route may require a script; ExposureGrid initially verifies Krita as its native consumer and makes no native TVPaint compatibility claim.

The pinned [v6.0.4 CSV loader](https://github.com/KDE/krita/blob/v6.0.4/plugins/impex/csv/csv_loader.cpp) counts row order rather than using numeric frame labels, treats unchanged image references as holds and empty references as blanks, casts FPS to integer, and may drop entirely blank layers. The [exporter](https://github.com/KDE/krita/blob/v6.0.4/plugins/impex/csv/csv_saver.cpp) writes integer FPS with six decimal places. ExposureGrid deliberately rejects ambiguous inputs instead of reproducing those permissive behaviors.

The official [CLI argument implementation](https://github.com/KDE/krita/blob/v6.0.4/libs/ui/KisApplicationArguments.cpp) supports `--export`, `--export-sequence`, and `--export-filename`. [CLI processing](https://github.com/KDE/krita/blob/v6.0.4/libs/ui/KisApplication.cpp) imports documents and renders their animation clip range. The external oracle inspects [KRA metadata](https://github.com/KDE/krita/blob/v6.0.4/plugins/impex/libkra/kis_kra_saver.cpp) and [keyframe metadata](https://github.com/KDE/krita/blob/v6.0.4/libs/image/kis_keyframe_channel.cpp) and compares actual rendered pixels.

## Native release selection

The [official September 2026 announcement](https://krita.org/en/posts/2026/krita-5.3.4-released/) identifies 5.3.4 as the productive Qt5 release and 6.0.4 as the more experimental Qt6 release built from the same source. The initial gate targets the official stable 5.3.4 Linux AppImage, approximately 364 MB, with an exact SHA-256 pin. Experimental 6.0.4 is not initially tested. A successful gate establishes only the tested release and fixture profile, not compatibility with every Krita release or arbitrary animation.

## Licensing boundary

[Krita's license page](https://krita.org/en/about/license/) permits application use and requires distributed extensions to comply with GPL. Consequently this project uses an external CLI harness, without a Krita Python plugin or linked extension code. Original converter source is independently written and no project-wide license has been assigned. Downloaded vendor files remain test-only and are excluded from release artifacts.
