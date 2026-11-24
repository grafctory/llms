> [!CAUTION]
>
> - **ONLY** modify code when explicitly requested or clearly required.
> - **NEVER** make unsolicited changes or revert **unrelated** user edits.
> - **ALWAYS** monitor IDE diagnostics when working on a file

> [!CAUTION]
> Activating and following skill guidance is **MANDATORY** for every task. Before starting any work, identify and
> activate all relevant skills. Skill instructions are binding and override default behaviours. When in doubt about
> whether skill guidance is current, relevant skills MUST be reloaded.

# Overview

`@grafctory/llms` is a standalone, general-purpose monorepo collecting the AI task framework core and its provider
packages, each sitting directly under `packages/` (for example `packages/llms/`).

Jobs run under the `@grafctory/gear` executor: this repository contributes model services and tasks, **NEVER** an
execution runtime of its own. Reach for `executor`, `bind` and `service` from `@grafctory/gear` rather than
reimplementing them, and keep the service contracts compatible with the ones `@grafctory/gear` already resolves.

# References

- [@grafctory/core](https://github.com/grafctory/core) - Core utilities and shared types
- [@grafctory/flow](https://github.com/grafctory/flow) - Composable async iterable processing
- [@grafctory/tape](https://github.com/grafctory/tape) - Simplified facade for the LogTape logging framework
- [@grafctory/gear](https://github.com/grafctory/gear) - Job executor and shared services for data pipelines, which this
  repository builds on

# NPM Scripts

- **`npm run clean`** - Remove dependencies and build artefacts
- **`npm run prime`** - Install dependencies from the lockfile
- **`npm run setup`** - Install dependencies and link sibling `@grafctory/*` repositories
- **`npm run build`** - Compile sources and generate docs
- **`npm run check`** - Run the test suite
- **`npm run proof`** - Build and serve docs

> [!CAUTION]
> **`prime` and `setup` are not interchangeable.** Run `prime` when finalising a public release: `@grafctory/*` imports
> resolve to the published releases recorded in the lockfile. Run `setup` for local development against unpublished
> sibling branches: imports resolve to the working copies in the neighbouring repositories.

# Package Layout

The root `package.json` `workspaces` glob (`packages/*`) covers the framework packages, each in its own directory
immediately under `packages/` (for example `packages/llms`).

Provider packages are self-contained leaves named after the vendor, not the cloud platform or the model family:
`llms-google`, not `llms-gcp` or `llms-gemini`. Each pulls in the core package transitively and only the SDK its own
provider needs.

# Provider SDKs

A provider package is a drop-in replacement for its vendor SDK: its value is a patched client working around API and
SDK quirks without the consumer knowing about them. Every provider package therefore holds to the same contract:

- **Re-export the whole SDK**: `export * from "<sdk>"` in `src/index.ts`, plus `export { default } from "<sdk>"`
  where the SDK has a default export, so consumers import SDK values and types from the provider package alone and
  they always match the client; a test asserts that every SDK export comes through unchanged
- **Regular dependency, never a peer**: a peer would let the consumer pick an SDK release the workarounds were never
  tested against, and would force them to declare the SDK themselves, defeating the drop-in
- **Tilde range at the tested release** (`~2.30.0`): the workarounds reach into SDK internals that a minor release
  may change silently; widen or move the range only after re-running the provider tests against the new release
- **SDK surface is public API**: a range move that breaks the re-exported surface is a breaking change of the provider
  package (`version-manager:semver`)
- **Docs stay ours**: the shared TypeDoc `excludeExternals` keeps the re-exported SDK out of the generated site, which
  links SDK symbols to the vendor reference through `externalSymbolLinkMappings`

# Shared Utilities

Reach for `@grafctory/core` before writing a helper: its `strings`, `numbers`, `arrays` and `values` entry points
already cover text tidying, escaping, splitting and templating alongside the common collection and value operations. A
hand-rolled equivalent duplicates tested code and drifts from it, missing the edge cases the shared one handles.

Keep a local helper only where the shared one genuinely doesn't fit, and record in its doc comment what the difference
is, so the next reader doesn't take it for an oversight.

# Service Resolution

Calls to `service()` are **NEVER** inlined into a larger expression: always bind the resolved instance to a `const` on a
line of its own, then use it. This keeps the resolution point visible, since it depends on the enclosing execution
rather than on the surrounding expression.

```typescript
const model = service(getModel); // ✅
const answer = lazy(async () => model(await prompt(question)));

const answer = lazy(async () => service(getModel)(await prompt(question))); // ❌
```

# Testing

The root `vitest.config.ts` resolves imports of symlinked `@grafctory/*` packages, both workspace packages and siblings
linked by `npm run setup`, to the TypeScript source their `@grafctory/source` export entries declare, so tests run
against `src/` without a prior build. Packages installed from the registry keep resolving to their published `dist`.
An export entry lacking the condition falls back to `dist` as well, and tests then see that package as last built.

> [!CAUTION]
> **NEVER** enable `@grafctory/source` through vitest `resolve.conditions`. Published manifests carry the condition
> while their packages ship no `src/`, and Vite does not fall back to `default` on a missing target, so a global
> condition breaks every package installed from the registry that declares it, as happens under `npm ci` in CI.

# Version Management

All workspace packages share the root `package.json` version. Beyond the `version` fields the release flow already
cascades, update the internal `@grafctory/llms*` dependency ranges in every `packages/**/package.json` to match.

When adding, removing, or renaming packages, update the package table in the root `README.md` Usage section to match.
