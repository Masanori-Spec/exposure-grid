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

## First product browser/native baseline

- Product source commit: `b70f15ffc12a725bf26e53514313b263d511aade`
- [Run 37411065878](https://github.com/Masanori-Spec/exposure-grid/actions/runs/37411065878): `browser-download-native` passed; `official-native-gate` failed one Node 22 raw-deflate rejection test before native execution
- Sandboxed Chrome 154.0.8037.57 on Ubuntu 22.04 passed 19 browser scenarios, with no page errors or external requests from the offline app
- Actual downloaded exact and rounded ZIPs were independently extracted by Python and passed into official Krita 5.3.4 without regeneration
- All 134 rendered planes passed: 24 original +48 exact output +6 rounded source +8 rounded output +48 shifted control. This is 34,304 RGBA pixel checks
- Rounded conversion was 24→30 FPS, six→eight frames, with independently checked +1/60-second duration error

The first browser harness imported stored ZIPs only, so it did not establish browser deflate rejection. Source review also found the Japanese language button and FPS field cramped at 320px. These limits prevent treating that run as a completed release.

## Repair gates pending

Current source adds portable bounded RFC1951 framing validation rather than relying on a native decoder's trailing-data policy. Node 22 remains supported; ordinary valid deflate is not disabled to hide malformed-stream acceptance. The next hosted run adds independently generated deflated ZIP input, CRC-consistent trailing/concatenated/truncated controls, and an actual deflated-import export feeding the native gate.

Responsive checks now require unbroken language labels and visibly adequate room for target 120 FPS at 320px. Actual Japanese/English print PDFs and a dense later-boundary-page PDF are captured, text/page-count checked with Poppler, and rasterized for visual inspection. Printed output explicitly labels the current boundary page, not a complete receipt, and includes mode, output basename, and rounding acknowledgment state.

**Pending:** successful hosted checks for the repaired source and visual review of the new 320px and print evidence. The previous verified native/browser results remain valid only for their recorded baseline and coverage.

## Limits of the claim

Only the stated Krita release and fixture/profile are tested. No guarantee is made for arbitrary `.kra` structures, every Krita version, TVPaint native import, unsupported PNG/profile metadata, or every browser. The output retains original PNG bytes; rounded timing deliberately may differ. A green opening/exit status alone never counts as a semantic pass.
