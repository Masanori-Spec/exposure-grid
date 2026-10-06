# Verification scope

## Confirmed native feasibility baseline

- Source commit: `63fbf80fe76104c06b2c680b702c4240d9854de0`
- [Successful official consumer run](https://github.com/Masanori-Spec/exposure-grid/actions/runs/37407476753)
- Official stable Krita 5.3.4, reported build `57db7cd`
- AppImage SHA-256: `217c2f3cf17c2c604deb8708253ee6d2bd884f508424c20e788c562ddc50f24d`, 381,626,872 bytes, verified before execution
- Source: 12 FPS, frames 0–23. Converted: 24 FPS, frames 0–47
- Two-layer order, normal blending, full opacity, visibility, blank exposures, and exact keyframes preserved
- All five PNG assets byte-identical
- All 24 source and 48 output projected pixel planes match the handwritten oracle
- The 48-frame shifted control differs only at frame 12, exactly 100 upper-left pixels changing from blue to red

A second read of the raw artifact parsed the KRA XML independently and decoded all 120 PNG planes using Pillow, checking 30,720 RGBA pixels without importing the converter or native harness helpers. The artifact contained no vendor binary. Fontconfig warnings appeared on stderr; they did not affect the tested native metadata or pixels.

The exact half-up boundary mapping also matched a separate BigInt reference for 230,400 comparisons spanning every 1–120 source/target FPS pair and 16 selected boundary positions. This is strong bounded evidence, not exhaustive arbitrary-project compatibility.

## Product candidate checks

The current source adds safe ZIP IO, a Japanese/English responsive UI, verified receipt reimport, and a rounded 24→30 case. Local unit/oracle tests and build run before publication.

**Pending:** the first hosted run of the expanded product matrix, including actual browser-download bytes entering Krita, the rounded native case, and visual inspection of desktop/mobile screenshots. No browser or rounded-native PASS is claimed yet.

The rounded hand-authored fixture has six frames at 24 FPS and eight frames at 30 FPS. Its expected duration change is +1/60 second. The native gate checks this receipt independently and compares all six source and eight converted pixel planes.

## Limits of the claim

Only the stated Krita release and fixture/profile are tested. No guarantee is made for arbitrary `.kra` structures, every Krita version, TVPaint native import, unsupported PNG/profile metadata, or every browser. The output retains original PNG bytes; rounded timing deliberately may differ. A green opening/exit status alone never counts as a semantic pass.
