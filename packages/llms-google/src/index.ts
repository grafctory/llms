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
 * to completion, and every result a job receives from a model can be trusted as complete.
 *
 * Stands in for the Google GenAI SDK, whose whole surface it re-exports: import SDK values and types from here rather
 * than from `@google/genai`, so they always match the client and no direct dependency on the SDK is needed.
 *
 * @module index
 *
 * @see {@link https://ai.google.dev/gemini-api/docs Gemini API documentation}
 * @see {@link https://googleapis.github.io/js-genai/release_docs/index.html Google GenAI SDK}
 */

import type { Vector } from "@metreeca/llms";
import {
	ApiError,
	CallableTool,
	Content,
	ContentListUnion,
	EmbedContentResponse,
	GenerateContentResponse,
	GenerateContentResponseUsageMetadata,
	GoogleGenAI,
	GoogleGenAIOptions,
	ModalityTokenCount,
	Part
} from "@google/genai";
import { error, isString, memo, type Value } from "@metreeca/core";
import { createThrottle, type Throttle } from "@metreeca/core/async";
import { TooManyRequests } from "@metreeca/http";
import { log, Logger, report } from "@metreeca/tape";

export * from "@google/genai";


/**
 * The number of attempts a request is submitted for, the initial one included, before a transient rejection is handed
 * over to the throttle (see {@link createGoogleAI}).
 */
const attempts = 5;


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
 *                `httpOptions.retryOptions` is set, a request failing transiently is attempted up to 5 times in total
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
 *   failing on 429 errors. Other transient failures, such as an overloaded model, are retried as stated by `options`,
 *   so a run survives a spike in demand on the model rather than aborting on the first one.
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
 * @see {@link https://ai.google.dev/gemini-api/docs/function-calling Function calling}
 * @see {@link https://ai.google.dev/gemini-api/docs/structured-output Structured output}
 * @see {@link https://ai.google.dev/gemini-api/docs/rate-limits Rate limits}
 * @see {@link https://github.com/googleapis/js-genai/issues/727 js-genai#727}
 */
export function createGoogleAI(options: GoogleGenAIOptions = {}) {

	const ai = new GoogleGenAI({

		...options,

		httpOptions: {

			// the SDK retries a transient rejection only where retry options are stated, otherwise
			// failing the request outright: a spike in demand on the model would abort a whole run

			retryOptions: { attempts },

			...options.httpOptions

		}

	});

	/**
	 * Retrieves the request channel shared by all requests to a model, opening it on first request.
	 *
	 * Channels are memoised by model id exactly as supplied, so the bare and `models/`-prefixed forms of the same
	 * model are throttled and logged independently, each under a category naming the model alone rather than this
	 * module, so that a run reads as a list of models rather than of repeated module paths.
	 *
	 * @param model The target model name
	 *
	 * @returns The channel registered for `model`, retained for the lifetime of the client (see {@link memo})
	 */
	const channels = memo<string, {

		logger: Logger
		throttle: Throttle

	}>(model => ({

		logger: log(["/", model]),

		// !!! the floor is a magic 600 rpm: derive it from the rpm published for the model, that is as
		// !!! `60_000/rpm`, so that the pace is stated by the quota rather than guessed

		// !!! a floor states requests per minute only: the token and daily quotas are not a function of
		// !!! elapsed time and are left unguarded

		// !!! quotas are enforced per project, while channels are opened per model: models running
		// !!! concurrently overrun a shared quota, each pacing correctly on its own

		throttle: createThrottle({
			minimum: 100,
			maximum: 60*1000,
			buildup: 1.10,
			backoff: 1.10,
			recover: 0.95
		})

	}));


	return Object.assign(ai, { // patch to work around known issues

		models: Object.assign(ai.models, {

			generateContent: (generateContent =>

				async (...[{ config, ...params }, ...rest]: Parameters<typeof generateContent>) => {

					return config?.tools
						? await execute()
						: await submit(params.model, () => generateContent({ ...params, config }, ...rest));


					/**
					 * Resolves a request carrying tools, driving function calling under quota throttling.
					 *
					 * The SDK resolves function calls through an internal loop that neither throttles its requests
					 * nor recovers from quota exhaustion, so long tool sessions fail with unexpected 429 errors:
					 * function declarations count towards the token limit, every turn issues a further request, and
					 * tools such as Browser MCP or Google Search resubmit massive contexts on each one of them, as
					 * reported for other SDKs:
					 *
					 * - googleapis/python-genai#17: 429 errors with the Google Search tool
					 * - google/adk-python#1057: 1.5M tokens in ~20 requests with Browser MCP, which sends the
					 *   entire DOM as context
					 *
					 * Turns are driven by {@link afc} instead, one throttled request at a time (see {@link request}),
					 * and a requested response schema is submitted with every one of them. Requests that disable
					 * automatic function calling take the same throttled route, but are submitted once and handed
					 * over as they come, function calls included, leaving the caller to resolve them.
					 *
					 * @returns The final response of the function calling loop, or the single response to a request
					 *          that disables it
					 *
					 * @throws {@link !Error Error} If the function calling loop cannot be completed (see {@link afc})
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
						 * Normalises the request contents into a conversation history, then alternates throttled
						 * model requests (see {@link request}) with tool dispatch: the function calls requested by the
						 * model are submitted to every `CallableTool` declared in the request and the resulting
						 * parts are appended to the history for the next turn, until a response reports no call.
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

							return await submit(params.model, () => generateContent({
								...params,
								contents,

								config: {

									...config,

									// disable the SDK loop: it would resolve function calls without throttling,
									// leaving this loop with nothing but the final response

									automaticFunctionCalling: { disable: true }

								}

							}, ...rest));

						}

					}

				}

			)(ai.models.generateContent.bind(ai.models)),

			generateContentStream: throttled(ai.models.generateContentStream.bind(ai.models)),
			embedContent: throttled(ai.models.embedContent.bind(ai.models)),

			countTokens: throttled(ai.models.countTokens.bind(ai.models)),
			computeTokens: throttled(ai.models.computeTokens.bind(ai.models)),

			generateImages: throttled(ai.models.generateImages.bind(ai.models)),
			generateVideos: throttled(ai.models.generateVideos.bind(ai.models))

		})

	});


	/**
	 * Submits a request under the throttle of the model it targets.
	 *
	 * Requests to the same model are paced against a shared adaptive throttle, so that concurrent consumers of a model
	 * keep within its published rate quota, and a rejection reporting a `RetryInfo` delay is retried after the delay
	 * the API advertises rather than at a pace of the client's own.
	 *
	 * @param model The target model name, keying the channel the request is paced against (see {@link channels})
	 * @param request The request to submit
	 *
	 * @returns The value `request` resolves to
	 *
	 * @throws {ApiError} If the request fails for a reason the quota recovery doesn't handle
	 */
	function submit<V>(model: string, request: () => Promise<V>): Promise<V> {

		const { throttle, logger } = channels(model);

		return throttle.retry(request, {

			recover: quota,

			monitor: (attempt, attempts, elapsed) => {

				const count = attempts > 0 ? `${attempt+1}/${attempts}` : `${attempt+1}`;

				if ( elapsed === undefined ) {
					logger.error`request attempt ${count} aborted`;
				} else if ( attempt > 0 ) {
					logger.warning`request attempt ${count} rejected with delay ${elapsed} ms`;
				} else {
					logger.info`request attempt ${count} submitted with delay ${elapsed} ms`;
				}

			}

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

		if ( error instanceof ApiError && error.status === TooManyRequests ) {

			const delay = (error as ApiError & { // ;(cast) the SDK error type carries no quota details
				error?: { details?: readonly Record<string, unknown>[] }
			}).error?.details
				?.find(detail => `${detail["@type"]}`.includes("RetryInfo"))
				?.["retryDelay"];

			const match = `${delay}`.match(/^(\d+(?:\.\d+)?)s$/);

			return match ? Math.ceil(parseFloat(match[1])*1000) : undefined;

		} else {

			return undefined;

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
	 * @returns A method submitting the requests of `method` through {@link submit}
	 */
	function throttled<P extends { model: string }, V>(method: (params: P) => Promise<V>): (params: P) => Promise<V> {

		return params => submit(params.model, () => method(params));

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
