# Working in this repo

## Concurrent Claude sessions — do not silently overwrite

Steve often runs **two or more Claude Code sessions against this same clone at the same time**, so the
working tree and `main` can move under you. A long-running session's idea of a file is frequently stale.

This has already cost real work: a README rewrite (`2ae9a22`, 2026-08-17) regenerated the file wholesale
and dropped video links and prose another session had committed hours earlier (`e740b1b`) — no conflict,
no warning, just gone.

Rules:

- **Before rewriting or regenerating a whole file** (as opposed to a targeted edit), check what happened
  to it recently: `git log --oneline -5 -- <file>` and `git log --oneline -3` for the branch tip. If it
  was touched since your session's context was formed — by another session, or by Steve — **stop and tell
  him what you would be dropping** before doing it.
- **Prefer targeted edits over wholesale rewrites.** A regenerated file discards anything you never read.
- **Re-read a file immediately before editing it** if any time has passed since you last read it. A
  "file changed on disk" notice means another session or Steve is in there too.
- **Before committing**, run `git status` / `git diff --stat` and stage only the paths you actually
  changed. Do not `git add -A` — other sessions' in-progress work lives in the same tree.
- **Before pushing**, `git fetch` and check whether `origin/main` moved. Never force-push `main`.
- **Never `git checkout`/`restore`/`stash`/`reset` files you did not modify.**

When in doubt, warn rather than proceed. Losing another session's committed work is worse than asking.
