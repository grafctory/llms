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
import { afterEach, describe, expect, it, vi } from "vitest";
import * as connectors from "./index.js";
import { createOpenAI, embedding, json, text } from "./index.js";


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
