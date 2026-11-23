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

import { createGoogleAI, embedding, json, text as output } from "./index.js";
import {
	ApiError,
	type CallableTool,
	type ContentListUnion,
	EmbedContentResponse,
	FinishReason,
	type GenerateContentParameters,
	GenerateContentResponse,
	type GenerateContentResponseUsageMetadata,
	MediaModality,
	type Part,
	TrafficType,
	Type
} from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";


/**
 * Stands in for the request the SDK would submit to the Gemini API.
 */
const generate = vi.hoisted(() => vi.fn<(params: GenerateContentParameters) => Promise<GenerateContentResponse>>());

vi.mock("@google/genai", async importOriginal => {

	const actual = await importOriginal<typeof import("@google/genai")>();

	return {
		...actual, GoogleGenAI: class extends actual.GoogleGenAI {

			constructor(options: ConstructorParameters<typeof actual.GoogleGenAI>[0]) {
				super(options);
				Object.assign(this.models, { generateContent: generate });
			}

		}
	};

});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("createGoogleAI", () => {

	const converter = "gemini-2.5-flash-lite";

	const prose: Part = { text: "prose" };
	const call: Part = { functionCall: { name: "lookup", args: {} } };
	const result: Part = { functionResponse: { name: "lookup", response: {} } };

	const tool: CallableTool = {
		tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
		callTool: async () => [result]
	};

	/**
	 * Replaces the SDK request with a stub answering the converter with JSON and any other model with the given turns
	 * in order, then with prose once they run out; a turn stated as an error rejects its request. Each response carries
	 * the usage stated for it: per turn, or as `conversion`.
	 *
	 * @returns A function listing the requests submitted to a model
	 */
	function stub({ turns = [], conversion }: {

		readonly turns?: readonly (Error | {
			readonly parts?: readonly Part[]
			readonly usage?: GenerateContentResponseUsageMetadata
		})[]

		readonly conversion?: GenerateContentResponseUsageMetadata

	} = {}) {

		const queue = turns.values();

		generate.mockImplementation(async ({ model }) => {

			const turn = model === converter
				? { parts: [{ text: `{ "label": "converted" }` }], usage: conversion }
				: queue.next().value ?? { parts: [prose] };

			return turn instanceof Error ? Promise.reject(turn) : generated(turn);

		});

		return (model: string): readonly GenerateContentParameters[] => generate.mock.calls
			.map(([params]) => params)
			.filter(params => params.model === model);

	}

	/**
	 * Submits a content generation request through a new client.
	 */
	function submit(params: GenerateContentParameters) {
		return createGoogleAI({ apiKey: "test" }).models.generateContent(params);
	}

	afterEach(() => {
		generate.mockReset();
	});


	describe("requests without tools", () => {

		it("submits the request as it stands, response schema included", async () => {

			const requests = stub();

			const config = { responseMimeType: "application/json", responseJsonSchema: {} };

			const response = await submit({ model: "gemini-2.5-flash", contents: "query", config });

			expect(requests("gemini-2.5-flash")).toEqual([expect.objectContaining({ contents: "query", config })]);
			expect(requests(converter)).toEqual([]);
			expect(output(response)).toBe("prose");

		});

	});

	describe("function calling", () => {

		const query = { role: "user", parts: [{ text: "query" }] };

		it.each<{ readonly label: string, readonly contents: ContentListUnion }>([
			{ label: "a string", contents: "query" },
			{ label: "a part", contents: { text: "query" } },
			{ label: "a content", contents: query },
			{ label: "a list", contents: ["query"] }
		])("submits $label as the user turn opening the conversation", async ({ contents }) => {

			const requests = stub();

			await submit({ model: "gemini-3-flash", contents, config: { tools: [tool] } });

			expect(requests("gemini-3-flash")).toEqual([expect.objectContaining({ contents: [query] })]);

		});

		it("submits the results of callable tools on the next turn", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(requests("gemini-3-flash")[1]?.contents).toEqual([
				query,
				{ role: "model", parts: [call] },
				{ role: "user", parts: [result] }
			]);

			expect(output(response)).toBe("prose");

		});

		it("attaches the conversation leading to the final response", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.automaticFunctionCallingHistory).toEqual(requests("gemini-3-flash")[1]?.contents);

		});

		it("hands over the function calls of a request disabling automatic function calling", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({
				model: "gemini-3-flash",
				contents: "query",
				config: { tools: [tool], automaticFunctionCalling: { disable: true } }
			});

			expect(requests("gemini-3-flash")).toHaveLength(1);
			expect(response.functionCalls).toEqual([call.functionCall]);

		});

		it("fails once the turn limit runs out without a final response", async () => {

			const requests = stub({ turns: [{ parts: [call] }, { parts: [call] }, { parts: [call] }] });

			await expect(submit({
				model: "gemini-3-flash",
				contents: "query",
				config: { tools: [tool], automaticFunctionCalling: { maximumRemoteCalls: 2 } }
			})).rejects.toThrow(Error);

			expect(requests("gemini-3-flash")).toHaveLength(2);

		});

		it("fails on a response carrying no model content", async () => {

			stub({ turns: [{}] });

			await expect(submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } }))
				.rejects.toThrow(Error);

		});

		it("fails on a function call while no callable tool is declared", async () => {

			stub({ turns: [{ parts: [call] }] });

			await expect(submit({
				model: "gemini-3-flash",
				contents: "query",
				config: { tools: [{ functionDeclarations: [{ name: "lookup" }] }] }
			})).rejects.toThrow(Error);

		});

	});

	describe("structured output with tools", () => {

		const tools = [{ functionDeclarations: [] }];
		const responseJsonSchema = { type: "object", properties: { label: { type: "string" } } };

		const config = { tools, responseMimeType: "application/json", responseJsonSchema };

		it("submits a JSON Schema to models accepting it alongside tools", async () => {

			const requests = stub();

			const response = await submit({ model: "gemini-3-flash", contents: "query", config });

			expect(requests("gemini-3-flash").map(({ config }) => config)).toEqual([expect.objectContaining({
				responseMimeType: "application/json",
				responseJsonSchema
			})]);

			expect(requests(converter)).toEqual([]);
			expect(output(response)).toBe("prose");

		});

		it("converts the prose of models rejecting a JSON Schema alongside tools", async () => {

			const requests = stub();

			const response = await submit({ model: "gemini-2.5-flash", contents: "query", config });

			expect(requests("gemini-2.5-flash").map(({ config }) => config)).toEqual([expect.not.objectContaining({
				responseJsonSchema: expect.anything()
			})]);

			expect(requests(converter).map(({ config }) => config)).toEqual([expect.objectContaining({
				responseMimeType: "application/json",
				responseJsonSchema
			})]);

			expect(json(response)).toEqual({ label: "converted" });

		});

		it("converts the prose of models rejecting a legacy schema alongside tools", async () => {

			const requests = stub();

			const responseSchema = { type: Type.OBJECT, properties: { label: { type: Type.STRING } } };

			const response = await submit({
				model: "gemini-2.5-flash",
				contents: "query",
				config: { tools, responseMimeType: "application/json", responseSchema }
			});

			expect(requests(converter).map(({ config }) => config)).toEqual([expect.objectContaining({
				responseSchema
			})]);

			expect(json(response)).toEqual({ label: "converted" });

		});

		it("switches a model rejecting the schema to conversion for the lifetime of the client", async () => {

			const requests = stub({ turns: [new ApiError({ message: "schema rejected", status: 400 })] });

			const client = createGoogleAI({ apiKey: "test" });

			const rejected = await client.models.generateContent({ model: "gemini-3-flash", contents: "query", config });
			const following = await client.models.generateContent({ model: "gemini-3-flash", contents: "query", config });

			expect(requests("gemini-3-flash").map(({ config }) => config)).toEqual([
				expect.objectContaining({ responseJsonSchema }),
				expect.not.objectContaining({ responseJsonSchema: expect.anything() }),
				expect.not.objectContaining({ responseJsonSchema: expect.anything() })
			]);

			expect(json(rejected)).toEqual({ label: "converted" });
			expect(json(following)).toEqual({ label: "converted" });

		});

		it("fails on a bad request to a model already served without the schema", async () => {

			stub({ turns: [new ApiError({ message: "bad request", status: 400 })] });

			await expect(submit({ model: "gemini-2.5-flash", contents: "query", config }))
				.rejects.toThrow(ApiError);

		});

		it("fails converting a reply carrying no text", async () => {

			const requests = stub({ turns: [{ parts: [{ text: " " }] }] });

			await expect(submit({ model: "gemini-2.5-flash", contents: "query", config }))
				.rejects.toThrow(Error);

			expect(requests(converter)).toEqual([]);

		});

		it("hands over function calls unconverted", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({
				model: "gemini-2.5-flash",
				contents: "query",
				config: { ...config, automaticFunctionCalling: { disable: true } }
			});

			expect(requests(converter)).toEqual([]);
			expect(response.functionCalls).toEqual([call.functionCall]);

		});

		it("hands over the response as it stands if no schema is requested", async () => {

			const requests = stub();

			const response = await submit({ model: "gemini-2.5-flash", contents: "query", config: { tools } });

			expect(requests(converter)).toEqual([]);
			expect(output(response)).toBe("prose");

		});

	});

	describe("quota recovery", () => {

		/**
		 * Creates a rejection over the rate quota, advertising a retry delay if one is given.
		 */
		function exhausted(retryDelay?: string) {
			return Object.assign(new ApiError({ message: "quota exhausted", status: 429 }), {
				error: { details: retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : [] }
			});
		}

		it("resumes a request rejected over the quota after the advertised delay", async () => {

			const requests = stub({ turns: [exhausted("0s")] });

			const response = await submit({ model: "gemini-3-flash", contents: "query" });

			expect(requests("gemini-3-flash")).toHaveLength(2);
			expect(output(response)).toBe("prose");

		});

		it("fails on a quota rejection advertising no delay", async () => {

			const requests = stub({ turns: [exhausted()] });

			await expect(submit({ model: "gemini-3-flash", contents: "query" })).rejects.toThrow(ApiError);

			expect(requests("gemini-3-flash")).toHaveLength(1);

		});

	});

	describe("usage metadata", () => {

		it("hands over the usage of a single request as it stands", async () => {

			const usage = { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 };

			stub({ turns: [{ parts: [prose], usage }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata).toEqual(usage);

		});

		it("sums the token counts of every function calling turn", async () => {

			stub({
				turns: [{
					parts: [call],
					usage: {
						promptTokenCount: 10,
						candidatesTokenCount: 2,
						thoughtsTokenCount: 3,
						cachedContentTokenCount: 4,
						toolUsePromptTokenCount: 5,
						totalTokenCount: 15
					}
				}, {
					parts: [prose],
					usage: {
						promptTokenCount: 20,
						candidatesTokenCount: 6,
						thoughtsTokenCount: 7,
						cachedContentTokenCount: 8,
						toolUsePromptTokenCount: 9,
						totalTokenCount: 42
					}
				}]
			});

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata).toEqual({
				promptTokenCount: 30,
				candidatesTokenCount: 8,
				thoughtsTokenCount: 10,
				cachedContentTokenCount: 12,
				toolUsePromptTokenCount: 14,
				totalTokenCount: 57
			});

		});

		it("sums a token count stated by only some turns", async () => {

			stub({
				turns: [
					{ parts: [call], usage: { promptTokenCount: 10, thoughtsTokenCount: 3 } },
					{ parts: [prose], usage: { promptTokenCount: 20 } }
				]
			});

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata).toEqual({ promptTokenCount: 30, thoughtsTokenCount: 3 });

		});

		it("keeps the usage of the turns stating it", async () => {

			const usage = { promptTokenCount: 10, totalTokenCount: 10 };

			stub({ turns: [{ parts: [call], usage }, { parts: [prose] }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata).toEqual(usage);

		});

		it("adds the usage of the conversion request", async () => {

			stub({
				turns: [
					{ parts: [call], usage: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } },
					{ parts: [prose], usage: { promptTokenCount: 20, candidatesTokenCount: 2, totalTokenCount: 22 } }
				],
				conversion: { promptTokenCount: 30, candidatesTokenCount: 3, totalTokenCount: 33 }
			});

			const response = await submit({
				model: "gemini-2.5-flash",
				contents: "query",
				config: { tools: [tool], responseMimeType: "application/json", responseJsonSchema: {} }
			});

			expect(response.usageMetadata).toEqual({
				promptTokenCount: 60,
				candidatesTokenCount: 6,
				totalTokenCount: 66
			});

		});

		it.each([
			"promptTokensDetails",
			"candidatesTokensDetails",
			"cacheTokensDetails",
			"toolUsePromptTokensDetails"
		] as const)("sums the token counts of each modality in %s", async details => {

			stub({
				turns: [{
					parts: [call],
					usage: { [details]: [{ modality: MediaModality.TEXT, tokenCount: 10 }] }
				}, {
					parts: [prose],
					usage: {
						[details]: [
							{ modality: MediaModality.IMAGE, tokenCount: 5 },
							{ modality: MediaModality.TEXT, tokenCount: 20 }
						]
					}
				}]
			});

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata?.[details]).toHaveLength(2);
			expect(response.usageMetadata?.[details]).toEqual(expect.arrayContaining([
				{ modality: MediaModality.TEXT, tokenCount: 30 },
				{ modality: MediaModality.IMAGE, tokenCount: 5 }
			]));

		});

		it("states the initial prompt of the first request and the traffic type of the last", async () => {

			stub({
				turns: [
					{ parts: [call], usage: { initialPromptTokenCount: 10, trafficType: TrafficType.ON_DEMAND } },
					{
						parts: [prose],
						usage: { initialPromptTokenCount: 20, trafficType: TrafficType.PROVISIONED_THROUGHPUT }
					}
				]
			});

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata).toEqual({
				initialPromptTokenCount: 10,
				trafficType: TrafficType.PROVISIONED_THROUGHPUT
			});

		});

		it("leaves usage unstated if no request states it", async () => {

			stub({ turns: [{ parts: [call] }, { parts: [prose] }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.usageMetadata).toBeUndefined();

		});

	});

});

describe("text", () => {

	it("joins the output text of the parts generated for the caller", async () => {

		expect(output(generated({ parts: [{ text: " one " }, { text: "skipped", thought: true }, { text: "two" }] })))
			.toBe("one \n\ntwo");

	});

	it("fails on a generation carrying no output text, naming the reason it was withheld", async () => {

		expect(() => output(generated({ finishReason: FinishReason.RECITATION }))).toThrow(/RECITATION/);

	});

	it("fails on a response carrying no candidate", async () => {

		expect(() => output(Object.assign(new GenerateContentResponse(), { candidates: [] }))).toThrow(Error);

	});

});

describe("json", () => {

	it("parses the output text as a JSON payload", async () => {

		expect(json(generated({ parts: [{ text: `{ "label": "x" }` }] }))).toEqual({ label: "x" });

	});

	it("fails on a generation carrying no output text as empty rather than malformed", async () => {

		expect(() => json(generated({ finishReason: FinishReason.RECITATION }))).toThrow(/RECITATION/);

	});

	it("fails on output text that is not well-formed JSON", async () => {

		expect(() => json(generated({ parts: [{ text: `{ "label": ` }] }))).toThrow(Error);

	});

});

describe("embedding", () => {

	it("extracts the embedding of the first content", async () => {

		expect(embedding(Object.assign(new EmbedContentResponse(), {
			embeddings: [{ values: [1, 2] }, { values: [3, 4] }]
		}))).toEqual([1, 2]);

	});

	it("extracts an empty embedding from a response carrying none", async () => {

		expect(embedding(new EmbedContentResponse())).toEqual([]);

	});

});


/**
 * Creates a response carrying a single candidate, with model content only if parts are given.
 */
function generated({ parts, finishReason = FinishReason.STOP, usage }: {

	readonly parts?: readonly Part[]
	readonly finishReason?: FinishReason
	readonly usage?: GenerateContentResponseUsageMetadata

}): GenerateContentResponse {

	return Object.assign(new GenerateContentResponse(), {
		candidates: [{ finishReason, ...(parts ? { content: { role: "model", parts: [...parts] } } : {}) }],
		usageMetadata: usage
	});

}
