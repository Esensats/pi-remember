# Changelog

## 0.2.0

First public release as `@seangle/pi-remember`, licensed under Apache-2.0.

- Durable workspace-local and global facts, standalone Markdown notes, and lexical search.
- Stable session context with on-demand note retrieval.
- Explicit local initialization, memo updates, recoverable deletion and undo.
- Versioned storage with backed-up migration from the legacy note-reference format.
- Restore-path validation that refuses redirected recovery files and note directories.
- Pi package metadata and a source-only npm artifact; no build step.

Existing legacy stores migrate automatically when used. Back up stores, review the README's migration and concurrency limits, and upgrade every writer before using the new format.
