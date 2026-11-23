# @metreeca/llms-openai

[![npm](https://img.shields.io/npm/v/@metreeca/llms-openai)](https://www.npmjs.com/package/@metreeca/llms-openai)

OpenAI model connectors for [@metreeca/llms](https://github.com/metreeca/llms).

Connects AI jobs to OpenAI models, ready to work alongside any other task in a pipeline. Long runs proceed reliably to
completion, and every result a job receives from a model can be trusted as complete. The cost of each request is logged
under the labels of the job issuing it, so any spike can be traced back to its source.

# Installation

```shell
npm install @metreeca/gear         # the job executor
npm install @metreeca/llms         # AI tasks and shared services
npm install @metreeca/llms-openai  # this package
```

> [!IMPORTANT]
>
> Node.js 22 or later is required.

> [!IMPORTANT]
>
> This package stands in for the OpenAI Node API Library: import SDK values and types from here, never from `openai`.
> It ships the SDK release its workarounds are tested against. A separately installed copy may be another release,
> and the client then no longer matches the SDK types the consumer imports from that copy.

> [!WARNING]
>
> TypeScript consumers must use `"moduleResolution": "nodenext"/"node16"/"bundler"` in `tsconfig.json`.
> The legacy `"node"` resolver is not supported.

# Usage

See the [API reference](https://metreeca.github.io/llms/modules/_metreeca_llms-openai.html).

# Support

- open an [issue](https://github.com/metreeca/llms/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/llms/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/llms?tab=Apache-2.0-1-ov-file) file for details.
