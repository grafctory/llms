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

import * as sdk from "openai";
import { type OpenAI, OpenAIError, RateLimitError, toFile } from "openai";
import { configureSync, resetSync, type Sink } from "@metreeca/tape";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as connectors from "./index.js";
import { createOpenAI, embedding, json, text } from "./index.js";


/**
 * Records the request limits advertised to the quotas the connector opens, as model and limit pairs.
 */
const limits = vi.hoisted(() => vi.fn<(model: string, limit: number) => void>());

vi.mock("@metreeca/llms/quotas", async importOriginal => {

	const actual = await importOriginal<typeof import("@metreeca/llms/quotas")>();

	return {

		...actual,

		createQuota: (model: string) => {

			const quota = actual.createQuota(model);

			return {
				...quota,
				limit: (value: number) => {
					limits(model, value);
					quota.limit(value);
				}
			};

		}

	};

});


/**
 * Creates a chat completion carrying a single choice.
 */
function completion({
	content = "prose",
	refusal = null,
	finish_reason = "stop"
}: {
	readonly content?: null | string
	readonly refusal?: null | string
	readonly finish_reason?: OpenAI.ChatCompletion.Choice["finish_reason"]
} = {}): OpenAI.ChatCompletion {
	return {
		id: "test",
		object: "chat.completion",
		created: 0,
		model: "test",
		choices: [{
			index: 0,
			finish_reason,
			logprobs: null,
			message: { role: "assistant", content, refusal }
		}]
	};
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("createOpenAI", () => {

	const usage = {
		prompt_tokens: 10,
		completion_tokens: 5,
		total_tokens: 15,
		completion_tokens_details: { reasoning_tokens: 3 }
	};

	/**
	 * Creates a response of the Responses API.
	 */
	function answer() {
		return {
			id: "test",
			object: "response",
			created_at: 0,
			model: "gpt-test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				total_tokens: 15,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 3 }
			}
		};
	}

	/**
	 * Creates an embedding response.
	 */
	function embedded(): OpenAI.CreateEmbeddingResponse {
		return {
			object: "list",
			model: "embedding-test",
			usage: { prompt_tokens: 10, total_tokens: 10 },
			data: [{ object: "embedding", index: 0, embedding: [1, 2] }]
		};
	}

	/**
	 * Creates a chat completion chunk carrying a content delta.
	 */
	function delta(content: string): OpenAI.ChatCompletionChunk {
		return {
			id: "test",
			object: "chat.completion.chunk",
			created: 0,
			model: "gpt-test",
			choices: [{ index: 0, delta: { content }, finish_reason: null }]
		};
	}

	/**
	 * Creates the chat completion chunk closing a stream that requested usage.
	 */
	function metered(): OpenAI.ChatCompletionChunk {
		return { id: "test", object: "chat.completion.chunk", created: 0, model: "gpt-test", choices: [], usage };
	}

	/**
	 * Creates a server-sent event stream carrying the given payloads.
	 */
	function events(...payloads: readonly unknown[]) {
		return new Response([...payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`), "data: [DONE]\n\n"].join(""), {
			headers: { "content-type": "text/event-stream" }
		});
	}

	/**
	 * Creates a transport answering the given responses in order, then a completion once they run out.
	 */
	function transport(...responses: readonly Response[]) {

		const queue = responses.values();

		return vi.fn<typeof fetch>(async () => queue.next().value ?? Response.json(completion()));

	}

	/**
	 * Creates a rejection over the rate quota.
	 */
	function rejection({ headers = {}, code = "rate_limit_exceeded" }: {
		readonly headers?: Record<string, string>
		readonly code?: string
	} = {}) {
		return Response.json({ error: { code } }, { status: 429, headers });
	}

	/**
	 * Creates a client issuing its requests through the given transport, with SDK retries disabled.
	 */
	function client(dispatch: typeof fetch) {
		return createOpenAI({ apiKey: "test", maxRetries: 0, fetch: dispatch });
	}

	/**
	 * Submits a chat completion request.
	 */
	function chat(dispatch: typeof fetch) {
		return client(dispatch).chat.completions.create({
			model: "gpt-test",
			messages: [{ role: "user", content: "query" }]
		});
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		limits.mockReset();
	});


	describe("credentials", () => {

		it("fails if no credentials are supplied or published by the environment", async () => {

			vi.stubEnv("OPENAI_API_KEY", "");

			expect(() => createOpenAI()).toThrow(OpenAIError);

		});

	});

	describe("quota recovery", () => {

		it("issues requests through the supplied transport", async () => {

			const dispatch = transport();

			expect(text(await chat(dispatch))).toBe("prose");
			expect(dispatch).toHaveBeenCalledTimes(1);

		});

		it.each<{ readonly label: string, readonly headers: Record<string, string> }>([
			{ label: "after the advertised delay in ms", headers: { "retry-after-ms": "10" } },
			{ label: "after the advertised delay in seconds", headers: { "retry-after": "0.01" } },
			{ label: "advertising no delay", headers: {} }
		])("resumes a request rejected $label", async ({ headers }) => {

			const dispatch = transport(rejection({ headers }));

			expect(text(await chat(dispatch))).toBe("prose");
			expect(dispatch).toHaveBeenCalledTimes(2);

		});

		it("resumes a multipart request naming a model", async () => {

			const dispatch = transport(
				rejection({ headers: { "retry-after-ms": "10" } }),
				Response.json({ text: "transcription" })
			);

			const transcription = await client(dispatch).audio.transcriptions.create({
				model: "whisper-test",
				file: await toFile(Buffer.from("audio"), "audio.mp3")
			});

			expect(transcription.text).toBe("transcription");
			expect(dispatch).toHaveBeenCalledTimes(2);

		});

		it("hands over a rejection reporting an exhausted account", async () => {

			const dispatch = transport(rejection({ code: "insufficient_quota", headers: { "retry-after-ms": "10" } }));

			await expect(chat(dispatch)).rejects.toThrow(RateLimitError);
			expect(dispatch).toHaveBeenCalledTimes(1);

		});

		it("hands over a rejection of a request naming no model", async () => {

			const dispatch = transport(rejection({ headers: { "retry-after-ms": "10" } }));

			await expect(client(dispatch).models.list()).rejects.toThrow(RateLimitError);
			expect(dispatch).toHaveBeenCalledTimes(1);

		});

	});

	describe("request limits", () => {

		const limited = { "x-ratelimit-limit-requests": "500" };

		it("paces a model at the request limit a response advertises", async () => {

			await chat(transport(Response.json(completion(), { headers: limited })));

			expect(limits).toHaveBeenCalledWith("gpt-test", 500);

		});

		it("paces a model at the request limit a rejection advertises", async () => {

			await chat(transport(rejection({ headers: { ...limited, "retry-after-ms": "10" } })));

			expect(limits).toHaveBeenCalledWith("gpt-test", 500);

		});

		it.each(["", "0", "-5", "unlimited"])("ignores an advertised request limit of '%s'", async limit => {

			await chat(transport(Response.json(completion(), { headers: { "x-ratelimit-limit-requests": limit } })));

			expect(limits).not.toHaveBeenCalledWith(expect.anything());

		});

	});

	describe("labels", () => {

		/**
		 * Lists the payloads of the requests issued through the given transport.
		 */
		function payloads(dispatch: ReturnType<typeof transport>) {
			return dispatch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
		}

		it("attaches labels as metadata to stored chat completion requests", async () => {

			const dispatch = transport();

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels: { job: "load" } }).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				store: true
			});

			expect(payloads(dispatch)).toEqual([expect.objectContaining({ metadata: { job: "load" } })]);

		});

		it("leaves chat completion requests not stored as they stand", async () => {

			const dispatch = transport();

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels: { job: "load" } }).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }]
			});

			expect(payloads(dispatch)).toEqual([expect.not.objectContaining({ metadata: expect.anything() })]);

		});

		it("attaches labels as metadata to response requests", async () => {

			const dispatch = transport(Response.json(answer()));

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels: { job: "load" } }).responses.create({
				model: "gpt-test",
				input: "query"
			});

			expect(payloads(dispatch)).toEqual([expect.objectContaining({ metadata: { job: "load" } })]);

		});

		it("computes labels on each request", async () => {

			const dispatch = transport();

			const labels = vi.fn<() => Record<string, string>>()
				.mockReturnValueOnce({ job: "one" })
				.mockReturnValueOnce({ job: "two" });

			const openai = createOpenAI({ apiKey: "test", fetch: dispatch, labels });

			await openai.chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				store: true
			});

			await openai.chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				store: true
			});

			expect(payloads(dispatch).map(({ metadata }) => metadata)).toEqual([{ job: "one" }, { job: "two" }]);

		});

		it("lets the metadata of the request win on shared keys", async () => {

			const dispatch = transport();

			await createOpenAI({
				apiKey: "test",
				fetch: dispatch,
				labels: { job: "load", team: "data" }
			}).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				metadata: { job: "probe" },
				store: true
			});

			expect(payloads(dispatch).map(({ metadata }) => metadata)).toEqual([{ job: "probe", team: "data" }]);

		});

		it("attaches client labels within the API limits as they stand", async () => {

			const dispatch = transport();

			await createOpenAI({
				apiKey: "test",
				fetch: dispatch,
				labels: { trace: "/events/coimbra-university" }
			}).responses.create({
				model: "gpt-test",
				input: "query"
			});

			expect(payloads(dispatch).map(({ metadata }) => metadata)).toEqual([{ trace: "/events/coimbra-university" }]);

		});

		it("clips client label keys to 64 characters and values to 512", async () => {

			const dispatch = transport();

			await createOpenAI({
				apiKey: "test",
				fetch: dispatch,
				labels: { ["k".repeat(100)]: "v".repeat(1000) }
			}).responses.create({
				model: "gpt-test",
				input: "query"
			});

			expect(payloads(dispatch).map(({ metadata }) => metadata)).toEqual([{ ["k".repeat(64)]: "v".repeat(512) }]);

		});

		it("keeps the first 16 client labels", async () => {

			const dispatch = transport();

			const labels = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, "v"]));

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels }).responses.create({
				model: "gpt-test",
				input: "query"
			});

			expect(payloads(dispatch).map(({ metadata }) => Object.keys(metadata))).toEqual([
				Array.from({ length: 16 }, (_, index) => `k${index}`)
			]);

		});

		it("clips the metadata of the request to the API limits", async () => {

			const dispatch = transport();

			await createOpenAI({ apiKey: "test", fetch: dispatch }).responses.create({
				model: "gpt-test",
				input: "query",
				metadata: { Pipe: "/Events/Coimbra-University", ["k".repeat(100)]: "v".repeat(1000) }
			});

			expect(payloads(dispatch).map(({ metadata }) => metadata)).toEqual([{
				Pipe: "/Events/Coimbra-University",
				["k".repeat(64)]: "v".repeat(512)
			}]);

		});

		it("keeps the metadata of the request ahead of the client labels within the 16 entry limit", async () => {

			const dispatch = transport();

			const labels = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`k${index}`, "v"]));
			const metadata = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`r${index}`, "v"]));

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels }).responses.create({
				model: "gpt-test",
				input: "query",
				metadata
			});

			expect(payloads(dispatch).map(({ metadata }) => Object.keys(metadata))).toEqual([[
				...Array.from({ length: 10 }, (_, index) => `r${index}`),
				...Array.from({ length: 6 }, (_, index) => `k${index}`)
			]]);

		});

		it("leaves requests to other endpoints without metadata", async () => {

			const dispatch = transport(Response.json(embedded()));

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels: { job: "load" } }).embeddings.create({
				model: "embedding-test",
				input: "query"
			});

			expect(payloads(dispatch)).toEqual([expect.not.objectContaining({ metadata: expect.anything() })]);

		});

	});

	describe("streamed usage", () => {

		it("requests usage on a streamed chat completion, withholding the chunk carrying it", async () => {

			const dispatch = transport(events(delta("pro"), delta("se"), metered()));

			const chunks = await client(dispatch).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				stream: true
			});

			expect((await Array.fromAsync(chunks)).map(({ choices }) => choices[0]?.delta.content)).toEqual(["pro", "se"]);

			expect(dispatch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).stream_options))
				.toEqual([{ include_usage: true }]);

		});

		it("hands over the chunk carrying usage to a streamed chat completion requesting it", async () => {

			const dispatch = transport(events(delta("prose"), metered()));

			const chunks = await client(dispatch).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				stream: true,
				stream_options: { include_usage: true }
			});

			expect((await Array.fromAsync(chunks)).map(({ usage }) => usage)).toEqual([undefined, usage]);

		});

	});

	describe("usage log", () => {

		const sink = vi.fn<Sink>();

		beforeEach(() => {
			configureSync({
				reset: true,
				sinks: { sink },
				loggers: [
					{ category: ["/"], lowestLevel: "info", sinks: ["sink"] },
					{ category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] }
				]
			});
		});

		afterEach(() => {
			resetSync();
			sink.mockReset();
		});

		/**
		 * Lists the usage logged so far, one entry per request.
		 */
		function usages() {
			return sink.mock.calls.map(([{ properties }]) => properties).filter(properties => "input" in properties);
		}

		it("logs the model, labels and token usage of a chat completion", async () => {

			const dispatch = transport(Response.json({ ...completion(), usage }));

			await createOpenAI({ apiKey: "test", fetch: dispatch, labels: { job: "load" } }).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				metadata: { team: "data" }
			});

			expect(usages()).toEqual([{
				model: "gpt-test",
				labels: { job: "load", team: "data" },
				input: 10,
				output: 5,
				reasoning: 3
			}]);

		});

		it("logs the labels as supplied, before normalisation", async () => {

			const dispatch = transport(Response.json({ ...completion(), usage }));

			await createOpenAI({
				apiKey: "test",
				fetch: dispatch,
				labels: { ["k".repeat(100)]: "/events/coimbra-university" }
			}).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				metadata: { Pipe: "v".repeat(1000) },
				store: true
			});

			expect(usages()).toEqual([expect.objectContaining({
				labels: { ["k".repeat(100)]: "/events/coimbra-university", Pipe: "v".repeat(1000) }
			})]);

		});

		it("logs the token usage of a response", async () => {

			const dispatch = transport(Response.json(answer()));

			await client(dispatch).responses.create({ model: "gpt-test", input: "query" });

			expect(usages()).toEqual([{ model: "gpt-test", labels: {}, input: 10, output: 5, reasoning: 3 }]);

		});

		it("logs the token usage of an embedding", async () => {

			const dispatch = transport(Response.json(embedded()));

			await client(dispatch).embeddings.create({ model: "embedding-test", input: "query" });

			expect(usages()).toEqual([{ model: "embedding-test", labels: {}, input: 10, output: 0, reasoning: 0 }]);

		});

		it("logs the token usage of a streamed chat completion", async () => {

			const dispatch = transport(events(delta("prose"), metered()));

			await Array.fromAsync(await client(dispatch).chat.completions.create({
				model: "gpt-test",
				messages: [{ role: "user", content: "query" }],
				stream: true
			}));

			expect(usages()).toEqual([{ model: "gpt-test", labels: {}, input: 10, output: 5, reasoning: 3 }]);

		});

		it("logs the token usage of a streamed response", async () => {

			const dispatch = transport(events({ type: "response.completed", sequence_number: 0, response: answer() }));

			await Array.fromAsync(await client(dispatch).responses.create({
				model: "gpt-test",
				input: "query",
				stream: true
			}));

			expect(usages()).toEqual([{ model: "gpt-test", labels: {}, input: 10, output: 5, reasoning: 3 }]);

		});

	});

});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("text", () => {

	it("extracts the trimmed output text of the first choice", async () => {

		expect(text(completion({ content: "  prose\n" }))).toBe("prose");

	});

	it("fails on a completion carrying no choice", async () => {

		expect(() => text({ ...completion(), choices: [] })).toThrow(Error);

	});

	it("fails on a refused generation", async () => {

		expect(() => text(completion({ content: null, refusal: "refused" }))).toThrow(Error);

	});

	it.each(["length", "content_filter"] as const)("fails on a generation stopped for <%s>", async finish_reason => {

		expect(() => text(completion({ finish_reason }))).toThrow(Error);

	});

	it.each([null, ""])("fails on a generation carrying output text <%j>", async content => {

		expect(() => text(completion({ content }))).toThrow(Error);

	});

});

describe("json", () => {

	it("parses the output text as JSON", async () => {

		expect(json(completion({ content: `{ "label": "text", "count": 1 }` }))).toEqual({ label: "text", count: 1 });

	});

	it("drops object members stated as null", async () => {

		expect(json(completion({ content: `{ "label": null, "venue": { "label": "venue", "city": null } }` })))
			.toStrictEqual({ venue: { label: "venue" } });

	});

	it("keeps null array items", async () => {

		expect(json(completion({ content: `{ "labels": [null, "text"] }` }))).toStrictEqual({ labels: [null, "text"] });

	});

	it("fails on a completion carrying no output text", async () => {

		expect(() => json(completion({ content: null }))).toThrow(Error);

	});

	it("fails on output text that is not well-formed JSON", async () => {

		expect(() => json(completion({ content: `{ "label": ` }))).toThrow(Error);

	});

});

describe("embedding", () => {

	function response(data: readonly number[][]): OpenAI.CreateEmbeddingResponse {
		return {
			object: "list",
			model: "test",
			usage: { prompt_tokens: 0, total_tokens: 0 },
			data: data.map((embedding, index) => ({ object: "embedding", index, embedding }))
		};
	}

	it("extracts the embedding of the first input", async () => {

		expect(embedding(response([[1, 2], [3, 4]]))).toEqual([1, 2]);

	});

	it("extracts an empty embedding from a response carrying none", async () => {

		expect(embedding(response([]))).toEqual([]);

	});

});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("openai", () => {

	it("re-exports the whole SDK surface", async () => {

		expect(connectors).toMatchObject(sdk);

	});

});
