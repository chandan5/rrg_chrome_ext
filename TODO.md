# Pending Tasks

## Open Bugs

- [x] [P2] Preserve resolved benchmark symbol instead of defaulting to `^NSEI`.
  File: `popup.js` (around `pickBenchmark`, near lines 746-749 in review)
  Issue: resolved benchmark aliases from background (e.g. `NIFTY500.NS`) are rejected and reset to `^NSEI`, causing UI/storage mismatch with plotted data.

- [x] [P2] Clear `pendingAutoSymbol` even when symbol is already present.
  File: `popup.js` (around lines 334-336 in review)
  Issue: stale `pendingAutoSymbol` can persist and later re-add a removed stock unexpectedly.

- [x] [P3] Treat tab id `0` as a valid tab identifier.
  File: `background.js` (around lines 223-225 in review)
  Issue: truthy checks (`if (tabId)`, `if (!tab?.id)`) can mis-handle tab id `0`, breaking active-tab context resolution.
