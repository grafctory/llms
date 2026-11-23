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

import * as connectors from "./index.js";
import { createGoogleAI, embedding, json, text as output } from "./index.js";
import * as sdk from "@google/genai";
import {
	ApiError,
	type CallableTool,
	type ContentListUnion,
	type EmbedContentParameters,
	EmbedContentResponse,
	FinishReason,
	type GenerateContentParameters,
	GenerateContentResponse,
	type GenerateContentResponseUsageMetadata,
	type GoogleGenAIOptions,
	MediaModality,
	type Part,
	TrafficType,
	Type
} from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";


/**
 * Stand in for the options the SDK client is created with and for the requests it would submit to the Gemini API.
 */
const { construct, generate, embed } = vi.hoisted(() => ({
	construct: vi.fn<(options: GoogleGenAIOptions) => void>(),
	generate: vi.fn<(params: GenerateContentParameters) => Promise<GenerateContentResponse>>(),
	embed: vi.fn<(params: EmbedContentParameters) => Promise<EmbedContentResponse>>()
}));

vi.mock("@google/genai", async importOriginal => {

	const actual = await importOriginal<typeof import("@google/genai")>();

	return {
		...actual, GoogleGenAI: class extends actual.GoogleGenAI {

			constructor(options: GoogleGenAIOptions) {
				super(options);
				construct(options);
				Object.assign(this.models, { generateContent: generate, embedContent: embed });
			}

		}
	};

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


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("createGoogleAI", () => {

	const prose: Part = { text: "prose" };
	const call: Part = { functionCall: { name: "lookup", args: {} } };
	const result: Part = { functionResponse: { name: "lookup", response: {} } };

	const tool: CallableTool = {
		tool: async () => ({ functionDeclarations: [{ name: "lookup" }] }),
		callTool: async () => [result]
	};

	/**
	 * Replaces the SDK request with a stub answering the given turns in order, then prose once they run out; a turn
	 * stated as an error rejects its request. Each response carries the usage stated for its turn.
	 *
	 * @returns A function listing the requests submitted so far, whatever model they target
	 */
	function stub({ turns = [] }: {

		readonly turns?: readonly (Error | {
			readonly parts?: readonly Part[]
			readonly usage?: GenerateContentResponseUsageMetadata
		})[]

	} = {}) {

		const queue = turns.values();

		generate.mockImplementation(async () => {

			const turn = queue.next().value ?? { parts: [prose] };

			return turn instanceof Error ? Promise.reject(turn) : generated(turn);

		});

		return (): readonly GenerateContentParameters[] => generate.mock.calls.map(([params]) => params);

	}

	/**
	 * Submits a content generation request through a new client.
	 */
	function submit(params: GenerateContentParameters) {
		return createGoogleAI({ apiKey: "test" }).models.generateContent(params);
	}

	afterEach(() => {
		construct.mockReset();
		generate.mockReset();
		embed.mockReset();
	});


	describe("retry options", () => {

		it("attempts a transiently failing request up to 5 times by default", async () => {

			createGoogleAI({ apiKey: "test", httpOptions: { timeout: 1000 } });

			expect(construct).toHaveBeenCalledWith(expect.objectContaining({
				httpOptions: { timeout: 1000, retryOptions: { attempts: 5 } }
			}));

		});

		it("keeps the retry options stated by the caller", async () => {

			createGoogleAI({ apiKey: "test", httpOptions: { retryOptions: { attempts: 1 } } });

			expect(construct).toHaveBeenCalledWith(expect.objectContaining({
				httpOptions: { retryOptions: { attempts: 1 } }
			}));

		});

	});

	describe("requests without tools", () => {

		it("submits the request as it stands, response schema included", async () => {

			const requests = stub();

			const config = { responseMimeType: "application/json", responseJsonSchema: {} };

			const response = await submit({ model: "gemini-2.5-flash", contents: "query", config });

			expect(requests()).toEqual([expect.objectContaining({ model: "gemini-2.5-flash", contents: "query", config })]);
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

			expect(requests()).toEqual([expect.objectContaining({ contents: [query] })]);

		});

		it("submits the results of callable tools on the next turn", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(requests()[1]?.contents).toEqual([
				query,
				{ role: "model", parts: [call] },
				{ role: "user", parts: [result] }
			]);

			expect(output(response)).toBe("prose");

		});

		it("submits function calls to every callable tool, skipping bare declarations", async () => {

			const other: Part = { functionResponse: { name: "lookup", response: { other: true } } };

			const requests = stub({ turns: [{ parts: [call] }] });

			await submit({
				model: "gemini-3-flash",
				contents: "query",
				config: {
					tools: [tool, { functionDeclarations: [{ name: "lookup" }] }, { ...tool, callTool: async () => [other] }]
				}
			});

			expect(requests()[1]?.contents).toEqual([
				query,
				{ role: "model", parts: [call] },
				{ role: "user", parts: [result, other] }
			]);

		});

		it("submits every turn with the SDK function calling loop disabled", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(requests().map(({ config }) => config?.automaticFunctionCalling)).toEqual([
				{ disable: true },
				{ disable: true }
			]);

		});

		it("attaches the conversation leading to the final response", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(response.automaticFunctionCallingHistory).toEqual(requests()[1]?.contents);

		});

		it("hands over the function calls of a request disabling automatic function calling", async () => {

			const requests = stub({ turns: [{ parts: [call] }] });

			const response = await submit({
				model: "gemini-3-flash",
				contents: "query",
				config: { tools: [tool], automaticFunctionCalling: { disable: true } }
			});

			expect(requests()).toHaveLength(1);
			expect(response.functionCalls).toEqual([call.functionCall]);

		});

		it("fails once the turn limit runs out without a final response", async () => {

			const requests = stub({ turns: [{ parts: [call] }, { parts: [call] }, { parts: [call] }] });

			await expect(submit({
				model: "gemini-3-flash",
				contents: "query",
				config: { tools: [tool], automaticFunctionCalling: { maximumRemoteCalls: 2 } }
			})).rejects.toThrow(Error);

			expect(requests()).toHaveLength(2);

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

		it.each([
			"gemini-3-flash",
			"gemini-2.5-flash",
			"models/gemini-2.5-flash",
			"gemini-flash-latest",
			"tunedModels/sentiment-tuned"
		])("submits a JSON Schema to %s alone", async model => {

			const requests = stub({ turns: [{ parts: [call] }, { parts: [{ text: `{ "label": "structured" }` }] }] });

			const response = await submit({ model, contents: "query", config: { ...config, tools: [tool] } });

			expect(requests()).toEqual([
				expect.objectContaining({ model, config: expect.objectContaining({ responseJsonSchema }) }),
				expect.objectContaining({ model, config: expect.objectContaining({ responseJsonSchema }) })
			]);

			expect(json(response)).toEqual({ label: "structured" });

		});

		it("submits a legacy schema alongside tools", async () => {

			const requests = stub();

			const responseSchema = { type: Type.OBJECT, properties: { label: { type: Type.STRING } } };

			await submit({
				model: "gemini-2.5-flash",
				contents: "query",
				config: { tools, responseMimeType: "application/json", responseSchema }
			});

			expect(requests().map(({ config }) => config)).toEqual([expect.objectContaining({
				responseMimeType: "application/json",
				responseSchema
			})]);

		});

		it("fails on a rejected schema, leaving later requests to the same model unaffected", async () => {

			const requests = stub({ turns: [new ApiError({ message: "schema rejected", status: 400 })] });

			const client = createGoogleAI({ apiKey: "test" });

			await expect(client.models.generateContent({ model: "gemini-3-flash", contents: "query", config }))
				.rejects.toThrow(ApiError);

			await client.models.generateContent({ model: "gemini-3-flash", contents: "query", config });

			expect(requests().map(({ config }) => config)).toEqual([
				expect.objectContaining({ responseJsonSchema }),
				expect.objectContaining({ responseJsonSchema })
			]);

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

		it.each(["0s", "0.01s"])("resumes a request rejected over the quota after an advertised delay of %s", async delay => {

			const requests = stub({ turns: [exhausted(delay)] });

			const response = await submit({ model: "gemini-3-flash", contents: "query" });

			expect(requests()).toHaveLength(2);
			expect(output(response)).toBe("prose");

		});

		it("resumes a function calling turn rejected over the quota after the advertised delay", async () => {

			const requests = stub({ turns: [{ parts: [call] }, exhausted("0s")] });

			const response = await submit({ model: "gemini-3-flash", contents: "query", config: { tools: [tool] } });

			expect(requests()).toHaveLength(3);
			expect(output(response)).toBe("prose");

		});

		it("fails on a quota rejection advertising no delay", async () => {

			const requests = stub({ turns: [exhausted()] });

			await expect(submit({ model: "gemini-3-flash", contents: "query" })).rejects.toThrow(ApiError);

			expect(requests()).toHaveLength(1);

		});

		it("resumes a request of other model methods rejected over the quota", async () => {

			const values = [1, 2];

			embed
				.mockRejectedValueOnce(exhausted("0s"))
				.mockResolvedValue(Object.assign(new EmbedContentResponse(), { embeddings: [{ values }] }));

			const response = await createGoogleAI({ apiKey: "test" }).models.embedContent({
				model: "gemini-embedding-001",
				contents: "query"
			});

			expect(embed).toHaveBeenCalledTimes(2);
			expect(embedding(response)).toEqual(values);

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


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("text", () => {

	it("joins the output text of the parts generated for the caller", async () => {

		expect(output(generated({
			parts: [
				{ text: " one " },
				{ text: "skipped", thought: true },
				{ functionCall: { name: "lookup", args: {} } },
				{ text: "two" }
			]
		}))).toBe("one \n\ntwo");

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


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

describe("@google/genai", () => {

	it("re-exports the whole SDK surface", async () => {

		expect(connectors).toMatchObject(sdk);

	});

});
