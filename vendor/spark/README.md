# Vendored Spark Build

This folder temporarily vendors a built Spark 2.0 package into the Sparkler repo.

Why this exists:

- Sparkler currently needs Spark features that are not yet available in the published npm release.
- The public Spark 2.0 release is expected soon.
- Until then, keeping the built package here makes GitHub-based installs deterministic.

Expected contents:

- `dist/spark.module.js`
- `dist/spark.cjs.js`
- `dist/types/...`
- any other files under `dist/` needed by the build

Once Spark 2.0 is published publicly, replace the root dependency on `file:./vendor/spark` with the published package version and remove this folder.
