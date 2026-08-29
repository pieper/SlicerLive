# Contributing to slicerlive

Thanks for your interest — contributions are genuinely welcome, but this project takes them in an
unusual form. **Please open an issue rather than a pull request.**

## Please don't send pull requests

**slicerlive is an AI-generated codebase.** Much of it is written by coding agents working under human
direction and review, and it changes fast — whole subsystems get regenerated rather than patched.

That makes incoming pull requests difficult or impossible to review fairly:

- A patch written against today's code is often against a file that has since been rewritten.
- Reviewing a human patch to AI-written code means reconstructing the intent of both, in a codebase
  where the surrounding conventions may themselves shift next week.
- Merging code of uncertain provenance into an explicitly AI-assisted project muddies the license and
  authorship story that the project is trying to keep clean and honest.

So PRs to this repository will generally be closed unmerged, however good the idea in them is. That is
not a judgment on the work — it is about what this maintainer can responsibly review.

## Please do open issues

Issues are the contribution that actually helps here. A well-described issue is worth more than a
patch, because the implementation is the cheap part.

**Bug reports** — the more specific, the better:

- What you did, what you expected, what happened instead.
- The demo page or module involved, and the URL if it is one of the live demos.
- Browser and GPU (WebGPU support varies a lot), or Slicer version for the LiveStory side.
- The data, if it is public — an IDC collection/series UID, a public URL, or a small sample. Please do
  not attach patient data.
- Console errors, and a screenshot or short screen recording for anything visual.

**Feature requests** — describe the *goal*, not the patch:

- What clinical or research workflow you are trying to support, and why the current behavior blocks it.
- How 3D Slicer does it today, if it does — matching Slicer's semantics is usually the target.
- Any references: papers, existing implementations, a Slicer module that gets it right.

**Correctness reports are the most valuable of all.** This is medical imaging code written with AI
assistance: numerical errors, coordinate-system mistakes (RAS/LPS, IJK/voxel semantics, slice
orientation), DICOM round-trip infidelity, and units bugs are exactly the failures that are easy to
generate and hard to spot. If you can show a wrong number, please do — those get fixed first.

Issues will be considered on their merits, and the ones that are taken up get implemented by a coding
agent under review, the same way the rest of the codebase is written.

## Other ways to help

- **Try it and say what broke.** The live gallery at
  [pieper.github.io/live](https://pieper.github.io/live) needs no install.
- **Review the code and report what you find** — reading is welcome even though patching is not. See
  the code-review notes in the [README](README.md#code-review--quality).
- **Discussion** — architecture and direction questions are also fine as issues, or on the
  [3D Slicer Discourse](https://discourse.slicer.org).

## Running the code locally

Prerequisites: [Deno](https://deno.com/) and a WebGPU-capable browser; Node 20+ for the legacy VTK.js
bundling; 3D Slicer only if you want the LiveStory integration.

There is no build system and no task runner — no `deno.json`, no Makefile, no npm scripts. Everything The one exception in spirit, not in kind: `deno run -A test/run.ts` is the single test entry point — a plain script that only spawns `deno test` per tier (see docs/HARNESS.md).
is plain [Deno](https://docs.deno.com/runtime/) subcommands run directly against the sources:
[`deno lint`](https://docs.deno.com/runtime/reference/cli/lint/) and
[`deno check`](https://docs.deno.com/runtime/reference/cli/check/) in `render/`,
[`deno test`](https://docs.deno.com/runtime/reference/cli/test/) for the test directories (some tests
write comparison images, so they need `--allow-write`), and
[`deno run`](https://docs.deno.com/runtime/reference/cli/run/) for the demo servers and the parity
harness. The [permission flags](https://docs.deno.com/runtime/fundamentals/security/) are the only
thing to know: most entry points here want `-A`.

The README's [Development Setup](README.md#development-setup) has the exact invocations, and
[docs/HARNESS.md](docs/HARNESS.md) covers the Slicer ↔ browser parity harness.

Start with [docs/ARCHITECTURE-2026-08-02.md](docs/ARCHITECTURE-2026-08-02.md) for the system design;
the other design notes are listed in the [README](README.md#key-documentation).

## License

slicerlive is Apache 2.0, the same as 3D Slicer.
