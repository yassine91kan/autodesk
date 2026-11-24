# Augmented: plan to production

Written 2026-11-10 for an agent (Opus 5.5) to execute phase by phase. Each phase is
independently shippable. Do them in order; do not start a phase until the previous one's
"Done when" list is fully green.

**Goal of the product:** a user uploads a Revit model, the server converts it into a SQL
database, and the user asks questions in plain language that are answered by queries on
that database, with the matching elements highlighted in the 3D viewer.

## Ground rules (read first, apply to every phase)

1. **Pushing to `main` deploys to production.** Render auto-deploys
   `augmented-zvkd.onrender.com` on every push. Work on a branch per phase
   (`prod/phase-1-golden`, ...). Never push to `main`, merge, or force-push without the
   user's explicit go-ahead in that conversation.
2. **The working tree has uncommitted work by the user** (login, landing page, contact
   form, design files). Do not revert, reformat or commit those files. Before Phase 1,
   ask the user to commit or stash them, and branch from the result.
3. **OpenAI calls cost money.** Everything in `npm test` and `test/probe/` runs with
   OpenAI stubbed (0 tokens). Never run `test/eval.js` or anything else that reaches the
   real OpenAI API without first telling the user how many paid questions it is and
   getting a yes. Default cap: 20 paid questions per phase.
4. **Never edit `.env` or `config.js` secrets, and never print them.**
5. **Keep the response shape of `POST /ask_agent_simple` unchanged** (`action`, `answer`,
   `objectIds`, `message`, `data`, `tier`, `lane`, `plan`, `token`, `budget`, `cache`).
   The page (`wwwroot/main.js`) and the MCP server (`routes/mcp.js`) depend on it. Adding
   fields is fine; removing or renaming is not.
6. **Code style:** match the existing files: CommonJS, small functions, a plain-English
   comment above each function saying what and why, no new dependencies unless a step
   names one.
7. After every phase: `npm test` passes, the probe tallies are reported in the phase
   summary, and the summary lists anything skipped or unverified.

## Where things are

| Path | What it is |
|---|---|
| `routes/ask_agent_simple_v2.js` | HTTP layer: `/ask_agent_simple`, `/feedback`, `/model_positions`, `/model_status` |
| `augmented/hybrid.js` | Default planner. Lanes: gate, template, cache, sql, `old` |
| `augmented/sqlplanner.js` | OpenAI writes one SQL query; `checkSql`, `runChecked`, `shapeResult` |
| `augmented/clean.js` | Builds `elements_clean` (one row per element) and `clean_sources` |
| `augmented/store.js` | Per-model SQLite index, `SCHEMA_VERSION`, disk cache under `DATA_DIR/indexes` |
| `augmented/spatial.js` | `positions` table, nearest-neighbour spacing |
| `augmented/planner.js`, `matcher.js`, `plans.js`, `engine.js` | The older tiered planner. Only reached via the `old` lane (spatial words) or `PLANNER=tiered` |
| `augmented/words.js` | Every hand-written word list, `toWords` |
| `test/harness.js` | Fake model + fake OpenAI used by `npm test` |
| `test/probe/probe.js` | Zero-token probe on the REAL models (downloads from APS once, caches in the OS temp dir) |
| `test/probe/*.json` | 334 probe questions: `rst-general`, `rst-edge`, `rst-spatial`, `sea-general` |

Probe usage:

```bash
node test/probe/probe.js rst describe
node test/probe/probe.js rst ask test/probe/rst-general.json
node test/probe/probe.js rst askpos test/probe/rst-spatial.json
node test/probe/probe.js sea sql "SELECT category, COUNT(*) n FROM elements_clean GROUP BY 1"
```

`rst` = rstbasicsampleproject.rvt (845 elements), `sea` = Seaport-Civic-Center (15,147).
Output per question: `[lane] question`, then the SQL and the answer. `[LLM]` means the
question would have cost tokens.

---

## Phase 1: Golden regression set

Nothing else is safe to change until wrong answers fail a test.

1. Create `test/golden/rst.json` and `test/golden/sea.json`. Each case:
   `{ "q": "...", "lane": "template" | "gate" | "llm" | "spatial", "count": 198, "answerMatches": "regex", "note": "why" }`.
   Only `q` is required; assert whichever other fields are present. `"lane": "llm"` means
   "must NOT be answered by code".
2. Create `test/run_golden.js`. Reuse the stubbing and model loading from
   `test/probe/probe.js` (factor the shared part into `test/probe/load.js`). It prints
   PASS/FAIL per case and exits 1 on any failure. It needs APS access, so it is NOT part
   of `npm test`; add `"test:golden": "node test/run_golden.js"` to `package.json`.
3. Seed it with the cases in the table below (expected values were verified against the
   clean table on 2026-11-10), plus every probe question that today gives a correct
   template answer (take the current output as the expectation after reading each one;
   do not blindly snapshot).

| Model | Question | Expected | Today |
|---|---|---|---|
| rst | how many joists are there? | 198 (`usage = 'Joist'`) | 123 |
| rst | show the timber joists | 198 | 27 |
| rst | purlins | 102 (`usage = 'Purlin'`), answered by code | LLM |
| rst | how much concrete is in the model? | a total volume (215.875 m³ over 17 elements, 32 without a volume), not a list | list of 49 |
| rst | how much steel is there? | a total weight, not a list | list of 105 |
| rst | highest beam | must not rank by length: lane `llm` until elevations exist (Phase 4) | 15 m by length |
| rst | top 5 longest beams | template, 5 elements, 15 m to 13.5 m | LLM |
| rst | the five longest beams | same | LLM |
| rst | North Stair / curtain grids / structural connections / hosted elements | must not be refused by the gate | gate refusal |
| rst | close the selection and show the beams | 370 framing, not spatial | spatial misroute |
| rst | beams close to 6 m long | not spatial | spatial misroute |
| rst | chain: "beams on level 2" then "how many are steel?" | treated as a follow-up (17), not 105 | 105 |
| sea | how many lights | 2606 (Lighting Fixtures) | 42 |
| sea | elements on the roof | level G-Roof (471), or a clarification; never the 15 Roofs silently | 15 |
| sea | chairs | must not include `Table-Dining Round w Chairs` | 528 incl. tables |

**Done when:** `npm run test:golden` runs, and fails on exactly the "Today" rows above
(that proves the tests see the bugs). Commit the failing set; Phase 2 turns it green.

## Phase 2: Fix the confirmed misreads

All in `augmented/hybrid.js` unless stated. One commit per fix, each making its golden
cases pass.

1. **"top N longest"**: in `readPlain`, the `RANK_COLUMNS[word]` branch returns null when
   `rank` was already set by `top N`. Merge instead: keep the limit, fill `word`,
   `column`, `order`. Also accept number words before a rank word ("the five longest":
   `NUMBER_WORDS[before]` exists but `five` is consumed earlier as unknown; check the
   order of branches).
2. **Usage values in the template vocabulary**: in `namesOf`, add each distinct `usage`
   value as `{ kind: 'usage', value }`, and give it priority over family words when the
   same word matches both ("joist"). Add `usage` to `found`, the filters and
   `buildTemplate` (`usage = ?`). When a word matched a usage AND family words that
   select a different set, append one sentence to the answer:
   "Counted by Revit's Structural Usage; N more elements have 'joist' in their family name."
3. **Category words beat family words**: in `namesOf`, a word must not become a family
   word if it is a word of any category NAME in this model ("light" is in "Lighting
   Fixtures"). Add everyday words to `CATEGORY_WORDS` in `augmented/words.js` for
   `Lighting Fixtures` (light, lighting, luminaire), `Furniture`, `Plumbing Fixtures`,
   `Planting` (tree, plant), `Casework`, `Generic Models`, `Curtain Panels`,
   `Curtain Wall Mullions` (mullion).
4. **Family words must be the head of the name**: "chairs" matched
   `Table-Dining Round w Chairs`. A family word only counts when it is in the first
   segment of the family name (before the first `-`, ` w `, or `with`).
5. **"how much <material>"**: port the tiered planner's implied-measure rule
   (`MATERIAL_QUANTITY` in `words.js`, `wantsTotal` in `plans.js`): "how much" + a
   material and no measure = sum of `volume_m3`, or `weight_kg` for steel.
6. **Level vs category for every collision**, not just "Foundation": generalise the
   `onLevel` rule so that after "on / at / in the", a word that is both a category word
   and part of exactly one level name resolves to the level ("on the roof" with a level
   `G-Roof`). If it is part of several level names, return a clarification listing them.
7. **Follow-up fragments**: in `isFollowUpQuestion`, also treat as a follow-up a question
   that (a) has a previous answer, (b) names no category, and (c) is a fragment: starts
   with "how many are/of", or has no noun that `readPlain` resolved to a category.
   Mirror `isFollowUp` in `plans.js`, which already encodes these rules.
8. **Gate after names**: in `answerHybrid`, run `readPlain` before `gate`'s `NOT_IN_DATA`
   patterns, and skip a pattern when the word that triggered it is part of a name in
   this model (`namesOf(model).phrases` or `familyWords`). Keep `ABOUT_ME` first.
9. **Spatial routing**: replace "any `SPATIAL_WORDS` word anywhere" with a pattern test:
   the question must contain `distance|spacing|spaced|apart|how far` or
   `(near|nearest|closest|close|adjacent|next) to`, or `farthest|furthest`. "close the
   selection" and "close to 6 m long" (a number + unit after "close to") must not match.
10. **"highest / lowest"** of beams, floors, anything without `height_m`: return null from
    `readPlain` (LLM decides) instead of swapping to length. Keep the swap for
    `longest/shortest` columns only.
11. **Zero results explained by code**: in `buildTemplate`, when a count/list finds 0 and
    there are 2+ filters, run the query once per dropped filter and add one sentence:
    "There are 9 Walls, on: Foundation (9)." Cap at 5 values.
12. **Column weights** (`augmented/clean.js`, `fillHeightsFromPositions`): after filling
    `height_m` for Structural Columns, set `weight_kg = weight_kg_per_m * height_m` where
    both exist and `weight_kg IS NULL`, append `weight_kg` to `derived`, and record it in
    `clean_sources`.

**Done when:** `npm test` and `npm run test:golden` pass; the four probe files show no
`[template]` answer that contradicts the golden table; summary lists the new tallies.

## Phase 3: Make the SQL lane safe

File: `augmented/sqlplanner.js`. Offline tests go in `test/run_sql_safety.js` (add to
`npm test`).

Verified holes today: `FROM elements_clean e, properties p` is accepted (comma joins
skip the table check); `FROM elements_clean a JOIN elements_clean b` is accepted (229
million rows on Seaport, on a synchronous driver, blocks the whole server); legitimate
values are refused (`category = 'Create Parts'`, `level = 'A;B'`) because the forbidden
words and `;` are matched inside string literals.

1. **Table allowlist from the query plan, not regex.** After `db.prepare` succeeds, run
   `EXPLAIN <sql>` and collect every `OpenRead` / `OpenWrite` row; map its root page
   (`p2`) to a table via `SELECT name, tbl_name, rootpage FROM sqlite_master`. Refuse if
   any page belongs to a table outside the allowlist or if any `OpenWrite` appears.
   First check the installed `better-sqlite3` version for a native authorizer API; if it
   has one, use that instead.
2. **Strip string literals before the keyword and `;` checks**, so values can contain
   any word. Keep `stmt.readonly` as the real guarantee.
3. **Time limit.** Run LLM-written SQL in a `worker_threads` worker that opens the
   model's index file read-only, and terminate it after 3 s with a clear message. This
   needs file-backed indexes: when `DATA_DIR` is unset, fall back to the OS temp dir so
   every model has a file. Template SQL stays on the main thread.
4. **Read-only connection.** The worker opens with `{ readonly: true, fileMustExist: true }`.
5. Allowlist after this phase: `elements_clean` only. Phase 4 extends it.

**Done when:** the three holes above are covered by tests that pass; a
`WITH RECURSIVE` runaway and a self cross join both return within 3.5 s with a refusal.

## Phase 4: The full schema (the "Revit to SQL" conversion)

Raise `SCHEMA_VERSION` in `augmented/store.js`. All built at index time in one
transaction, in the same per-model file.

1. **Rename nothing.** `elements_clean` stays as the core table.
2. **`element_props`**: every property of every element, typed:

   ```sql
   CREATE TABLE element_props (
     objectid INTEGER, grp TEXT, name TEXT,     -- "Identity Data", "Fire Rating"
     value_text TEXT, value_num REAL, unit TEXT, kind TEXT,  -- kind: length|area|volume|mass|angle|number|text
     PRIMARY KEY (objectid, grp, name)
   ) WITHOUT ROWID;
   CREATE INDEX idx_props_name ON element_props(name, value_text);
   ```

   Fill it from the existing `properties` table with `parseMeasure` (`clean.js`);
   `value_num` is in base units (m, m², m³, kg). Skip placeholder values.
3. **`prop_catalog`**: one row per `(category, grp, name)` with element count, kind,
   min/max for numbers, and up to 20 most common text values. This is the data
   dictionary the LLM is shown.
4. **`levels`**: `name, elevation_m`. Source in order: (a) level elements in the APS
   property dump if present; (b) derived from geometry (step 5): the median `min_z` of
   Floors on that level; (c) NULL. Record which in a `source` column.
5. **`geometry`**: replaces `positions`:
   `objectid PRIMARY KEY, min_x, min_y, min_z, max_x, max_y, max_z, cx, cy, cz, source, version`.
   Add `elevation_m` (= `min_z`) and `top_m` (= `max_z`) as columns on `elements_clean`.
   **Spike first (time-box: half a day):** find out whether bounding boxes can be read
   server-side from the APS derivative for these models (SVF2 for Seaport, SVF for
   rstbasic). Write the finding at the bottom of this file. If yes, fill `geometry` at
   index time. If no, keep the viewer upload but harden it (Phase 6, step 4).
6. **Views for the LLM**: `CREATE VIEW elements AS SELECT * FROM elements_clean` is not
   needed; instead extend the Phase 3 allowlist to
   `elements_clean, element_props, prop_catalog, levels, geometry`.
7. Extend `describeCleanTable` to add, per category, the 15 most-filled `element_props`
   names from `prop_catalog` (name + kind). Keep the whole description under 2,500 tokens
   on Seaport; measure with a character count / 4.
8. Update `SQL_PROMPT`: explain `element_props` with one example
   (`JOIN element_props p ON p.objectid = e.objectid AND p.name = 'Fire Rating'`), the
   `levels` table ("above level 2" = `elevation_m >= (SELECT elevation_m FROM levels WHERE name = ...)`),
   and remove the rule saying elevations do not exist once `levels` is filled.
   Changing the prompt changes `PROMPT_VERSION`, which correctly empties the plan cache.

**Done when:** both models rebuild under the new schema version; `test/run_clean.js` is
extended to cover `element_props`, `prop_catalog`, `levels`; index build time and file
size for Seaport are reported (flag it if the build exceeds 60 s or the file 200 MB).

## Phase 5: One query path, spatial included

1. **New module `augmented/resolve.js`**: move `namesOf` out of `hybrid.js` and make it
   the single lexicon: categories, levels, usage, function, material class, families,
   types, marks. Fixed priority: category > level > usage > function > material >
   type/family whole name > family word. It returns
   `{ entities: [...], ambiguous: [{ word, options }], unknown: [words] }`.
   Add typo correction from `matcher.js` (`editDistance`, distance 1, words of 5+
   letters, only when exactly one candidate).
2. **Deterministic "not in this model"**: if a question's only noun resolves to a
   `CATEGORY_WORDS` category that this model lacks ("ceilings", "doors" on rstbasic), or
   to `level <n>` where no level name contains that number, answer from code and list
   what exists. If "level 2" matches several levels (Seaport: `O-Level 2`, `PH-Level 2`),
   return a clarification naming them.
3. **Narrow the template lane** to what it can prove: every content word resolved with
   no ambiguity, forms count / list / group / sum / avg / rank. Anything else goes to
   the SQL lane with the resolved entities passed as a hint line in the user message
   ("Resolved: beams = category 'Structural Framing'; level 2 = 'Level 2'").
4. **New module `augmented/spatialops.js`** on the `geometry` table. Distances are
   box-to-box (0 when boxes overlap), with `horizontal` and `vertical` parts; centre to
   centre only for categories that are points on plan (columns, pile caps). Operators:
   - `spacing(set)`: nearest-neighbour summary (move today's logic here)
   - `between(a, b)`: two elements or two sets (minimum distance, and which pair)
   - `nearest(set, reference, k)`: the k elements of `set` closest to `reference`
   - `within(set, reference, metres)`
   - `extreme_pair(set, 'closest' | 'farthest')`
   - `above(set, reference)` / `below(set, reference)`: plan boxes overlap and z ordered
   Use an SQLite R*Tree virtual table (`geometry_rtree`) for `nearest` and `within` when
   the set has more than 2,000 elements.
5. **The LLM picks the operator, code does the geometry.** Add a third JSON form to
   `SQL_PROMPT`:
   `{"spatial": {"op": "nearest", "set_sql": "SELECT objectid FROM elements_clean WHERE ...", "reference_sql": "SELECT ...", "k": 1, "metres": null}, "label": "..."}`.
   Both SQL strings go through `checkSql`. **Refuse instead of guessing:** if the
   question needs a reference and `reference_sql` is missing or returns 0 rows, answer
   "I couldn't tell what to measure from", never fall back to `spacing`.
6. **Zero-token spatial**: keep code-planned `spacing(set)` and `between(id, id)` for
   questions where `resolve.js` finds exactly one set and no second noun.
7. **Follow-ups**: keep the SQL-rewrite approach, but store and pass the resolved
   entities of the previous question too.
8. **Delete the `old` lane**, then remove `augmented/planner.js` (keep `askForJson`,
   `aiFailureMessage` and the OpenAI client: move them to `augmented/llm.js`),
   `matcher.js`, `plans.js`, the plan-running half of `engine.js`, the `PLANNER=tiered`
   switch, and the tests that only cover them (`run_v2.js` cases that have no hybrid
   equivalent must first be ported to `run_hybrid.js`). Delete the unused route files in
   `routes/` that `server.js` only references in comments, after confirming with the
   user (they may want them kept as reference).

**Done when:** `rst-spatial.json` under `askpos` gives a correct or explicitly refused
answer for all 32 questions (expected values for the synthetic grid: column spacing 6 m;
nearest column to the stair is the one at (6, 0), whose box overlaps the stair's on plan,
so 0 m box-to-box and 1.41 m centre to centre; 3493 to 3902 is 6 m centre to centre); no `require` of the deleted modules remains; `npm test` and golden pass.

## Phase 6: Production hardening

1. **Per-user identity.** Every signed-in user is `req.user.id = 'member'`
   (`routes/login.js`), so follow-ups, last results and coordinates are shared between
   all members. Give each session a random id stored in the signed session cookie and
   use `member:<id>`. Real accounts (email + password or SSO) are a product decision:
   ask the user before building them.
2. **Uploads** (`routes/models.js`): limit size (ask the user for the cap; suggest
   500 MB), accept only `.rvt`, `.ifc`, `.nwd`, `.zip`, sanitise the file name, per-user
   upload rate limit, and record who uploaded what in a `models` table in
   `DATA_DIR/state.sqlite`. Decide with the user whether models are private to the
   uploader; today every model is visible to everyone.
3. **Indexing as a background job** with status (`queued | translating | indexing |
   ready | failed`) exposed by `/model_status`, instead of on the first question's
   request thread.
4. **Geometry upload** (only if the Phase 4 spike said server-side is impossible):
   `POST /model_positions` is guest-writable and write-once, so one bad upload poisons a
   model for everyone. Require a signed-in user or a per-model token issued by
   `/model_status`; validate (finite numbers, min <= max, at least 50% of elements,
   known lengths within 5% of box extents for 20 sampled beams); store with a `version`
   and allow replacing by a member.
5. **Memory**: cap loaded models (LRU, default 5) and close evicted database handles.
6. **Event loop**: template SQL is fast, but index builds are not: build indexes in a
   worker thread.
7. **HTTP**: add `helmet` with a CSP that allows the Autodesk viewer origins, rate
   limit by IP on `/ask_agent_simple` and `/login` (keep the existing budget logic),
   request body limit 10 MB only on the routes that need it (1 MB elsewhere).
8. **Config**: `PLANNER_MODEL`, timeouts and budgets from environment variables with the
   current values as defaults. Fail fast at boot in production if `APP_PASSWORD`,
   `SESSION_SECRET`, `OPENAIKEY`, APS keys or `DATA_DIR` are missing.
9. **Observability**: one structured JSON log line per question (lane, ms, tokens,
   model, result count, error), a `/healthz` that checks `DATA_DIR` is writable, and an
   admin page section for the day's lane mix, error rate and 👎 rate from the question
   log.
10. **Backups**: nightly copy of `DATA_DIR/*.sqlite` (state, questions, contacts; indexes
    can be rebuilt) using `VACUUM INTO`, keep 7. Document restore in `docs/RUNBOOK.md`.
11. **CI**: check `.github/workflows`; make `npm test` run on every push and PR.
    Golden tests run on demand (they need APS secrets).
12. **OpenAI outage**: when the SQL lane fails, answer with the gate text plus what the
    template lane can do, and never cache that reply.

**Done when:** each item has a test or a documented manual check in `docs/RUNBOOK.md`.

## Phase 7: Paid evaluation and rollout

1. Tell the user the number of paid questions and wait for a yes. Suggested: 20 from
   the probe's `[LLM]` set per model, chosen to cover negation, multi-value, props
   outside the clean table, level ambiguity, and each spatial operator.
2. Run them with `test/eval.js --ids ...`; record pass / asked back / wrong in
   `test/eval-report-<model>.md`. Target: 0 wrong (asking back is acceptable).
3. Add every wrong one to the golden set with its correct expectation, fix, rerun only
   those (ask again before spending).
4. Rollout: merge to `main` only on the user's go-ahead; watch the question log's error
   and 👎 rates for 48 hours; rollback is `git revert` of the merge commit plus a push.
   A schema version bump rebuilds every index on first use: warn the user that the
   first question per model after deploy is slow.

## Open questions for the user (ask before the phase that needs them)

- Phase 4: is server-side geometry extraction acceptable if it needs an extra APS
  dependency or a headless viewer?
- Phase 5: delete the legacy `routes/*.js` experiments, or keep them?
- Phase 6: real user accounts or keep the shared password? Are uploaded models private?
  Upload size cap?
- Phase 7: paid-question budget.

## Findings log

(Agents: append dated notes here: spike results, measurements, decisions.)
