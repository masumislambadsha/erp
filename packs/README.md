# Packs

Industry packs live here and extend the core only through its declared extension points
(PLAN.md, "The contract"). Nothing under `apps/` or `packages/` may import from this folder;
dependency-cruiser fails the build if it does (`.dependency-cruiser.cjs`, tested in `tools/`).
No pack exists yet.
