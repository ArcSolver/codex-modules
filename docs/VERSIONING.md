# Versioning

Codex modules are versioned independently with semver. Every module is currently `0.1.0` alpha.

## Runtime Support Policy

- The supported Node.js floor is the **lowest still-supported LTS**, not the newest release. Modules target `>=24` (the current Active LTS as of mid-2026); EOL lines (Node 20 ended maintenance in April 2026) are dropped rather than advertised.
- CI verifies on the Active LTS (Node 24). The floor moves forward only when an LTS line reaches end-of-life, and such a bump is recorded in each module's CHANGELOG.
- Build-only tooling (the `website/` docs build) may require a newer Node than the modules; it tracks whatever its toolchain (Astro) mandates.

## Promotion Criteria

### 0.2 beta

- Pass the min/latest Codex verification matrix on the next Codex stable line (`0.143+`).
- Start operating module CHANGELOG files for release notes.

### 1.0 stable

- Pass the live verification lane (`RUN_LIVE`) on a regular cadence.
- Complete one external user issue response cycle.
- Freeze the public API surface.

## Release Procedure

Release steps are documented in [Publishing](./PUBLISHING.md).
