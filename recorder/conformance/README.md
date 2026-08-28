# Conformance

`golden-transcript-only.aim4comms` was written by the site's own writer
(`../../shared/comms/format.js`). It is a real 23-round session in Portuguese
with a detected sync anchor and no audio.

A recorder is compatible when both hold:

1. It can read this file back into a manifest.
2. Its own output passes the site's verifier:

```bash
node ../../tools/comms/verify.mjs your-output.aim4comms
```

Regenerate the golden file from a demo in a local aim4 library with:

```bash
node tools/comms/make-fixture.mjs <demoId> --lang pt --out golden-transcript-only.aim4comms
```
