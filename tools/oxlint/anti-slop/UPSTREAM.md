# Vendored anti-slop Oxlint plugin

Installed 2026-09-14 from the bundled assets of the local `install-anti-slop` skill
(`.claude/skills/install-anti-slop/assets/anti-slop`, untracked in this repository).

- Upstream repository / commit: unknown. The skill bundle carries no source
  identity for the plugin itself.
- Pristine snapshot identity: sha256-of-sha256 over all copied files (sorted
  relative paths) = `69fa217ad6262822…`. Recompute with
  `find . -type f | sort | xargs shasum -a 256 | shasum -a 256` inside this
  directory to detect local edits.
- Nested provenance for the vendored ESLint Stylistic rule is in
  `vendor/eslint-stylistic/UPSTREAM.md`; keep its `LICENSE` alongside it.

## Installed entry points

- `./index.ts` → Oxlint jsPlugin `anti-slop`
- `./effect/index.ts` → Oxlint jsPlugin `anti-slop-effect`

Both are registered in the root `oxlint.config.ts`. `@oxlint/plugins` is pinned
to the same exact version as `oxlint` (1.82.0).

## Intentional deviations

None. Files are byte-identical to the skill assets at install time.
