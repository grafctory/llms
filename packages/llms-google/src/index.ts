/*
 * Copyright © 2026 Metreeca srl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Google model connectors.
 *
 * Connects AI jobs to Google models, ready to work alongside any other task in a pipeline. Long runs proceed reliably
 * to completion, and every result a job receives from a model can be trusted as complete. The cost of each request is
 * logged under the labels of the job issuing it, so any spike can be traced back to its source.
 *
 * Stands in for the Google GenAI SDK, whose whole surface it re-exports: import SDK values and types from here rather
 * than from `@google/genai`, so they always match the client and no direct dependency on the SDK is needed.
 *
 * @module index
 *
 * @see {@link https://ai.google.dev/gemini-api/docs Gemini API documentation}
 * @see {@link https://googleapis.github.io/js-genai/release_docs/index.html Google GenAI SDK}
 */

import {
	ApiError,
	CallableTool,
	Content,
	ContentListUnion,
	EmbedContentResponse,
	GenerateContentParameters,
	GenerateContentResponse,
	GenerateContentResponseUsageMetadata,
	GoogleGenAI,
	GoogleGenAIOptions,
	ModalityTokenCount,
	Part
} from "@google/genai";
import { eager, error, isArray, isObject, isString, type Lazy, memo, type Optional, type Value } from "@grafctory/core";
import { TooManyRequests } from "@grafctory/http";
import { createQuota } from "@grafctory/llms/quotas";
import { charge, type Labels } from "@grafctory/llms/usage";
import type { Vector } from "@grafctory/llms/vectors";
import { report } from "@grafctory/tape";


export * from "@google/genai";


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a Gemini API client that works around known API limitations.
 *
 * The client exposes the full {@link GoogleGenAI} surface. Model methods issuing requests are paced against the
 * published rate quotas, and content generation resolves function calls at the same pace, sending every request
 * to the model the caller named and never to a model of the client's own choosing.
 *
 * @param options The client options, as accepted by the {@link GoogleGenAI} constructor; if omitted, the SDK defaults
 *                apply, reading the API key for the Gemini API from the environment. Vertex AI is reached instead by
 *                setting `vertexai`, `project` and `location`, with Google Cloud project credentials. Unless
 *                `httpOptions.retryOptions` is set, transient failures are retried with the default SDK retry options
 * @param options.labels The labels identifying the cost source of the requests the client issues, either fixed or
 *                       computed on each request, so that they can name the job issuing it from the context it runs
 *                       in; merged with the `config.labels` of the request, which win on shared keys
 *
 * @returns A client sharing throttling and logging among requests to the same model; models are told apart by their
 *          exact id, so the bare and `models/`-prefixed forms of an id are paced separately, even though both draw
 *          on the same project quota and may overrun it together when both forms are in use at the same time
 *
 * @remarks
 *
 * A client is meant to be configured once by the consumer binding it, so that credentials and endpoint are settled for
 * a whole execution rather than repeated by each job that draws on the same models.
 *
 * The client takes over two concerns the API and the SDK leave to the caller:
 *
 * - **Quota control**: every request is paced against a per-model adaptive throttle. A request rejected over the rate
 *   quota is resumed after the `RetryInfo` delay the API advertises, so a long run keeps within the quota instead of
 *   failing on 429 errors. The API states the request limit of a model only when rejecting a request over it, so a
 *   model runs as fast as the throttle finds feasible until its first rejection over requests per minute, and is then
 *   held to the limit that rejection states. Other transient failures, such as an overloaded model, are retried as
 *   stated by `options`, so a run survives a spike in demand on the model rather than aborting on the first one.
 *
 * - **Function calling**: when a request declares `tools`, the client resolves function calls itself, issuing one
 *   throttled request per turn. Turns are unlimited unless `automaticFunctionCalling.maximumRemoteCalls` bounds them,
 *   and only `CallableTool` tools are invoked. A request disabling automatic function calling is submitted once, and
 *   its function calls are returned to the caller. The request fails with an {@link !Error Error} if a response
 *   carries no model content, if the model calls a function while no callable tool is declared, or if the turn limit
 *   runs out before a final response; in every case the error carries no partial conversation.
 *
 * > [!WARNING]
 * >
 * > A JSON response requested with `tools` enabled requires a Gemini 3 or later model. Earlier models reject a response
 * > schema alongside `tools`: the request then fails with the API error, and no other model is ever substituted for the
 * > one the caller named, so the response is always generated by the requested model or not at all.
 *
 * The `usageMetadata` of a returned response accounts for every function calling turn issued to produce it, so token
 * budgets and accounting see what the generation actually cost. Token counts are summed across turns, while
 * `initialPromptTokenCount` is taken from the first turn and `trafficType` from the last: a prompt size and a billing
 * tier each describe a single request and do not add up across the several turns of a generation.
 *
 * Every response to a content generation request, streamed or not, is logged with its model, labels and token usage,
 * one entry per request, so a cost spike can be traced to the job causing it from the log alone. Input tokens include
 * those spent on tool use prompts, output tokens those spent on reasoning, which are also stated on their own.
 *
 * Labels are attached to content, image and video generation requests on Vertex AI alone, where they also split billing
 * reports. Vertex AI accepts at most 64 labels per request, with keys and values of up to 63 lowercase letters, digits,
 * underscores and dashes, keys opening with a letter. The client labels, merged with the `config.labels` of the request,
 * are brought within these limits before they are attached, so that a path such as `/events/coimbra-university` is
 * always sent as `events-coimbra-university`, and they are logged as supplied. Where they exceed the label count, client
 * labels are dropped first. The Gemini Developer API rejects labels altogether, so there they are only logged.
 *
 * @see {@link https://ai.google.dev/gemini-api/docs/function-calling Function calling}
 * @see {@link https://ai.google.dev/gemini-api/docs/structured-output Structured output}
 * @see {@link https://ai.google.dev/gemini-api/docs/rate-limits Rate limits}
 * @see {@link https://github.com/googleapis/js-genai/issues/727 js-genai#727}
 */
export function createGoogleAI({ labels = {}, ...options }: GoogleGenAIOptions & {

	readonly labels?: Lazy<Labels>

} = {}) {

	const ai = new GoogleGenAI({

		...options,

		httpOptions: {

			// the SDK retries a transient rejection only where retry options are stated, otherwise
			// failing the request outright: a spike in demand on the model would abort a whole run

			retryOptions: {},

			...options.httpOptions

		}

	});

	/**
	 * Retrieves the rate quota shared by all requests to a model, opening it on first request.
	 *
	 * Quotas are keyed by exact model id, so bare and `models/`-prefixed ids are paced apart.
	 *
	 * @param model The target model name
	 *
	 * @returns The quota registered for `model`, retained for the lifetime of the client (see {@link memo})
	 */
	const quotas = memo(createQuota);


	return Object.assign(ai, { // patch to work around known issues

		models: Object.assign(ai.models, {

			generateContent: (generateContent =>

					async (...[{ config, ...params }, ...rest]: Parameters<typeof generateContent>) => {

						return config?.tools
							? await execute()
							: await generate({ ...params, config });


						/**
						 * Submits a single labelled model request under the quota of the target model, logging usage.
						 *
						 * @param request The request to submit
						 *
						 * @returns The model response to `request`
						 *
						 * @throws {ApiError} If the request fails for a reason the throttle cannot recover from
						 */
						async function generate(request: GenerateContentParameters) {

							const [tags, $request] = labelled(request);

							const response = await paced(request.model, () => generateContent($request, ...rest));

							record(request.model, tags, response.usageMetadata);

							return response;

						}


						/**
						 * Resolves a request carrying tools, driving function calling under quota throttling.
						 *
						 * The SDK resolves function calls through an internal loop that neither throttles its requests
						 * nor recovers from quota exhaustion, so long tool sessions fail with unexpected 429 errors:
						 * function declarations count towards the token limit, every turn issues a further request, and
						 * tools such as Browser MCP or Google Search resubmit massive contexts on each one of them.
						 *
						 * The same failures are reported against other SDKs:
						 *
						 * - googleapis/python-genai#17: 429 errors with the Google Search tool
						 * - google/adk-python#1057: 1.5M tokens in ~20 requests with Browser MCP, which sends the
						 *   entire DOM as context
						 *
						 * Turns are driven by {@link afc} instead, one throttled request at a time (see
						 * {@link request}), and a requested response schema is submitted with every one of them.
						 * Requests that disable automatic function calling take the same throttled route, but are
						 * submitted once and returned as they come, function calls included, for the caller to resolve.
						 *
						 * @returns The final response of the loop, or the single response to a request disabling it
						 *
						 * @throws {@link !Error Error} If the function calling loop fails (see {@link afc})
						 */
						async function execute(): Promise<GenerateContentResponse> {

							const {
								automaticFunctionCalling: {
									disable = false,
									maximumRemoteCalls = 0
								} = {}
							} = config ?? {};

							return disable
								? await request(params.contents)
								: await afc();

							/**
							 * Drives the function calling loop until the model returns a final response.
							 *
							 * Throttled model requests (see {@link request}) alternate with tool dispatch: the function
							 * calls requested by the model go to every `CallableTool` declared in the request, and
							 * their results feed the next turn, until a response requests no further call.
							 *
							 * @returns The final model response, with the conversation history attached as
							 *          `automaticFunctionCallingHistory` and the usage of every turn as `usageMetadata`
							 *
							 * @throws {@link !Error Error} If a response carries no model content, if a function is
							 *         requested while no callable tool is declared, or if `maximumRemoteCalls` turns
							 *         are exhausted without a final response
							 */
							async function afc() {

								const callables = config?.tools?.filter((tool): tool is CallableTool =>
									typeof tool === "object" && tool !== null && "callTool" in tool
									&& typeof tool.callTool === "function"
								) ?? [];

								return await converse((Array.isArray(params.contents)
										? params.contents
										: [params.contents]
								).map(content =>
									isString(content) ? { role: "user", parts: [{ text: content }] }
										: "role" in content && "parts" in content ? content
											: { role: "user", parts: [content as Part] }
								), undefined, 0);


								async function converse(
									history: Content[],
									usage: undefined | GenerateContentResponseUsageMetadata,
									turn: number
								): Promise<GenerateContentResponse> {

									if ( maximumRemoteCalls !== 0 && turn >= maximumRemoteCalls ) {

										throw new Error(`maximum turns (${maximumRemoteCalls}) reached without completion`);

									} else {

										const response = await request(history);

										const content = response.candidates?.[0]?.content;
										const calls = (content?.parts ?? [])
											.map(part => part.functionCall)
											.filter(call => call !== undefined);

										const $usage = combine(usage, response.usageMetadata);

										if ( !content ) {

											throw new Error("no model content in response");

										} else if ( calls.length === 0 ) {

											return Object.assign(response, {
												automaticFunctionCallingHistory: history,
												usageMetadata: $usage
											});

										} else if ( callables.length === 0 ) {

											throw new Error(`no callable tools available to fulfill model requests <${
												calls.map(call => call.name).join(", ")
											}>`);

										} else {

											return await converse([...history, content, {
												role: "user",
												parts: (await Promise.all(callables.map(tool => tool.callTool(calls)))).flat()
											}], $usage, turn+1);

										}

									}

								}

							}

							/**
							 * Submits a single model request under the throttle of the target model.
							 *
							 * Every request carrying tools is submitted here, with the SDK function calling loop always
							 * disabled, so each call performs exactly one request and turn management stays with
							 * {@link afc}. A 429 rejection is retried after the delay advertised by the API.
							 *
							 * @param contents The conversation to submit
							 *
							 * @returns The model response to `contents`
							 *
							 * @throws {ApiError} If the request fails for a reason the throttle cannot recover from
							 */
							async function request(contents: ContentListUnion) {

								return await generate({
									...params,
									contents,

									config: {

										...config,

										// disable the SDK loop: it would resolve function calls without throttling,
										// leaving this loop with nothing but the final response

										automaticFunctionCalling: { disable: true }

									}

								});

							}

						}

					}

			)(ai.models.generateContent.bind(ai.models)),

			generateContentStream: (generateContentStream =>

					async (params: GenerateContentParameters) => {

						const [tags, $params] = labelled(params);

						const chunks = await paced(params.model, () => generateContentStream($params));

						return relay(params.model, tags, chunks);

					}

			)(ai.models.generateContentStream.bind(ai.models)),
			embedContent: throttled(ai.models.embedContent.bind(ai.models)),

			countTokens: throttled(ai.models.countTokens.bind(ai.models)),
			computeTokens: throttled(ai.models.computeTokens.bind(ai.models)),

			generateImages: throttled(tagged(ai.models.generateImages.bind(ai.models))),
			generateVideos: throttled(tagged(ai.models.generateVideos.bind(ai.models)))

		})

	});


	/**
	 * Submits a request under the quota of the model it targets.
	 *
	 * A rejection over the rate quota holds the model to the request limit it states, if any, from the next request on.
	 *
	 * @typeParam V The type of the value the request resolves to
	 *
	 * @param model The model the request targets
	 * @param request The request to submit, issued anew on every attempt
	 *
	 * @returns The value `request` resolves to, resumed as many times as the rate quota requires
	 *
	 * @throws {ApiError} If the request fails for a reason the throttle cannot recover from
	 */
	function paced<V>(model: string, request: () => Promise<V>): Promise<V> {

		const pace = quotas(model);

		return pace.submit(request, error => {

			pace.limit(advertised(error));

			return quota(error);

		});

	}

	/**
	 * States the delay a request rejected over the rate quota is to be retried after.
	 *
	 * @param error The rejection to recover from
	 *
	 * @returns The delay advertised by the API, in ms, if `error` reports an exhausted quota alongside a `RetryInfo`
	 *          detail; undefined otherwise, leaving the rejection to the caller
	 *
	 * @see {@link https://ai.google.dev/gemini-api/docs/rate-limits Rate limits}
	 */
	function quota(error: unknown): undefined | number {

		const delay = details(error)
			.find(detail => `${detail["@type"]}`.includes("RetryInfo"))
			?.["retryDelay"];

		const match = `${delay}`.match(/^(\d+(?:\.\d+)?)s$/);

		return match ? Math.ceil(parseFloat(match[1])*1000) : undefined;

	}

	/**
	 * States the request limit a rejection over the rate quota advertises for its model.
	 *
	 * @param error The rejection to inspect
	 *
	 * @returns The requests per minute stated by a `QuotaFailure` violation of a per-minute request quota, if `error`
	 *          reports one; undefined otherwise, as the limits of token and daily quotas have no bearing on the pace
	 *
	 * @see {@link https://ai.google.dev/gemini-api/docs/rate-limits Rate limits}
	 */
	function advertised(error: unknown): Optional<number> {

		const violations = details(error)
			.find(detail => `${detail["@type"]}`.includes("QuotaFailure"))
			?.["violations"];

		const limit = Number((isArray(violations) ? violations : [])
			.filter(violation => isObject(violation))
			.find(violation => `${violation["quotaId"]}`.includes("RequestsPerMinute"))
			?.["quotaValue"]
		);

		return Number.isFinite(limit) && limit > 0 ? limit : undefined;

	}

	/**
	 * Retrieves the details of a rejection over the rate quota.
	 *
	 * @param error The rejection to inspect
	 *
	 * @returns The details of `error`, if it reports an exhausted quota; an empty list otherwise
	 */
	function details(error: unknown): readonly Record<string, unknown>[] {

		if ( error instanceof ApiError && error.status === TooManyRequests ) {

			return (error as ApiError & { // ;(cast) the SDK error type carries no quota details
				error?: { details?: readonly Record<string, unknown>[] }
			}).error?.details ?? [];

		} else {

			return [];

		}

	}

	/**
	 * Adapts a model method into one submitting its requests under the throttle of the model they target.
	 *
	 * @typeParam P The type of the request parameters, naming the target model
	 * @typeParam V The type of the value the method resolves to
	 *
	 * @param method The model method to adapt
	 *
	 * @returns A method submitting the requests of `method` under the quota of their model (see {@link quotas})
	 */
	function throttled<P extends { model: string }, V>(method: (params: P) => Promise<V>): (params: P) => Promise<V> {

		return params => paced(params.model, () => method(params));

	}

	/**
	 * Adapts a model method into one attaching the client labels to its requests.
	 *
	 * @typeParam P The type of the request parameters, carrying the request labels
	 * @typeParam V The type of the value the method resolves to
	 *
	 * @param method The model method to adapt
	 *
	 * @returns A method submitting the requests of `method` as labelled by {@link labelled}
	 */
	function tagged<P extends { readonly config?: { readonly labels?: Record<string, string> } }, V>(
		method: (params: P) => Promise<V>
	): (params: P) => Promise<V> {

		return params => method(labelled(params)[1]);

	}

	/**
	 * Labels a request with the client labels.
	 *
	 * The client labels are computed anew for each request, so that they can name the job issuing it.
	 *
	 * @typeParam P The type of the request parameters, carrying the request labels
	 *
	 * @param params The request to label
	 *
	 * @returns The client labels merged with the request ones, which win on shared keys, paired with `params` carrying
	 *          them on Vertex AI brought within its limits (see {@link normalise}), or left as they stand on the Gemini
	 *          Developer API, which rejects labels in any form, request labels included
	 */
	function labelled<P extends { readonly config?: { readonly labels?: Record<string, string> } }>(
		params: P
	): [Labels, P] {

		const request = params.config?.labels;

		// request labels lead, so that the provider count limit drops client labels first, and win on shared keys

		const tags = { ...request, ...eager(labels), ...request };

		return [tags, ai.vertexai ? { ...params, config: { ...params.config, labels: normalise(tags) } } : params];

	}

	/**
	 * Relays a streamed generation, logging its usage once it ends.
	 *
	 * Usage is stated as accumulated so far by each chunk, so the last one stating it accounts for the whole request;
	 * a stream abandoned or failing before completion is logged with the usage stated up to that point.
	 *
	 * @param model The model the request was submitted to
	 * @param tags The labels the request was submitted with
	 * @param chunks The streamed generation
	 *
	 * @returns The chunks of `chunks`, as they stand
	 */
	async function* relay(
		model: string,
		tags: Labels,
		chunks: AsyncGenerator<GenerateContentResponse>
	): AsyncGenerator<GenerateContentResponse> {

		let usage: undefined | GenerateContentResponseUsageMetadata; // ;(let) accumulated across async iteration

		try {

			for await (const chunk of chunks) { // ;(loop) relays an async stream, one chunk at a time
				usage = chunk.usageMetadata ?? usage;
				yield chunk;
			}

		} finally {

			record(model, tags, usage);

		}

	}

	/**
	 * Logs the usage of a request.
	 *
	 * @param model The model the request was submitted to
	 * @param tags The labels the request was submitted with
	 * @param usage The usage stated by the response to the request, if any
	 */
	function record(model: string, tags: Labels, usage: undefined | GenerateContentResponseUsageMetadata) {

		const reasoning = usage?.thoughtsTokenCount ?? 0;

		charge(model, tags, {
			input: (usage?.promptTokenCount ?? 0)+(usage?.toolUsePromptTokenCount ?? 0),
			output: (usage?.candidatesTokenCount ?? 0)+reasoning,
			reasoning
		});

	}

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Extracts the output text of a Gemini API response.
 *
 * Thinking parts and function calls are skipped, so only the text generated for the caller is returned. A response
 * without output text is rejected as an empty generation. The error names the finish reason, so a generation the model
 * withheld, for instance for `RECITATION`, can be told apart from a malformed payload.
 *
 * @param response The response of a `generateContent` request
 *
 * @returns The trimmed output text of `response`, joining the text of multiple parts with blank lines
 *
 * @throws {@link !Error Error} If `response` carries no output text, naming the finish reason of the response
 */
export function text(response: GenerateContentResponse): string {

	const candidate = response.candidates?.[0];
	const parts = (candidate?.content?.parts ?? []).filter(part => part.text && !part.thought);

	return parts.length > 0 ? parts
		.map(part => part.text)
		.join("\n\n")
		.trim() : error(`empty generation <${candidate?.finishReason}>`);
}

/**
 * Extracts the output text of a Gemini API response as a JSON payload.
 *
 * The payload is parsed from the output text produced under the requested response schema, and typed as `T` without
 * further validation: callers needing guarantees on its shape must validate it themselves.
 *
 * @typeParam T The expected shape of the JSON payload
 *
 * @param response The response of a `generateContent` request carrying a response schema
 *
 * @returns The JSON payload parsed from the output text of `response`
 *
 * @throws {@link !Error Error} If `response` carries no output text (see {@link text}), or if its text is not
 * well-formed JSON, for instance because the reply was cut short by an exhausted output budget
 */
export function json<T extends Value = Value>(response: GenerateContentResponse): T {

	const output = text(response);

	try {

		return JSON.parse(output);

	} catch ( e ) {

		throw new Error(`malformed model response: ${report(e)}`);

	}

}

/**
 * Extracts the embedding of a Gemini API response.
 *
 * @param response The response of an `embedContent` request
 *
 * @returns The {@link Vector} embedded for the first content of `response`, or an empty array if it carries none
 */
export function embedding(response: EmbedContentResponse): Vector {

	return response.embeddings?.[0]?.values ?? [];

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Combines the usage of two consecutive requests into the usage of the generation issuing both.
 *
 * @param earlier The usage of the earlier request, if stated
 * @param later The usage of the later request, if stated
 *
 * @returns The token counts of `earlier` and `later` summed, by modality where detailed, with the initial prompt size
 *          of `earlier` and the traffic type of `later`; the other usage if only one is stated, undefined if neither
 */
function combine(
	earlier: undefined | GenerateContentResponseUsageMetadata,
	later: undefined | GenerateContentResponseUsageMetadata
): undefined | GenerateContentResponseUsageMetadata {

	return earlier === undefined ? later : later === undefined ? earlier : {

		promptTokenCount: sum(earlier.promptTokenCount, later.promptTokenCount),
		candidatesTokenCount: sum(earlier.candidatesTokenCount, later.candidatesTokenCount),
		cachedContentTokenCount: sum(earlier.cachedContentTokenCount, later.cachedContentTokenCount),
		thoughtsTokenCount: sum(earlier.thoughtsTokenCount, later.thoughtsTokenCount),
		toolUsePromptTokenCount: sum(earlier.toolUsePromptTokenCount, later.toolUsePromptTokenCount),
		totalTokenCount: sum(earlier.totalTokenCount, later.totalTokenCount),

		promptTokensDetails: tally(earlier.promptTokensDetails, later.promptTokensDetails),
		candidatesTokensDetails: tally(earlier.candidatesTokensDetails, later.candidatesTokensDetails),
		cacheTokensDetails: tally(earlier.cacheTokensDetails, later.cacheTokensDetails),
		toolUsePromptTokensDetails: tally(earlier.toolUsePromptTokensDetails, later.toolUsePromptTokensDetails),

		initialPromptTokenCount: earlier.initialPromptTokenCount ?? later.initialPromptTokenCount,
		trafficType: later.trafficType ?? earlier.trafficType

	};


	function sum(x: undefined | number, y: undefined | number) {
		return x === undefined && y === undefined ? undefined : (x ?? 0)+(y ?? 0);
	}

	function tally(x: undefined | ModalityTokenCount[], y: undefined | ModalityTokenCount[]) {

		const counts = [...x ?? [], ...y ?? []];

		return x === undefined && y === undefined ? undefined : [...new Set(counts.map(({ modality }) => modality))]
			.map(modality => ({
				modality, tokenCount: counts
					.filter(count => count.modality === modality)
					.reduce((total, { tokenCount }) => total+(tokenCount ?? 0), 0)
			}));

	}

}

/**
 * Brings labels within the limits Vertex AI sets on request labels.
 *
 * Lets free-form labels, such as the `/events/coimbra-university` path of a job, be attached to requests:
 *
 * - keys and values are lowercased and stripped of diacritics
 * - every run of characters other than letters, digits, underscores and dashes is replaced by a single dash
 * - leading characters are ignored until a letter opens a key, or a letter or a digit opens a value
 * - separators closing a key or a value are ignored, and both are clipped to 63 characters
 * - entries whose key is left empty are dropped, and only the first 64 entries are kept
 *
 * @param labels The labels to normalise
 *
 * @returns The labels in `labels` rewritten within the Vertex AI limits, conforming labels unchanged
 *
 * @see {@link https://cloud.google.com/vertex-ai/docs/general/labels Vertex AI labels}
 */
function normalise(labels: Labels): Labels {

	const normalised = Object.fromEntries(Object.entries(labels)
		.map(([key, value]): [string, string] => [clean(key, /^[^a-z]+/), clean(value, /^[^a-z0-9]+/)])
		.filter(([key]) => key !== "")
	);

	return Object.fromEntries(Object.entries(normalised).slice(0, 64));


	function clean(text: string, lead: RegExp): string {
		return text
			.normalize("NFKD")
			.replace(/\p{M}+/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(lead, "")
			.slice(0, 63)
			.replace(/[-_]+$/, "");
	}

}
