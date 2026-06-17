# usm-engine

Internal USM configurator engine (Haller-first), built from the decoded Perspectix VCML.
Validated against the live P'X5 install as the correctness oracle. See `../ENGINE_BUILD_SPEC.md`,
`../BUILD_A_SCHEMA_IMPORTER.md`, `../BUILD_B_INTERPRETER_SPEC.md`, `../BUILD_C_GOLDEN_TESTS.md`.

Runs on **Node 24** (native TypeScript — no build step). One dependency: `fast-xml-parser`.

## Run
```bash
npm install                 # fast-xml-parser
node src/import/run.ts       # import decoded VCML -> out/model.json (+ validated counts)
node src/vcml/smoke.ts       # VCML interpreter smoke test
node src/test/golden/run.ts  # golden-test harness self-check
```

## Layout
```
src/
  model.ts              normalized model types
  xml/parse.ts          fast-xml-parser wrapper (preserveOrder)
  import/
    paths.ts            decoded-source locations
    components.ts       componentsystem + docksystem -> Component[]/DockType[]
    systems.ts          properties, clauses, assembly/article rules, volumes, geomrep
    run.ts              importer entry (-> out/model.json, validates counts)
    diag*.ts            one-off reconciliation diagnostics
  vcml/
    interp.ts           VCML expression interpreter (lexer+parser+eval, core builtins, fail-loud)
    smoke.ts            interpreter smoke test
  engine/partgraph.ts   Host + Part (isSubTypeOf from imported hierarchy)
  test/golden/          snapshot schema + diff (articles/placement/conflicts) + runner
```

## Status (Phase 1)
- **Importer — ALL GREEN** on real Haller data, zero silent drops:
  components 1025 · dockTypes 369 · properties 180 · clauses 124 · assemblyRules 75 · articles 239
  (+ volumes, geomReps, 23,318 dock instances). Spot-checks confirmed (glass-hinge L/R dock
  asymmetry, Inos rotation domain, Beschlaegematerial chrome/black).
- **Interpreter skeleton** — runs; `IsSubTypeOf` resolves against the imported hierarchy;
  ~20 builtins; part-dependent builtins + unknown named-ops **fail loud** (no silent gaps).
- **Golden harness** — diff logic proven (quaternion-angle + position tolerances); catches the
  glass-hinge wrong-axis flip as a 180° placement diff.

## Phase 2 (in progress)
- **Coverage measured** (`node src/vcml/coverage.ts`) over 395 real expressions / 775 calls:
  real 10% · part-builtins **45%** (`Feature`=237) · named-ops 32% (`setChromMaterial`=138) · unknown 12% (28 fns).
  Parser must add `if`/`for` (28 uses in real expressions).
- **PartGraph + scene loader** (`node src/engine/scene_smoke.ts`): loads a real prototype, links docks by id,
  and the part-builtins (`Feature`/`Dock`/`DockGetConnectedPart`/`GetTypeName`/`IsSubTypeOf`/`GetComponentListOfType`)
  evaluate correctly on real parts — including following a dock link across parts.

## Next
1. Parser: `if`/`for`/`{}` blocks; implement the ~20 unknown builtins (Number, Height, Transformation, FilterList, …).
2. Load the 107 named ops (start `setChromMaterial`, `rohrMaterial`); run a clause/property regression on loaded scenes.
3. Capture the first real P'X5 export (`haller_glassdoor_L_350x350`) -> wire the golden oracle (settles the hinge quat).
