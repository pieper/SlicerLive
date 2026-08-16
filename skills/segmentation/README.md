# Segmentation Skill Hierarchy

A tree of **vision-based skill files** that distill the radiological literature into an *executable, hypothesis-driven protocol* for segmenting anatomy on medical images — runnable by an agent (ultimately a small LM + a medical-image embedding) that issues cheap GPU probes, interprets each against anatomical knowledge, and reconstructs *this individual's* body plan structure by structure. The kidney/tumor task (KiTS CT) is the first fully populated branch.

Companion docs: the general method lives in [`../../docs/SEGMENTATION-SKILL.md`](../../docs/SEGMENTATION-SKILL.md) (Part A = active-probing method + principles; Part B = structure library); the applied kidney protocol in [`../../docs/SEGMENTATION-PROTOCOL-KIDNEY.md`](../../docs/SEGMENTATION-PROTOCOL-KIDNEY.md). This tree is the *operational* form those describe.

## What this is, in the literature's terms

The design is a **fuzzy-CSP blackboard with learned probes and an NS-VQA-style symbolic protocol, ordered coarse-to-fine over an FMA/RadLex anatomy graph** — a 40-year, well-validated research thread, not a novelty:

- **Blackboard + competing structure-schemas over shared state.** Each structure is an agent that posts partial hypotheses to a shared 3-D label/evidence buffer (the GPU buffer *is* the blackboard); a control loop schedules the next probe. (VISIONS/Schema — Hanson & Riseman; the Manchester medical-image blackboard, [SPIE 1445](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/1445/); survey: Crevier & Lepage, [CVIU 1997](https://www.sciencedirect.com/science/article/abs/pii/S1077314296905202).)
- **Constraints as domain-pruning, not post-filters.** Anatomy is a Constraint-Satisfaction Network: variables = structures, constraints = spatial relations; every confirmed structure *propagates* to shrink its neighbors' search regions. "Rule out" = prune a domain. Use *fuzzy* relations so soft evidence still propagates. (Nempont/Atif/Bloch, [Information Sciences 2013](https://www.sciencedirect.com/science/article/abs/pii/S0020025513004052); Fouquier/Bloch sequential reasoning, [CVIU 2011](https://hal.science/hal-00862556).)
- **Coarse-to-fine, hierarchy-ordered, recognize-then-delineate.** A cheap landmark probe seats the coordinate frame → coarse fuzzy recognition → expensive delineation, **parent before child**. (Udupa Automatic Anatomy Recognition, [MedIA 2014](https://www.sciencedirect.com/science/article/abs/pii/S1361841514000498); multi-scale DRL landmarks, [PMC7610752](https://pmc.ncbi.nlm.nih.gov/articles/PMC7610752/).)
- **Priors-as-forces where evidence is weak.** For low-contrast boundaries (fat/vessel/organ), inject the spatial-relation prior *into* delineation rather than filtering after — measured to "substantially improve" ill-defined structures. (Colliot/Camara/Bloch, [HAL](https://inria.hal.science/hal-00878443/document).)
- **Truth-maintenance + an explicit "other" slot.** Keep an ATMS-style dependency record so a contradicting probe *retracts* a hypothesis cheaply; reserve an **unclaimed-region label** for anything no schema claims (unexpected-object detection). (Deruyver/Fouquier conceptual graphs.)
- **Disentangle perception from protocol (neuro-symbolic).** Probes = perception → a *symbolic scene*; the protocol = an *executable, auditable program* over that scene — this is what makes the skill editable and verifiable. (NS-VQA, [arXiv 1810.02338](https://arxiv.org/abs/1810.02338); medical spatial-model-checking, [AIiM 2025](https://www.sciencedirect.com/science/article/pii/S0933365725000892).)
- **Tool-selection + confidence + defer-to-human.** An orchestrator picks the next probe; low confidence or contradiction **defers** rather than guessing. Over-confident hallucination is the dominant failure of monolithic reasoners; domain-specialized multi-agents are more robust. (MMedAgent, [arXiv 2407.02483](https://arxiv.org/abs/2407.02483).)

**The two rules the literature says to get right:**
1. **Never commit early.** Carry fuzzy upper/lower bounds; allow backtracking via truth-maintenance; re-derive probe order dynamically. Sequential pipelines die of *error propagation* when they commit.
2. **Score every hypothesis jointly on pixel evidence AND whole-scan constraint consistency**, and **defer when they disagree.** A region that fits locally but violates "inferior-to-liver, lateral-to-aorta, wrapped-in-fat" must lose.

**What was brittle (design around it):** hand-authored *pixel* rules didn't scale → keep the protocol symbolic but let the **probes be learned/GPU-computed**; bijective region↔label matching broke on over-segmentation → let one label claim many regions, defer merging until constraints agree.

## Probe-ordering / scoring recipe

1. Compute an **information frame** first (cheapest strong-prior probe — spine → coordinate frame).
2. At each step pick the probe maximizing **expected constraint-tightening ÷ GPU cost** over currently ambiguous structures.
3. Score each hypothesis with **pixel evidence** (probe response) + **whole-scan consistency** (satisfaction of spatial-relation constraints to confirmed structures).
4. **Confirm** a structure only when it wins its region *and* propagation to neighbors stays consistent; else leave it **fuzzy** and revisit.
5. Route low-confidence / contradiction to **defer-to-human**; the review becomes new training material appended to the relevant node.

## Node schema (every recognizer in this tree)

```
### <Recognizer name>
- TRIGGER:      the prior-violation signal or gate that opens this recognizer
- PROBES:       the GPU measurements to run (cheap → expensive)
- CT SIGNATURE: the expected imaging appearance (phase-robust where possible)
- DISTINGUISH:  the single cue that separates it from its nearest confuser
- ACTION:       commit label / rewrite body-plan expectation / branch / defer
- CITE:         source(s)
```

## The tree

- `../../docs/SEGMENTATION-SKILL.md` — **general method** (Part A) + structure library (Part B).
- **`kidney/`** — the KiTS CT task, as four gated layers. **Violations *route*, they don't *fail*:** the five brittle priors (count=2, paravertebral location, bean shape, symmetry, avid homogeneous enhancement) become *routing signals* that open a deeper recognizer.
  - [`00-normal-anatomy-and-frame.md`](kidney/00-normal-anatomy-and-frame.md) — Layer 0: coordinate frame, patient-normal reference, emits prior-violation signals; the pseudotumor gate.
  - [`01-variants.md`](kidney/01-variants.md) — Layer 1: congenital/developmental + pseudotumor + vascular recognizers.
  - [`02-surgical-trauma.md`](kidney/02-surgical-trauma.md) — Layer 2: post-surgical, intervention, trauma recognizers.
  - [`03-disease-and-mass.md`](kidney/03-disease-and-mass.md) — Layer 3: the renal-mass characterization + Bosniak-2019 decision tree + disease mimics.
- *(future branches: `ct-table.md`, `lymph-nodes/…`, `liver/…` — same schema, reusing Layers 0's frame + the partition detectors.)*

## Status
Populated 2026-08-12 from six cross-verified literature investigations (interpretation architecture; renal reading protocol + Bosniak 2019; congenital variants; surgical/trauma; disease morphology; KiTS/OOD). The probes reference the GPU feature-cortex in [`../../algorithms/features/`](../../algorithms/features/). Numeric thresholds are load-bearing — verify against the cited primary sources before any external/clinical use.
