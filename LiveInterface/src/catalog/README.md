# LiveInterface state-catalog (v0, agent-free)

A static catalog of candidate state-transitions for SlicerLive's "snowflake"
state-explorer UX. No agent, no training — every entry is hand-curated by
mining the slicer-skill resources (Slicer source, docs, Discourse) and labels
its source for audit.

See `docs/SLICERLIVE.md` §1b for the broader design (LiveScene = semantic graph,
LiveInterface = the surface that changes it, snowflake = branches of candidate
next-states rendered live on the user's data).

## How the snowflake renderer uses this

1. Inspect the current LiveScene to build a `SceneCapabilities` (hasVolume,
   activeModality, hasSegmentation, etc.).
2. `applicableByCategory(caps)` returns entries whose `appliesWhen`
   precondition is satisfied, grouped by category.
3. For each candidate, the renderer:
   - **Forks** the current LiveScene.
   - Applies the entry's `delta` to the fork.
   - Renders a small viewport of the forked scene on the user's actual loaded
     data. **Always live-rendered — never a pre-baked thumbnail.** The
     preview IS the truth: it's what the canvas will look like after commit.
4. Hovering a branch reveals its sub-branches (e.g. hovering the VR-preset
   branch reveals the applicable presets for the active modality).
5. Click commits the delta to the main LiveScene.
6. "Mix the selected ones" composes two deltas onto one fork before rendering.

## Entry shape

```ts
{
  category: 'layout' | 'vr-preset' | ...,
  id: 'four-up',              // stable kebab-case
  label: '4-up',              // short display name
  description: '...',         // optional longer text
  appliesWhen: { modality: 'CT', hasVolume: true },   // optional precondition
  delta: { kind: 'layout', layoutId: 3, layoutSymbol: 'SlicerLayoutFourUpView' },
  source: [{ kind: 'slicer-source', path: '...', symbol: '...', note: '...' }],
}
```

The `delta` is a discriminated union keyed by `kind`. Each new category adds
a new variant; the snowflake renderer dispatches on `delta.kind`.

## Categories shipped in v0

| Category | File | Entries | Delta shape |
|---|---|---|---|
| `layout` | `layouts.ts` | 29 user-facing layouts | `{ kind: 'layout', layoutId, layoutSymbol }` → sets `vtkMRMLLayoutNode::ViewArrangement` on the LiveScene's layout node |
| `vr-preset` | `vrPresets.ts` | 31 named volume-rendering presets (22 CT + 4 MR + 1 DTI + 1 US + 3 µCT) | `{ kind: 'vr-preset', presetName }` → resolves via Slicer's `presets.xml` to a `vtkMRMLVolumePropertyNode`, applies to the active volume's VR display node |

## Provenance (where the entries came from)

- **Layouts**: Slicer source `Libs/MRML/Core/vtkMRMLLayoutNode.h`, enum
  `SlicerLayout`. Meta values (Initial, Default, None, Final, Maximized,
  Custom, User) are deliberately excluded — those are infrastructure, not
  user-facing choices.
- **VR presets**: Slicer source
  `Modules/Loadable/VolumeRendering/Resources/presets.xml`. Each
  `<VolumeProperty name="...">` element gives one entry. The actual
  transfer-function XML lives once in `presets.xml` at runtime — the catalog
  references by name, no XML duplication.

## Adding new categories

1. Add a new `*Delta` interface in `types.ts` and extend the `SceneDelta`
   union (e.g. `WlPresetDelta`, `SegmentVisibilityDelta`).
2. Add any new precondition fields to `SceneCondition` and update
   `matchesCondition` to evaluate them.
3. Create `<category>.ts` exporting a `readonly CatalogEntry<...>[]` with all
   the mined entries. Each entry MUST cite at least one `source`.
4. Wire it into `index.ts` (`fullCatalog` and the type re-exports).
5. The snowflake renderer needs a new `case 'kind':` to actually apply the
   delta when committed.

Categories on the roadmap (priority order, per project memory):

1. `wl-preset` — Window/Level presets per modality, mined from
   `Modules/Loadable/Volumes/Resources/VolumeDisplayPresets.json`.
2. `segment-visibility` — opacity/visibility bundles (skeleton-only,
   highlight-one-fade-rest, etc.). Mined from segmentation tutorials.
3. `camera` — standard radiological camera presets (A/P/S/I/L/R/iso).
4. `markup-display`, `crosshair`, `color-map`, `slice-intersection` — long tail.

## What "agent-free" means here

The catalog itself is static data — no model, no inference, no agent runtime
needed to use it. Future versions will layer on:

- **v0.5**: retrieval-augmented — nearest-neighbor next-state from published
  scenes in pieper.github.io/live treated as goal-state labels.
- **v1**: decision transformer trained on `(state_t, action, state_t+1)`
  sequences from instrumented LiveScene event streams, conditioned on a
  desired-outcome embedding.

The catalog stays as the always-on baseline + the fallback when learned
models fail or there's no relevant history.
