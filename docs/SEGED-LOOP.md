# The seged loop — a knowledge planner and a vision critic that actually converge

Status: **design, 2026-08-15. Nothing implemented.** Successor to the seged prototype plan
(`~/.claude/plans/bright-sparking-dijkstra.md`, built and working) and the concrete first application
of [SEMANTIC-EDITOR.md](SEMANTIC-EDITOR.md). Task substrate:
[SEGMENTATION-PROTOCOL-KIDNEY.md](SEGMENTATION-PROTOCOL-KIDNEY.md) (KiTS) and
[SEGMENTATION-SKILL.md](SEGMENTATION-SKILL.md).

## 1. Why the previous loop didn't converge

The old shape was: give the agent a task ("segment kidneys and tumors per the KiTS examples"), render
reference examples, let the agent edit, and ask whether the new case's rendering looks like the
examples. Five diagnosable failures, in rough order of severity:

1. **No credit assignment.** Feedback arrived for a whole segmentation after dozens of actions. The
   agent could not tell which action helped. This is the standard failure of long-horizon LLM tasks
   with a terminal score, and it is fatal on its own.
2. **The objective was uninformative and never measured.** Nobody checked whether "looks like the
   examples" correlates with Dice. A search loop whose objective carries no signal cannot converge,
   and the symptom looks exactly like what was seen: activity without progress.
3. **Absolute VLM scoring is unreliable — now literature-backed.** *VLM judges can rank but cannot
   score*: asking "how good is this segmentation, 1–10" returns noise; asking "which of these two is
   more like the reference" returns signal. The old loop asked the first question.
4. **Appearance was conflated with correctness.** If the reference exemplar and the candidate differ
   in window/level, colormap, zoom, or slice position, "looks like" measures rendering, not anatomy.
5. **Judgment happened on renderings only** — against `SEGMENTATION-SKILL.md`'s own principle #1
   (work in the native array; use renderings for context and verification, never to locate a
   boundary). Cheap numeric facts that were available on the array went unused.

## 2. One correction to the framing: critic-in-a-search-loop, not a GAN

The "guiding GAN" instinct is right about the *role* — an adversary that says "that doesn't look like
the training data" — and wrong about the *mechanism*. A GAN backpropagates the discriminator's
gradient into the generator. Here the generator is an agent emitting discrete tool actions; there is
no differentiable path from the critic's opinion back to "paint a slightly different stroke."

What does work with exactly the same spirit is **a critic scoring a batch of candidate actions in a
search loop**: generate N candidates, have the critic rank them, commit the winner, repeat. Same
adversarial pressure, no gradients required — and it converts the interaction from serial
(propose → judge → propose) into parallel (propose a *family* → rank → commit), which is both faster
and the form VLMs are reliable in.

This is only affordable because of a property SlicerLive has and no other system in this space does:
**the volume is GPU-resident and the ops are field algebra, so sweeping an op's parameter produces
16 candidate labelmaps for roughly the cost of one.** Candidate generation is nearly free. That is the
hinge the whole design turns on.

## 3. The action space: parameterized field ops, not brush strokes

A paint stroke is the wrong unit for this loop — too fine to judge individually, too many to rank,
and it carries no parameter to sweep. The unit becomes a **parameterized op** from the semantic
editor's field algebra:

| Op | Parameters | Sweep gives you |
|---|---|---|
| `growFrom(seeds, edgeLo, edgeHi)` | 2 thresholds | a family of extents from tight to leaky |
| `thresholdTrim(lo, hi)` | 2 HU bounds | the intensity-class boundary family |
| `component(at)` / `keepLargest(n)` | n | topology variants |
| `margin(±d)` | d mm | the interpretation family from §SEMANTIC-EDITOR |
| `excludeWithin(d, of: structure)` | d mm, target | confuser subtraction at varying strictness |
| `smoothSdf(σ)` | σ | boundary regularization strength |

Every one is a GPU pass over the resident volume, every one has a knob, and a knob is what makes a
candidate family. Paint strokes stay available as the human/agent fallback, judged as *deltas* rather
than states.

## 4. The critic is a cascade — the VLM is the last stage, not the only one

Cheapest-first, so the expensive semantic judgment only adjudicates among candidates that are already
anatomically legal:

```
16 candidates from one GPU sweep
      │
   ┌──▼─────────────────────────────────────────────────────────────┐
   │ A. HARD CONSTRAINTS   free, deterministic, on the native array  │  16 → ~6
   │    compiled from the planner's hypothesis:                      │
   │    crosses midline? overlaps a committed structure? HU          │
   │    distribution outside the asserted band? component count?     │
   │    volume outside the expected range? leaked into fat?          │
   │    [ reuses algorithms/features/kernels.ts probes as-is ]       │
   └──┬─────────────────────────────────────────────────────────────┘
   ┌──▼─────────────────────────────────────────────────────────────┐
   │ B. NUMERIC QUALITY PROXIES   cheap, no ground truth needed      │  ~6 → 3
   │    boundary/gradient agreement · surface smoothness ·           │
   │    compactness · contralateral symmetry ·                       │
   │    In-Context RCA-style Dice estimate against the KiTS cohort   │
   └──┬─────────────────────────────────────────────────────────────┘
   ┌──▼─────────────────────────────────────────────────────────────┐
   │ C. Qwen3-VL   PAIRWISE, canonical render, exemplars in-frame    │  3 → 1 + reason
   └────────────────────────────────────────────────────────────────┘
```

Stage A is where the tight coupling the user asked for actually lives: **the planner's anatomical
expectations are compiled directly into the critic's constraint checks.** Not two systems exchanging
messages — one system in which knowledge parameterizes perception. A hypothesis like *"right kidney,
paravertebral, does not cross midline, cortex enhances to ≈N HU relative to the in-scan aorta anchor,
fat-wrapped, one connected component, 120–220 mL"* is a set of GPU predicates, evaluated per
candidate, for free.

### Stage C protocol — the details that decide whether it works

- **Pairwise, never absolute.** "Which of A/B is more consistent with the reference exemplars, and
  why?" Ranking is what VLM judges are reliable at; scoring is not.
- **Deltas, not states.** Show before | after | changed-region-highlighted. Judging a change is
  markedly easier than judging an absolute.
- **Canonical rendering, enforced.** A `canonicalView(structure, case)` fixes window/level, colormap,
  overlay opacity, zoom, and slice selection (by the structure's centroid), and the *KiTS exemplars
  are rendered through the identical path*. We own the renderer; this is enforceable, and it is the
  fix for failure #4.
- **Multi-view montage.** Three orthogonal planes at the structure plus the 3D SDF surface, composited
  into one image. A VLM is blind to volume; give it the views that recover it.
- **Exemplars as a cached prefix.** The reference pack and task prompt are a fixed prefix →
  vLLM automatic prefix caching makes per-candidate cost ≈ the candidate's image tokens alone. This is
  the concrete form of "tightly coupled communication": not a faster socket, a cache-friendly prompt
  layout.
- **The reason string is recorded** into the mrson stream alongside the chosen op and the rejected
  alternatives — the evidence layer of `SEMANTIC-EDITOR.md`, and the training data of §7.

## 5. Deployment — where each piece runs

| Piece | Where | Why |
|---|---|---|
| Renderer + editing engine | **Local, headed Chrome, on screen** for interactive runs | The watch-and-intervene requirement; a run you cannot see is a run you cannot debug |
| Qwen3-VL critic | **JS2 A100/H100, vLLM, behind the existing cloudflared tunnel** (the nnLive compare-harness pattern) | Only stage-C survivors go over the wire: ~3 montages/iteration ≈ 1 MB — a tunnel handles that |
| Knowledge planner | Claude (API) initially | Lowest call frequency, highest reasoning demand; swap to a local model later if PHI or cost requires |
| **Batch/trajectory generation** | **Everything co-located on JS2, headless** | Here co-location is the right call — throughput matters, nobody is watching |

Model size: **Qwen3-VL-32B dense** is the sweet spot for a single A100-80GB with KV-cache headroom;
**8B** if per-iteration latency dominates; the 235B-A22B MoE needs multiple GPUs. All sizes share the
262 k context and the same core visual stack, so the prompt design is size-portable — start at 8B for
loop development, calibrate 32B before trusting results.

**Risk to check early:** Deno/Chrome WebGPU on a headless JS2 GPU instance (Vulkan driver path). If it
does not work, batch generation falls back to rendering locally and shipping images, which is slower
but not blocking.

## 6. The decisive experiment — do this before building the loop

**L-0: critic calibration on KiTS.** No agent, no loop. KiTS has ground truth, so:

1. Take *n* KiTS cases; generate a spread of perturbed segmentations per case with **known Dice**
   (reuse [algorithms/eval/degrade.ts](../algorithms/eval/degrade.ts) — leak/erode/dilate/shift/
   partial-delete already implemented).
2. Render each through `canonicalView`; build pairs.
3. Ask the critic which of each pair is better; measure **rank correlation (Kendall τ) between critic
   preference and actual ΔDice**.
4. Do it three ways: **VLM alone**, **numeric proxies alone**, **cascade**. Also measure τ as a
   function of the Dice gap — a critic that resolves 0.9 vs 0.6 but not 0.85 vs 0.83 still drives a
   loop, just to a coarser optimum.

**This is the number that says whether any of this works.** If τ ≈ 0, no loop engineering will save
it and we know in a day instead of a month — which is precisely the failure mode of the previous
attempt, where the objective was never measured. If τ is respectable, everything after is engineering
against a hill that exists.

It also produces, as a byproduct, the labeled preference dataset that §7 needs.

### 6.1 L-0 as built (2026-08-15)

- **Harness:** [algorithms/eval/l0-calibrate.ts](../algorithms/eval/l0-calibrate.ts) (driver) +
  [algorithms/eval/l0-analyze.ts](../algorithms/eval/l0-analyze.ts) (statistics).
- **Data — IDC direct, no mirror:** `render/demos/segroulette.json` already indexes **147 KiTS
  CT+SEG pairs from the `c4kc_kits` collection**, loaded by the existing `idc_tools` path, so
  `seged-app.html?pid=KiTS-00038` *is* the data loader. Nothing new to download.
- **Corruption ladder** (in-page JS over the labelmap, so the volume never crosses the wire):
  pristine / erode1 / erode3 / dilate1 / dilate3 / leak4 / leak8 / shift3, each with its true Dice.
- **Canonical view:** framed once on the pristine ground truth via `seged.focus(label)`, then
  *restored* for every candidate, so framing can never be what the critic is responding to.
- **Critic:** Qwen3-VL-8B-Instruct on `lnq-h100` (vLLM, SSH-forwarded — see the deployment table).
- **Runtime:** ~3 min per test case (load ≈ 20 s, 8 variants, 28 pairs at ~2 s/verdict).

### 6.2 L-0 RESULT — Qwen3-VL-8B zero-shot has **no usable signal** (2026-08-15)

Two runs, same 4 KiTS cases, 111 pairs each, differing only in how the candidate was presented:

Three runs, same 4 KiTS cases, 111 pairs each, A/B order randomized per pair:

| Critic / presentation | overall | 95% CI | pristine (Dice 1.0) recognized | Δ≥0.15 pairs | picked "A" |
|---|---|---|---|---|---|
| Qwen3-VL-8B, 4-up montage | 47.7 % (τ −0.045) | 38.7–57.0 % | 14/28 = 50 % | 54.2 % | 46 % |
| Qwen3-VL-8B, per-panel full-res | 45.9 % (τ −0.081) | 37.0–55.2 % | 10/28 = 36 % | **27.1 % (τ −0.458)** | 36 % |
| **Lingshu-7B (medical VLM)** | 46.8 % (τ −0.063) | 37.8–56.1 % | 12/28 = 43 % | 41.7 % | **111/111 = 100 %** |

None is distinguishable from chance. The Qwen per-panel run is *inverted* on exactly the pairs that
should be easiest — large-Dice-gap comparisons wrong 3 times in 4. And **Lingshu answered "A" on all
111 randomized pairs**: its 46.8 % is precisely the base rate of A being the better candidate
(46.8 %), which is the arithmetic signature of a constant answer, not a judgement. A 14-query
order-swapped probe confirmed it directly — 13/14 "A", 7/7 correct when pristine was shown first and
1/7 when shown second.

**The decisive observation is not the low accuracy — it is that the bias FLIPPED DIRECTION when only
the image framing changed.** A critic with weak-but-real perception would degrade toward chance; one
whose preference reverses when panels are re-cropped is responding to superficial image properties,
not to segmentation quality. Two corroborations: 111 verdicts produced **7–8 distinct sentence
openings** (boilerplate, not description), and the model sometimes asserted "no difference exists"
between visibly different candidates. The images were verified by eye to carry the signal clearly —
dilate3 visibly spills into perirenal fat at full resolution.

**A biased critic is worse than a useless one.** An agent optimizing against the first configuration
would have learned to dilate without bound — the reward-hacking failure of §8.1, arriving on day one.

**Protocol change adopted:** the harness now asks **every pair twice, with the candidates swapped**
(`--swap`, on by default) and reports order-swap consistency. Without it, a model that always answers
"A" scores ~50 % on randomized pairs and is indistinguishable from a weak-but-honest critic — which is
exactly how Lingshu would have been misread. Consistency is the first number to look at, before τ.

**Scope of the negative — what this does and does not kill:**

- ✗ **Killed:** ~7–8 B VLMs as the ranking critic (stage C) on rendered slice views — *both* a strong
  general model (Qwen3-VL-8B) and a purpose-built medical one (Lingshu-7B). Domain pretraining did not
  help; the medical model was the more degenerate of the two. This matches the grounding literature:
  medical VLMs ground *anatomy* far better than *findings*, and "is this boundary right" is a finding.
- ? **Untested:** larger models (32B/235B), MedGemma (license-gated — needs the user to accept
  Google's Health AI terms), a fine-tuned critic (L-6), and richer prompting (chain-of-thought,
  explicit boundary questions).
- ✓ **Untouched:** **stages A and B of the cascade were never exercised.** The design deliberately
  put the VLM last, after free deterministic constraints and numeric no-reference proxies — and this
  experiment tested *only the weakest, most speculative component, in isolation*. For the exact
  failures the VLM missed, stage A is trivial: dilate3 admits voxels at ≈ −80 HU (perirenal fat), so
  an HU-distribution predicate rejects it without any model at all.

**Consequence for the roadmap:** L-6 (a fine-tuned critic) moves from optimization to *prerequisite*
for stage C — and the next experiment is not a better VLM, it is **L-0b: run the same 111 pairs
through the stage-A/B numeric proxies alone.** If those rank correctly, the loop has a hill to climb
today and the VLM is a later refinement rather than the engine. That inverts the assumed ordering,
and it is the cheapest remaining question.

Raw data: `algorithms/eval/l0-out-big/` (montage) and `algorithms/eval/l0-out-fixed/` (per-panel),
each with `results.json` + every rendered candidate.



## 7. Milestones

| Step | Deliverable | Proof |
|---|---|---|
| **L-0** | Critic calibration harness + the τ number (VLM / proxies / cascade) | A plot of critic preference vs ΔDice; a go/no-go with a threshold agreed in advance |
| **L-1** | `canonicalView()` + KiTS exemplar pack + montage encoder + vLLM client with prefix caching | Identical rendering path for exemplar and candidate, verified pixel-wise; measured prefix-cache hit rate |
| **L-2** | Parameter-sweep candidate generation: one dispatch → N labelmaps + N constraint scores | 16 candidates generated and scored in ≤ the time of ~2 single applies |
| **L-3** | Constraint compiler: planner hypothesis (JSON) → GPU predicates over `algorithms/features/kernels.ts` | A kidney hypothesis rejects a midline-crossing candidate with no VLM call |
| **L-4** | The closed loop on one KiTS case, visible in Chrome, recorded to mrson (chosen op + rejected alternatives + reasons) | Dice improves monotonically across iterations on a held-out case; the recording replays |
| **L-5** | Batch mode on JS2 → trajectory dataset over many KiTS cases | *k* thousand (context, A, B, ΔDice, reason) tuples |
| **L-6** | LoRA fine-tune of Qwen3-VL as a specialized critic on L-5 data; re-run L-0 | τ measurably above the base model's, on **held-out cases** |

L-6 is where "a custom-trained segmentation agent that understands anatomy together with a strong
vision model" becomes concrete: a **fine-tuned critic** (vision, high-frequency, local to the GPU) plus
a **protocol-executing planner** (knowledge, low-frequency), with the loop generating its own training
data on every run.

## 8. Failure modes to design against

1. **Reward hacking.** The agent finds candidates the critic likes and Dice hates. Mitigation: always
   report true Dice on held-out cases; treat any critic-vs-Dice divergence as a critic bug, not an
   agent success.
2. **The VLM is blind to 3D.** It sees slices. Mitigation: multi-view montage plus the 3D SDF render;
   never let a purely 2D judgment settle a 3D question (e.g. component topology) that Stage A can
   answer numerically.
3. **Exemplar overfitting.** A critic tuned on KiTS kidneys may not transfer to any other structure.
   Mitigation: state the scope honestly; test transfer explicitly before claiming generality.
4. **Cost drift.** Prefix-cache invalidation (a changed exemplar pack, a reordered prompt) silently
   multiplies cost. Mitigation: monitor hit rate as a first-class metric in L-1.
5. **Losing the human.** If interactive runs move to headless JS2 for speed, the watch-and-intervene
   property is gone. Keep interactive local, batch remote.

---

## Sources

[VLM Judges Can Rank but Cannot Score](https://arxiv.org/html/2604.25235v1) ·
[pairwise vs pointwise feedback protocols](https://openreview.net/forum?id=uyX5Vnow3U) ·
[Reverse Classification Accuracy](https://arxiv.org/pdf/1702.03407) ·
[In-Context RCA](https://www.researchgate.net/publication/389648345_In-Context_Reverse_Classification_Accuracy_Efficient_Estimation_of_Segmentation_Quality_without_Ground-Truth) ·
[Qwen3-VL technical report](https://arxiv.org/pdf/2511.21631) ·
[Qwen3-VL sizes / vLLM support](https://docs.vllm.ai/projects/ascend/en/v0.13.0/tutorials/Qwen-VL-Dense.html) ·
[Qwen3-VL run/fine-tune guide](https://unsloth.ai/docs/models/qwen3-vl-how-to-run-and-fine-tune).
