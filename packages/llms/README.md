# @grafctory/llms

[![npm][npm-badge]][npm] [![Grafctory][grafctory-badge]][grafctory]

[npm-badge]: https://img.shields.io/npm/v/@grafctory/llms
[npm]: https://www.npmjs.com/package/@grafctory/llms
[grafctory-badge]: https://img.shields.io/badge/part%20of-Grafctory-blue
[grafctory]: https://github.com/grafctory

AI tasks and shared services for [@grafctory/llms].

Provides the building blocks shared by AI jobs and the model connectors serving them, from embedding vectors that work
with any model provider to model calls kept within rate quotas and traced to the source of their cost.

Jobs using them are set up and run under the [@grafctory/gear] job executor. This
package contributes building blocks for those jobs, not an execution runtime of its own.

[@grafctory/llms]: https://github.com/grafctory/llms
[@grafctory/gear]: https://github.com/grafctory/gear

# Installation

```shell
npm install @grafctory/gear  # the job executor
npm install @grafctory/llms  # this package
```

> [!IMPORTANT]
>
> Node.js 22 or later is required.

> [!WARNING]
>
> TypeScript consumers must use `"moduleResolution": "nodenext"/"node16"/"bundler"` in `tsconfig.json`.
> The legacy `"node"` resolver is not supported.

# Usage

| Module                            | Description         |
|-----------------------------------|---------------------|
| [@grafctory/llms/vectors][vectors] | Embedding vectors   |
| [@grafctory/llms/quotas][quotas]   | Model rate quotas   |
| [@grafctory/llms/usage][usage]     | Model usage tracing |

[vectors]: https://grafctory.github.io/llms/modules/_grafctory_llms.vectors.html

[quotas]: https://grafctory.github.io/llms/modules/_grafctory_llms.quotas.html

[usage]: https://grafctory.github.io/llms/modules/_grafctory_llms.usage.html

# Support

- open an [issue](https://github.com/grafctory/llms/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/grafctory/llms/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/grafctory/llms?tab=Apache-2.0-1-ov-file) file for details.

<sub>Grafctory™ is a trademark of Metreeca srl.</sub>
