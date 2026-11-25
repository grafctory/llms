# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> [!NOTE]
> Packages published under the `@grafctory` scope from version 0.5.0; earlier versions were published under `@metreeca`.

## [Unreleased](https://github.com/grafctory/llms/compare/v0.5.0...HEAD)

## [0.5.0](https://github.com/grafctory/llms/compare/v0.4.0...v0.5.0) - 2026-11-24

### Added

- `@metreeca/llms-google` and `@metreeca/llms-openai` re-export the whole surface of their provider SDK
  ([#7](https://github.com/grafctory/llms/issues/7)), so pipelines import SDK values and types from the connector,
  always matching its client, and never declare `@google/genai` or `openai` as dependencies of their own

- `createGoogleAI` and `createOpenAI` take `labels`, fixed or computed on each request, attached where the provider
  accepts them, and log the model, labels and token usage of every request
  ([#8](https://github.com/grafctory/llms/issues/8)), so a cost spike can be traced to the job causing it from the log

- `@metreeca/llms/quotas` and `@metreeca/llms/usage` — model rate quotas and usage tracing for model connectors
  ([#8](https://github.com/grafctory/llms/issues/8)), so concurrent jobs drawing on the same model are paced together
  and every request logs its token usage under the labels of the source it is charged to

### Changed

- **Breaking**: `@metreeca/llms` — the root entry point is replaced by the `vectors`, `quotas` and `usage` entry
  points; migrate `import { cosine } from "@metreeca/llms"` to `import { cosine } from "@metreeca/llms/vectors"`,
  and likewise for `synopsis`, `compress`, `decompress` and the `Vector` and `Distance` types they operate on

- **Breaking**: `@metreeca/llms-google` — a requested response schema is submitted with every request carrying tools,
  and a model rejecting it fails with the API error rather than replying through a hidden `gemini-2.5-flash-lite`
  conversion ([#6](https://github.com/grafctory/llms/issues/6)), so generations reach only the model the caller named;
  migrate requests combining a response schema with `tools` on a model before Gemini 3 to a Gemini 3 or later model,
  or drop the schema from those requests and parse the prose reply the model returns into the shape required

- **Breaking**: `@metreeca/llms-google` requires `@google/genai` `~2.30.0` and `@metreeca/llms-openai` requires
  `openai` `~7.25.0`, pinning each connector to the SDK release its workarounds are tested against; migrate direct
  imports of `@google/genai` or `openai` to the connector re-exports and drop those SDKs from your own dependencies

- `createGoogleAI` and `createOpenAI` pace each model at the request limit the provider advertises for it
  ([#9](https://github.com/grafctory/llms/issues/9)), so a run reaches the full rate its quota allows instead of
  being held back by a fixed pacing floor or slowed down by the repeated rate rejections a probing throttle meets

### Fixed

- `@metreeca/llms-google` — the `usageMetadata` of a generation resolving function calls accounts for every turn
  ([#5](https://github.com/grafctory/llms/issues/5)), so token budgets and accounting no longer undercount tool-using
  runs by missing the tokens spent on every turn of a generation but the last one it issued

## [0.4.0](https://github.com/grafctory/llms/compare/v0.3.1...v0.4.0) - 2026-11-17

### Changed

- **Breaking**: Upgrade `@metreeca/core` to `^0.14.0`, `@metreeca/http` to `^0.6.0` and `@metreeca/tape` to `^0.13.0`;
  projects using them alongside these packages raise their own ranges as well, so that each is shared as a single copy

### Security

- Upgrade the development dependencies `vite` to `8.3.5` (GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv,
  GHSA-r825-w8mm-5pxw, GHSA-vfpm-58rq-9qcg, GHSA-rq7h-c2jc-7f22, GHSA-9jrq-w75r-8gcw), `markdown-it` to `14.3.3`
  (GHSA-gfr2-rv44-r23c, GHSA-r7fv-28h4-cvq7, GHSA-vfgh-jcmw-g37q) and `vitest` to `4.1.12` (GHSA-qxg6-89mg-rqv8,
  GHSA-xp26-3454-mjgp); none of them ships to consumers, so installed packages are unaffected

## [0.3.1](https://github.com/grafctory/llms/compare/v0.3.0...v0.3.1) - 2026-10-20

### Changed

- `@metreeca/llms-google` — require `@google/genai` `^2.28.0`, so that a consumer on a current SDK release resolves a
  single copy of it and shares its response types with the client, rather than type-checking against a second copy

## [0.3.0](https://github.com/grafctory/llms/compare/v0.2.0...v0.3.0) - 2026-10-20

### Added

- `@metreeca/llms` — embedding vector primitives: `synopsis()` builds the text to be embedded for a resource, `cosine()`
  ranks vectors by semantic proximity, and `compress()`/`decompress()` store them compactly as text
- `@metreeca/llms-google` — `createGoogleAI()` Gemini API client paced against the published rate quotas, honouring
  response schemas alongside tools, with `text()`, `json()` and `embedding()` response accessors
- `@metreeca/llms-openai` — `createOpenAI()` OpenAI API client paced against the published rate quotas, with `text()`,
  `json()` and `embedding()` accessors rejecting refused, truncated and malformed generations

### Changed

- Rename `@metreeca/muse`, `@metreeca/muse-google` and `@metreeca/muse-openai` to `@metreeca/llms`,
  `@metreeca/llms-google` and `@metreeca/llms-openai`; the former names receive no further releases
- Upgrade `@metreeca/core` to `^0.13.0`
- Upgrade `@metreeca/tape` to `^0.12.0`
- Drop the `@metreeca/flow` and `@metreeca/gear` dependencies, which no package imports

## [0.2.0](https://github.com/grafctory/llms/compare/v0.1.1...v0.2.0) - 2026-10-14

### Added

- `@metreeca/muse-openai` — OpenAI model connectors; the module carries no public API yet

### Changed

- Require `@metreeca/core` `^0.12.1`, `@metreeca/flow` `^0.11.1`, `@metreeca/gear` `^0.3.1` and `@metreeca/tape`
  `^0.11.1`, so that a consumer on the current line resolves one copy of each rather than a second, superseded one

## [0.1.1](https://github.com/grafctory/llms/compare/v0.1.0...v0.1.1) - 2026-09-09

### Changed

- requires `@metreeca/core` `^0.10.0`, `@metreeca/flow` `^0.10.0`, `@metreeca/gear` `^0.2.0` and `@metreeca/tape`
  `^0.10.1`, so that a consumer on the current line resolves one copy of each rather than a second, superseded one

## [0.1.0](https://github.com/grafctory/llms/releases/tag/v0.1.0) - 2026-09-04

Initial release, claiming the package names and enabling automated publishing. The modules carry no public API yet:
jobs run under the [@metreeca/gear](https://github.com/grafctory/gear) executor, to which this repository contributes
model services and tasks.

- `@metreeca/muse` — AI tasks and shared services
- `@metreeca/muse-google` — Google model connectors
