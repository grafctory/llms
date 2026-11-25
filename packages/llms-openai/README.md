# @grafctory/llms-openai

[![npm][npm-badge]][npm] [![Grafctory][grafctory-badge]][grafctory]

[npm-badge]: https://img.shields.io/npm/v/@grafctory/llms-openai
[npm]: https://www.npmjs.com/package/@grafctory/llms-openai
[grafctory-badge]: https://img.shields.io/badge/part%20of-Grafctory-blue
[grafctory]: https://github.com/grafctory

OpenAI model connectors for [@grafctory/llms].

Connects AI jobs to OpenAI models, ready to work alongside any other task in a pipeline. Long runs proceed reliably to
completion, and every result a job receives from a model can be trusted as complete. The cost of each request is logged
under the labels of the job issuing it, so any spike can be traced back to its source.

[@grafctory/llms]: https://github.com/grafctory/llms

# Installation

```shell
npm install @grafctory/gear         # the job executor
npm install @grafctory/llms         # AI tasks and shared services
npm install @grafctory/llms-openai  # this package
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

See the [API reference](https://grafctory.github.io/llms/modules/_grafctory_llms-openai.html).

# Support

- open an [issue](https://github.com/grafctory/llms/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/grafctory/llms/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/grafctory/llms?tab=Apache-2.0-1-ov-file) file for details.

<sub>Grafctory™ is a trademark of Metreeca srl.</sub>
