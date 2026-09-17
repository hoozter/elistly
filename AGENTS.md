# Project engineering rule

Do not preserve backwards compatibility unless explicitly requested. When functionality, APIs, behavior, or implementations are changed or replaced, remove the superseded code and update all callers to use the new implementation. Do not keep legacy paths, aliases, wrappers, fallbacks, compatibility shims, deprecated implementations, or unused code “just in case.” Treat requested changes as migrations, not additions: the new implementation replaces the old one. Prefer a clean, single current implementation over compatibility with previous versions. Assume there are no external users or consumers that require old behavior unless explicitly stated otherwise.

This applies to existing code as well as future changes. Correct authoritative definitions instead of adding compensating overrides. Trace callers, update tests, and verify the replacement. Do not delete necessary current-platform behavior or safe error handling based on keywords alone.

This instruction does not restart paused work, change ownership, authorize deployment, or override data-preservation requirements.
