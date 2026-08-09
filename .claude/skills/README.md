# Project skills

Design skills vendored from [VibeCurb](https://github.com/Yu-369/VibeCurb) (MIT License,
Copyright (c) 2026 Yu-369). These are prompt/instruction files only — no runtime code, no
dependencies, and nothing imported by the app.

| Skill | Use it for |
| :--- | :--- |
| `visual-redesign` | Restyling existing components without touching JS logic. Treats state, effects, API calls, handlers, refs and `data-*`/`aria-*` attributes as untouchable; changes only classNames, CSS, colours, spacing, type and motion. |
| `awwwards-motion` | Adding animation. Includes a frequency-gated motion budget for functional app UI — high-traffic actions get zero animation, rare ones get the full budget. |
| `awwwards-sections` | Marketing-style page sections (feature showcases, pricing, FAQ, footers). Least relevant to TimeHub's internal pages; kept for the landing/marketing surface. |

Each skill runs a four-phase gated pipeline — audit, extract, build, then a PASS/FAIL visual
diff — and will not proceed past a phase until its checklist passes.

## Before running one

`visual-redesign` in particular is designed to rewrite styling across many files at once.
Start it on a single component or page rather than the whole app, and check the diff before
committing. The skill's own rule is that JS logic is sacred, but a narrow scope makes that
easy to verify rather than something you have to trust.

## Updating

Re-copy the `SKILL.md` files from the upstream repo, then re-check that each file's
frontmatter `name` matches its directory name — several upstream skills ship a `name` that
differs from their folder (e.g. `awwwards-motion-design` in `awwwards-motion/`), which stops
Claude Code from loading them.
