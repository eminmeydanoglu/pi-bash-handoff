# Upstream provenance

This project was forked conceptually from the small process lifecycle core of
[`pi-bg-tasks`](https://github.com/cyzlmh/pi-extensions/tree/main/pi-bg-tasks),
but deliberately rewrites its public tool surface and execution semantics.

- npm package inspected: `pi-bg-tasks@0.1.3`
- package license: MIT
- repository: `https://github.com/cyzlmh/pi-extensions.git` (`pi-bg-tasks`)
- source commit: `454595f945effcc65ddca78f5b908ca18bc4a61a`
- verification: the published `0.1.3` tarball and that checkout had no file
  differences in `pi-bg-tasks` when checked on 2026-09-06.

The upstream code is MIT licensed. This project keeps no copied model-facing
`bg_*` API: its only model tools are the canonical `bash` override and one
flat `process` object with an `action` enum. The flat provider schema avoids
tool-argument serialization failures seen with root `anyOf` unions.
