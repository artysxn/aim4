# demoparser

Self-contained demo parsing. Everything that knows how to read a `.dem` lives
in this folder, behind one function:

```js
import { parseDemo } from './demoparser/index.js';
const demo = await parseDemo('/abs/path/match.dem', { onProgress });
```

The current adapter wraps [LaihoE/demoparser](https://github.com/LaihoE/demoparser)
(`@laihoe/demoparser2`).

## Why it is a folder

The rest of the backend never imports a parser package, never sees a parser
type, and never learns a parser's field names. It only sees the normalized
shape in `schema.js`. That is the whole contract, so upgrading the parser,
or replacing it outright, touches this folder and nothing else.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Adapter registry, selection, validation. The public entry point. |
| `schema.js` | The normalized shape + `validateDemo()`. The contract. |
| `economy.js` | Team buy -> the economy digit in a round name. Tunable. |
| `adapters/laihoe.js` | Everything specific to `@laihoe/demoparser2`. |

The binary per-tick layout is **not** here: it is shared with the browser at
`src/replays/shared/tickFormat.js`, so the writer and the reader can never
drift apart.

## Installing the parser

The native module is an optional dependency, so the site builds and runs
without it (the library UI reports parsing as unavailable):

```bash
npm install @laihoe/demoparser2
```

## Local parse (recommended for production)

Server-side `.dem` parsing is heavy. Prefer parsing on the user's PC and
uploading an `.aim4replay` package:

```bash
npm install @laihoe/demoparser2
# Drag-and-drop GUI (Windows):
tools\parse-demo.bat
# Or CLI:
npm run parse-demo -- path\to\match.dem
```

That writes `match.aim4replay` next to each demo. Upload the package on the
Replays page (`POST /api/replays/import`). Round filenames inside the package
are built with the same `buildRoundId` / ingest path the server uses.

## Upgrading the parser

1. `npm install @laihoe/demoparser2@latest`
2. Run a demo through it and read the console. `adapters/laihoe.js` probes
   props defensively: it tries `FULL_PROPS` once, and on rejection falls back
   to `CORE_PROPS` for the rest of that demo. A new parser version that
   renames a prop degrades to core props rather than crashing, so check that
   the fields you care about still arrive.
3. `validateDemo()` runs on every parse. If an upgrade silently drops rounds
   or tick buffers, the parse fails loudly instead of storing empty replays.

## Swapping in a different parser

1. Copy `adapters/laihoe.js` to `adapters/<yours>.js`.
2. Implement four exports:

   ```js
   export const name = 'my-parser';
   export function isAvailable() { /* can it run here? */ }
   export function version() { /* string */ }
   export async function parseDemo(file, { onProgress }) { /* NormalizedDemo */ }
   ```

3. Register it in `index.js`:

   ```js
   import * as mine from './adapters/mine.js';
   const ADAPTERS = { laihoe, mine };
   ```

4. Select it with `AIM4_DEMO_PARSER=mine`, or delete the old adapter to make
   yours the only one.

Nothing outside this folder changes. Round names, storage, the two-pass
timeline loader and the viewer all keep working, because they are written
against `schema.js` and `tickFormat.js` rather than against a parser.

## What a parse must produce

Per round, for **every player on every tick**: position, view angle, health,
armor, active weapon, and state flags, packed into the tick buffer. Alongside
it: the full freezetime loadout, every kill/death/assist, every shot fired
with its weapon, and every grenade with its throw tick, flight path and
detonation point. `schema.js` documents each field.

## Economy digits

`economy.js` maps a side's freezetime buy to one digit:

| Digit | Meaning |
| --- | --- |
| 0 | Pistol round |
| 1 | Eco |
| 2 | Half buy |
| 3 | Force buy |
| 4 | Full buy |
| 5 | Full buy with an AWP |

Thresholds are heuristics and are meant to be tuned. Changing them affects
rounds parsed from then on: a round name is assigned once, at parse time, and
is never rewritten, since the name is the database key.
