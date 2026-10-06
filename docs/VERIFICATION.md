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

## Verified repair and release evidence

- Functional application commit: `c7e2d66133302f4d1d147c581100cce00b3f17b3`
- [Run 37415185525](https://github.com/Masanori-Spec/exposure-grid/actions/runs/37415185525): both `official-native-gate` and `browser-download-native` passed
- 116 JavaScript tests passed on hosted Node 22; 18 Python oracle/preparation checks passed
- Sandboxed Chrome 154.0.8037.57 on Ubuntu 22.04 passed 28 browser scenarios, with zero page errors and zero external requests from the offline HTML
- Standalone HTML: 103,422 bytes; SHA-256 `030a6ce1f56d9c042c693098c6675efa6ef54f31bba795d71e60763441ee2461`

### Portable ZIP safety

Raw-deflate framing is validated before native inflation. The validator checks block/tree/symbol/backreference framing, the final block and exact compressed byte ending, with bounded work and periodic yields. Ordinary valid deflate remains enabled on Node 22; malformed-input rejection is not delegated to that runtime's tolerant decoder.

Real Chrome imported an independently generated Python-deflated source ZIP and rejected CRC-consistent trailing, concatenated, and truncated deflate controls. The actual converted ZIP from that deflated import was the exact-mode package subsequently opened by Krita. Independent review additionally checked 1,280 valid differential streams, mutation and trailing corpora, handwritten format edges, and a deliberately permissive native inflater.

### Actual file handoff and native semantics

Python's ZIP reader independently extracted the actual browser downloads. The native preparation and consumer rechecked those bytes without regenerating them. Each native job checked 134 rendered planes and 34,304 RGBA pixels: 24 original, 48 exact output, 6 rounded source, 8 rounded output, and 48 shifted-control frames.

KRA layer order, blend/visibility/opacity, FPS, clip ranges and keyframes matched the handwritten expectations. Every PNG input retained its original hash. The rounded 24→30 case changed six frames into eight with a +1/60-second duration error; its complete rational receipt matched the independent oracle. The shifted control changed only the intended 100 pixels at frame 12 and failed the original expectation there.

A second review independently decoded all 134 planes in each artifact with Pillow and parsed KRA XML. It verified the archive digests, original/download/native byte handoff, all image hashes and both rational receipts. No converter or native-harness helper supplied its expected pixels.

### Desktop, mobile and print

All 11 UI screenshots were inspected, including Japanese/English desktop layouts, 390px/320px viewports, and the 120 FPS control with unbroken language labels at 320px. Keyboard navigation, acknowledgment reset, cancelled selection, stale import/clear/export operations, malformed inputs, receipt mismatch and dense boundary pagination were exercised.

Three actual print PDFs produced four raster pages: one Japanese rounded review, one English rounded review, and a two-page dense boundary-page review. Text/page-count checks and independent visual inspection passed. Printing explicitly labels the current boundary page/range/total, output basename, mode, and rounding acknowledgment state. It does not imply a complete printed receipt; the JSON receipt remains the complete record.

### Evidence integrity

- Official-native artifact ZIP SHA-256: `77c01f1ae31d994b1b012ab763ff92d69d69a2489523faa7b17fe3780a73262a`
- Browser-download/native artifact ZIP SHA-256: `5c33c96337e1e640cf33895de7c3d470447588267c991aa3413ecc1763e6e09d`
- The remote 45-file functional source tree, repository ZIP and hosted HTML matched the reviewed local source/build byte-for-byte
- The release closeout changes documentation and adds the verified preview image; application, tests, workflow and standalone HTML are unchanged from the functional commit above

## Limits of the claim

Only the stated Krita release and fixture/profile are tested. No guarantee is made for arbitrary `.kra` structures, every Krita version, TVPaint native import, unsupported PNG/profile metadata, or every browser. The output retains original PNG bytes; rounded timing deliberately may differ. A green opening/exit status alone never counts as a semantic pass.
