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
 * OpenAI model connectors.
 *
 * Connects AI jobs to OpenAI models, ready to work alongside any other task in a pipeline. Long runs proceed reliably
 * to completion, and every result a job receives from a model can be trusted as complete. The cost of each request is
 * logged under the labels of the job issuing it, so any spike can be traced back to its source.
 *
 * Stands in for the OpenAI Node API Library, re-exporting its whole surface, default export included: import SDK values
 * and types from here rather than from `openai`, so they always match the client without a direct SDK dependency.
 *
 * @module index
 *
 * @see {@link https://platform.openai.com/docs OpenAI API documentation}
 * @see {@link https://platform.openai.com/docs/api-reference OpenAI API reference}
 * @see {@link https://github.com/openai/openai-node OpenAI Node API Library}
 */

import { charge, type Labels } from "@metreeca/llms/usage";
import { createQuota } from "@metreeca/llms/quotas";
import type { Vector } from "@metreeca/llms/vectors";
import { eager, error, isObject, isString, type Lazy, memo, type Value } from "@metreeca/core";
import { TooManyRequests } from "@metreeca/http";
import { report } from "@metreeca/tape";
import { type ClientOptions, OpenAI } from "openai";

export * from "openai";
export { default } from "openai";


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The error code the API reports when the account has no quota left to spend.
 *
 * @see {@link https://platform.openai.com/docs/guides/error-codes API error codes}
 */
const Exhausted = "insufficient_quota";



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * A rate-limited request awaiting a further attempt.
 *
 * Never escapes the request it was raised for: it is raised only where the throttle is known to recover from it, and
 * consumed by the recovery that resumes the request.
 */
class Limited extends Error {

	/**
	 * The delay the request is to be resumed after, in ms, or 0 to leave the pace to the throttle.
	 */
	readonly delay: number;

	/**
	 * Creates a rate-limited request marker.
	 *
	 * @param delay The delay the request is to be resumed after, in ms, or 0 to leave the pace to the throttle
	 */
	constructor(delay: number) {

		super(`exceeded rate quota with delay <${delay}> ms`);

		this.delay = delay;

	}

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates an OpenAI API client paced against the published rate quotas.
 *
 * The client exposes the full {@link OpenAI} surface, with overloads, streaming and response helpers unaltered. Every
 * request naming a model is paced by a per-model adaptive throttle, so a long run keeps within the published rate
 * quota instead of failing on the 429 errors the SDK neither paces nor recovers from.
 *
 * @param options The client options, as accepted by the {@link OpenAI} constructor; if omitted, the SDK defaults
 *                apply, reading the API key from the environment. A custom `fetch` is retained and
 *                issues every request, paced or not, so transport customisations keep applying
 * @param options.labels The labels identifying the cost source of the requests the client issues, either fixed or
 *                       computed on each request, so that they can name the job issuing it from the context it runs
 *                       in; merged with the `metadata` of the request, which wins on shared keys
 *
 * @returns A client sharing throttling and logging among all requests naming the same model. Models are told apart
 *          by their exact id, so variant spellings of a model are paced independently
 *
 * @throws {@link !Error Error} If `options` supplies no credentials and none is published by the environment, as
 * signalled by the SDK through an `OpenAIError`
 *
 * @remarks
 *
 * A client is meant to be configured once by the consumer binding it, so that credentials and endpoint are settled for
 * a whole execution rather than repeated by each job that draws on the same models.
 *
 * Quota control covers every request naming a model, whichever resource issues it and whatever the SDK version
 * offers. A request rejected over the rate quota is resumed after the `retry-after-ms` or `retry-after` delay the API
 * advertises, or at the pace the throttle settles on if no delay is advertised. A rejection reporting an exhausted
 * account is returned as it stands, as no delay recovers from it. Requests naming no model, such as listing files or
 * models, and requests whose payload cannot be sent twice, such as streamed uploads, are issued unpaced.
 *
 * Retrying is left to the SDK for everything but the rate quota, so `maxRetries` still governs recovery from network
 * failures and server errors exactly as it does on a client created directly through the SDK constructor.
 *
 * Every response to a request naming a model, streamed or not, is logged with its model, labels and token usage, one
 * entry per request, so a cost spike can be traced to the job causing it from the log alone: OpenAI billing is split
 * by project and API key alone, never by labels. Output tokens include those spent on reasoning, which are also stated
 * on their own. Usage is requested on streamed chat completions not asking for it, and the chunk carrying it is
 * withheld from the stream, so the caller receives the same chunks it would have received without the request.
 *
 * Labels are attached as `metadata` to response requests and to chat completion requests setting `store`, as the API
 * keeps metadata only on stored objects and the other endpoints accept none; other requests carry labels in the log
 * alone. The API accepts at most 16 entries, with keys of up to 64 characters and values of up to 512 characters. The
 * client labels, merged with the `metadata` of the request, are brought within these limits before they are attached,
 * dropping client labels first beyond 16 entries and clipping longer keys and values, and they are logged as supplied.
 *
 * > [!WARNING]
 * >
 * > A client authenticated with X.509 workload identity credentials is served by the SDK transport alone: its requests
 * > are neither paced nor logged, and carry no labels beyond the `metadata` each request states for itself.
 *
 * @see {@link https://platform.openai.com/docs/guides/rate-limits Rate limits}
 * @see {@link https://platform.openai.com/docs/guides/error-codes API error codes}
 */
export function createOpenAI({ labels = {}, ...options }: ClientOptions & {

	readonly labels?: Lazy<Labels>

} = {}) {

	const dispatch = options.fetch ?? fetch;

	/**
	 * Retrieves the rate quota shared by all requests to a model, opening it on first request.
	 *
	 * Quotas are memoised by model id exactly as submitted.
	 *
	 * @param model The target model name
	 *
	 * @returns The quota registered for `model`, retained for the lifetime of the client (see {@link memo})
	 */
	const quotas = memo(createQuota);


	return new OpenAI({ ...options, fetch: submit });


	/**
	 * Dispatches a request under the throttle of the model it targets.
	 *
	 * @param input The endpoint the request is addressed to
	 * @param init The request to dispatch
	 *
	 * @returns The response to `init`, resumed as many times as the rate quota requires
	 *
	 * @throws {@link !TypeError TypeError} If the request cannot be dispatched
	 */
	async function submit(input: string | URL | Request, init?: RequestInit): Promise<Response> {

		const model = target(init);

		if ( model === undefined ) { // no model to pace against

			return await dispatch(input, init);

		} else {

			const { tags, request, withhold } = label(input, init);

			return track(model, tags, withhold, await quotas(model)(async () => {

				const response = await dispatch(input, request);
				const delay = await limited(response);

				return delay === undefined ? response : error(new Limited(delay));

			}, error => error instanceof Limited ? error.delay : undefined));

		}

	}

	/**
	 * Labels a request with the client labels.
	 *
	 * The client labels are computed anew for each request, so that they can name the job issuing it.
	 *
	 * @param input The endpoint the request is addressed to
	 * @param init The request to label
	 *
	 * @returns The labels to log, merging the client labels with the request `metadata`, which wins on shared keys; the
	 *          request to dispatch, carrying those labels as `metadata` within the API limits (see {@link normalise}) on
	 *          response and stored chat completion requests; and whether usage was requested on behalf of the client,
	 *          in which case the chunk carrying it is withheld from a caller that never asked for it
	 */
	function label(input: string | URL | Request, init?: RequestInit): {

		readonly tags: Labels
		readonly request?: RequestInit
		readonly withhold: boolean

	} {

		const path = new URL(input instanceof Request ? input.url : input).pathname;
		const payload = isString(init?.body) ? decode(init.body) : undefined;
		const chat = path.endsWith("/chat/completions");
		const client = eager(labels);

		if ( !isObject(payload) || !(chat || path.endsWith("/responses")) ) {

			return { tags: client, request: init, withhold: false };

		} else {

			const metadata = strings(payload["metadata"]);

			// request metadata leads, so that the API entry limit drops client labels first, and wins on shared keys

			const tags = { ...metadata, ...client, ...metadata };
			const attached = normalise(tags);
			const options = isObject(payload["stream_options"]) ? payload["stream_options"] : {};

			// chat completions take metadata on stored completions alone, while responses are stored by default

			const attach = Object.keys(attached).length > 0 && (!chat || payload["store"] === true);
			const withhold = chat && payload["stream"] === true && options["include_usage"] !== true;

			return {

				tags, withhold, request: {
					...init, body: JSON.stringify({
						...payload,
						...(attach ? { metadata: attached } : {}),
						...(withhold ? { stream_options: { ...options, include_usage: true } } : {})
					})
				}

			};

		}

	}

	/**
	 * Logs the usage of a response.
	 *
	 * @param model The model the request was submitted to
	 * @param tags The labels the request was submitted with
	 * @param withhold Whether the chunk carrying usage is to be withheld from a streamed response
	 * @param response The response to the request
	 *
	 * @returns A response equivalent to `response`, relaying a streamed body chunk by chunk as it arrives
	 */
	async function track(model: string, tags: Labels, withhold: boolean, response: Response): Promise<Response> {

		const type = response.headers.get("content-type") ?? "";

		if ( !response.ok || response.body === null ) {

			return response;

		} else if ( type.includes("text/event-stream") ) {

			return new Response(response.body
				.pipeThrough(new TextDecoderStream())
				.pipeThrough(relay(withhold, usage => record(model, tags, usage)))
				.pipeThrough(new TextEncoderStream()), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers
			});

		} else if ( type.includes("application/json") ) {

			record(model, tags, decode(await response.clone().text()));

			return response;

		} else {

			return response;

		}

	}

	/**
	 * Logs the usage of a request.
	 *
	 * @param model The model the request was submitted to
	 * @param tags The labels the request was submitted with
	 * @param payload The response payload stating the usage of the request; nothing is logged if it states none
	 */
	function record(model: string, tags: Labels, payload: unknown) {

		const usage = consumed(payload);

		if ( usage !== undefined ) {
			charge(model, tags, usage);
		}

	}

	/**
	 * States the delay a request rejected over the rate quota is to be resumed after.
	 *
	 * @param response The response to recover from
	 *
	 * @returns The delay the request is to be resumed after, in ms, as advertised by the API, or 0 if it advertises
	 *          none, if `response` reports the rate quota exceeded; undefined if it reports anything else or an
	 *          account with no quota left to spend, leaving `response` to the SDK
	 */
	async function limited(response: Response): Promise<undefined | number> {

		if ( response.status !== TooManyRequests || await exhausted(response) ) {

			return undefined;

		} else {

			return delay(response.headers);

		}

	}

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Extracts the output text of a chat completion.
 *
 * @param completion The completion of a `chat.completions.create` request
 *
 * @returns The trimmed output text of the first choice of `completion`
 *
 * @throws {@link !Error Error} If `completion` carries no choice, if the model refused to generate, or if it stopped
 * before producing complete output text
 */
export function text(completion: OpenAI.ChatCompletion): string {

	const { finish_reason, message: { content, refusal } } = completion.choices[0] ?? error("missing completion choice");

	if ( refusal ) {

		throw new Error(`refused generation <${refusal}>`);

	} else if ( finish_reason === "length" || finish_reason === "content_filter" ) {

		throw new Error(`incomplete generation with reason <${finish_reason}>`);

	} else if ( !content ) {

		throw new Error("incomplete generation with no output text");

	} else {

		return content.trim();

	}

}

/**
 * Extracts the output text of a chat completion as a JSON payload.
 *
 * The payload is parsed from the output text produced under the requested response format, and typed as `T` without
 * further validation: callers needing guarantees on its shape must validate it themselves.
 *
 * A strict response format states an absent member as `null` instead of leaving it out. Object members stated as
 * `null` are therefore dropped, so that a payload generated under a strict schema conforms to the shape the schema was
 * converted from. `null` array items are kept.
 *
 * @typeParam T The expected shape of the JSON payload
 *
 * @param completion The completion of a `chat.completions.create` request carrying a JSON response format
 *
 * @returns The JSON payload parsed from the output text of `completion`
 *
 * @throws {@link !Error Error} If `completion` carries no output text (see {@link text}) or its text is not
 * well-formed JSON
 */
export function json<T extends Value = Value>(completion: OpenAI.ChatCompletion): T {

	try {

		return JSON.parse(text(completion), function (this: unknown, _key, value) {
			return value === null && !Array.isArray(this) ? undefined : value; // drop null members, keeping array items
		});

	} catch ( e ) {

		throw new Error(`malformed model response: ${report(e)}`);

	}

}

/**
 * Extracts the embedding of an OpenAI API response.
 *
 * @param response The response of an `embeddings.create` request
 *
 * @returns The {@link Vector} embedded for the first input of `response`, or an empty array if it carries none
 */
export function embedding(response: OpenAI.CreateEmbeddingResponse): Vector {

	return response.data[0]?.embedding ?? [];

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * States the model a request is addressed to.
 *
 * Only requests whose payload may be dispatched again name a model, so that a request resumed under the rate quota is
 * never one whose payload was consumed by the attempt that was rejected.
 *
 * @param init The request to inspect
 *
 * @returns The model named by the payload of `init`, or undefined if it names none or carries a payload that cannot
 *          be dispatched again
 */
function target(init?: RequestInit): undefined | string {

	const body = init?.body;

	if ( isString(body) ) {

		const payload = decode(body);

		return isObject(payload) && isString(payload["model"]) ? payload["model"] : undefined;

	} else if ( body instanceof FormData ) {

		const model = body.get("model");

		return isString(model) ? model : undefined;

	} else {

		return undefined;

	}

}

/**
 * States whether a rejection leaves the account with no quota to spend.
 *
 * @param response The rejection to inspect
 *
 * @returns True if `response` reports an exhausted account, which no delay recovers from; false otherwise
 */
async function exhausted(response: Response): Promise<boolean> {

	const payload = decode(await response.clone().text().catch(() => ""));

	return isObject(payload)
		&& isObject(payload["error"])
		&& payload["error"]["code"] === Exhausted;

}

/**
 * States the delay a rejection advertises.
 *
 * @param headers The headers of the rejection to inspect
 *
 * @returns The delay advertised by `headers`, in ms, or 0 if they advertise none, leaving the pace to the throttle
 *
 * @see {@link https://platform.openai.com/docs/guides/rate-limits Rate limits}
 */
function delay(headers: Headers): number {

	const ms = Number(headers.get("retry-after-ms"));
	const s = Number(headers.get("retry-after"));

	if ( Number.isFinite(ms) && ms > 0 ) {

		return Math.ceil(ms);

	} else if ( Number.isFinite(s) && s > 0 ) {

		return Math.ceil(s*1000);

	} else {

		return 0;

	}

}

/**
 * Relays a server-sent event stream, tracking the usage it states.
 *
 * @param withhold Whether the chunk carrying usage is to be withheld, as requested on behalf of the client
 * @param done The callback receiving the last payload stating usage, if any, once the stream ends; usage is stated
 *             by the closing event alone, so a stream cancelled before it has none to log
 *
 * @returns A stream relaying server-sent events as they arrive, withholding the usage chunk if `withhold` is set
 */
function relay(withhold: boolean, done: (payload: unknown) => void): TransformStream<string, string> {

	let pending = ""; // ;(let) an event split across chunks, carried over to the next one
	let usage: unknown; // ;(let) the last payload stating usage so far, logged once the stream ends

	return new TransformStream<string, string>({

		transform(text, controller) {

			const events = `${pending}${text}`.split(/\r?\n\r?\n/);

			pending = events.at(-1) ?? "";

			forward(events.slice(0, -1), controller);

		},

		flush(controller) {

			forward(pending.trim() ? [pending] : [], controller);

			done(usage);

		}

	});


	function forward(events: readonly string[], controller: TransformStreamDefaultController<string>) {

		const payloads = events.map(event => ({ event, payload: data(event) }));

		usage = payloads.reduce((last, { payload }) => consumed(payload) === undefined ? last : payload, usage);

		const relayed = payloads
			.filter(({ payload }) => !(withhold && metered(payload)))
			.map(({ event }) => `${event}\n\n`);

		if ( relayed.length > 0 ) {
			controller.enqueue(relayed.join(""));
		}

	}

}

/**
 * Extracts the payload of a server-sent event.
 *
 * @param event The event to inspect
 *
 * @returns The JSON value carried by the `data` fields of `event`, or undefined if they carry none
 */
function data(event: string): unknown {

	return decode(event
		.split(/\r?\n/)
		.filter(line => line.startsWith("data:"))
		.map(line => line.slice("data:".length).trimStart())
		.join("\n")
	);

}

/**
 * States whether a chat completion chunk carries usage alone, as sent when usage is requested on a stream.
 *
 * @param payload The chunk to inspect
 *
 * @returns True if `payload` carries usage and no choice; false otherwise
 */
function metered(payload: unknown): boolean {

	return isObject(payload)
		&& Array.isArray(payload["choices"]) && payload["choices"].length === 0
		&& isObject(payload["usage"]);

}

/**
 * States the token usage of a response.
 *
 * Covers chat completions, embeddings and responses, streamed or not.
 *
 * @param payload The response payload to inspect
 *
 * @returns The token usage stated by `payload`, output tokens including reasoning, or undefined if it states none
 */
function consumed(payload: unknown) {

	const usage = !isObject(payload) ? undefined
		: isObject(payload["usage"]) ? payload["usage"]
			: isObject(payload["response"]) && isObject(payload["response"]["usage"]) ? payload["response"]["usage"]
				: undefined;

	if ( usage === undefined ) {

		return undefined;

	} else {

		const details = isObject(usage["completion_tokens_details"]) ? usage["completion_tokens_details"]
			: isObject(usage["output_tokens_details"]) ? usage["output_tokens_details"]
				: {};

		return {
			input: count(usage["prompt_tokens"] ?? usage["input_tokens"]),
			output: count(usage["completion_tokens"] ?? usage["output_tokens"]),
			reasoning: count(details["reasoning_tokens"])
		};

	}


	function count(value: unknown): number {
		return typeof value === "number" ? value : 0;
	}

}

/**
 * Brings labels within the limits the API sets on request metadata.
 *
 * @param labels The labels to normalise
 *
 * @returns The first 16 entries of `labels`, with keys clipped to 64 characters and values to 512
 *
 * @see {@link https://platform.openai.com/docs/api-reference/responses/create#responses-create-metadata Metadata}
 */
function normalise(labels: Labels): Labels {

	return Object.fromEntries(Object.entries(labels)
		.slice(0, 16)
		.map(([key, value]) => [key.slice(0, 64), value.slice(0, 512)])
	);

}

/**
 * Extracts string labels from a request `metadata` value.
 *
 * @param value The value to inspect
 *
 * @returns The string-valued entries of `value`, or no label if it is not an object
 */
function strings(value: unknown): Labels {

	return isObject(value)
		? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1])))
		: {};

}

/**
 * Decodes a JSON payload.
 *
 * @param text The text to decode
 *
 * @returns The value `text` encodes, or undefined if it is not well-formed JSON
 */
function decode(text: string): unknown {

	try {

		return JSON.parse(text);

	} catch {

		return undefined;

	}

}
