# @grafctory/llms

Ready-made tasks and shared services for AI jobs.

**@grafctory/llms** is the AI task module of the [Grafctory][grafctory] model-driven knowledge graph framework. It
provides ready-made [@grafctory/flow] tasks for putting language models to work in a pipeline: prompting a model,
extracting structured records from free text, and embedding content for semantic retrieval. The tasks run under the
[@grafctory/gear] job executor, which supplies the shared services they draw on, including the clients of the model
providers they reach.

- **Ready-Made Tasks**: prompting, extraction and embedding, chaining alongside any other task
- **Shared Services**: model clients, credentials and response caches, built on demand and released after the run
- **Custom Bindings**: a stubbed, throttled or recorded model swapped in for a run, leaving the job untouched
- **Minimal Footprint**: one package per model provider, each pulling in only the SDK that provider needs

> [!IMPORTANT]
>
> Pipelines are server-side workloads targeting [Node.js](https://nodejs.org/) 22 or later, relying on facilities such
> as the filesystem, the process environment and `fetch`. The packages are not intended for the browser.

[@grafctory/flow]: https://github.com/grafctory/flow
[@grafctory/gear]: https://github.com/grafctory/gear
[grafctory]: https://github.com/grafctory

# Installation

```shell
npm install @grafctory/gear             # job executor and shared services
npm install @grafctory/llms             # AI tasks and shared services
npm install @grafctory/llms-<provider>  # model connectors, one package per provider
```

> [!WARNING]
>
> TypeScript consumers must use `"moduleResolution": "nodenext"/"node16"/"bundler"` in `tsconfig.json`.
> The legacy `"node"` resolver is not supported.

Install the core package, then add a connector package for each model provider the pipeline reaches. Each connector
package pulls in only the SDK its own provider needs and re-exports it in full, so pipelines import SDK values and
types from the connector and never install the SDK themselves. The [@grafctory/gear]
job executor ships separately: install it directly to set up and run the jobs putting tasks and connectors to work.

| Package                 | Description                  |
|-------------------------|------------------------------|
| [@grafctory/llms]        | AI tasks and shared services |
| [@grafctory/llms-google] | Google model connectors      |
| [@grafctory/llms-openai] | OpenAI model connectors      |

[@grafctory/llms]: https://grafctory.github.io/llms/modules/_grafctory_llms.html

[@grafctory/llms-google]: https://grafctory.github.io/llms/modules/_grafctory_llms-google.html

[@grafctory/llms-openai]: https://grafctory.github.io/llms/modules/_grafctory_llms-openai.html

# Usage

> [!NOTE]
>
> Each package documents its own API in its README and API reference; for complete coverage, see the
> [API reference](https://grafctory.github.io/llms/).

# Support

- open an [issue](https://github.com/grafctory/llms/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/grafctory/llms/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/grafctory/llms?tab=Apache-2.0-1-ov-file) file for details.

<sub>Grafctory™ is a trademark of Metreeca srl.</sub>
