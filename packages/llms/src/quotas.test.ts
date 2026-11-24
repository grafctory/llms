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

import { configureSync, resetSync, type Sink } from "@grafctory/tape";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuota, type Quota } from "./quotas.js";


describe("createQuota", () => {

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
	 * A rejection the recovery under test retries.
	 */
	class Retryable extends Error {}

	/**
	 * Recovers {@link Retryable} rejections at the pace of the throttle, giving up on any other.
	 */
	function recover(error: unknown) {
		return error instanceof Retryable ? 0 : undefined;
	}

	describe("submitting requests", () => {

		it("resolves to the value of the request", async () => {

			expect(await createQuota("model").submit(async () => "value", recover)).toBe("value");

		});

		it("retries a rejection the recovery handles", async () => {

			const request = vi.fn<() => Promise<string>>()
				.mockRejectedValueOnce(new Retryable())
				.mockResolvedValueOnce("value");

			expect(await createQuota("model").submit(request, recover)).toBe("value");
			expect(request).toHaveBeenCalledTimes(2);

		});

		it("rejects with a rejection the recovery gives up on", async () => {

			const rejection = new Error("fatal");
			const request = vi.fn<() => Promise<string>>().mockRejectedValue(rejection);

			await expect(createQuota("model").submit(request, recover)).rejects.toBe(rejection);
			expect(request).toHaveBeenCalledTimes(1);

		});

		it("logs attempts under a category naming the model", async () => {

			await createQuota("model").submit(async () => "value", recover);

			expect(sink).toHaveBeenCalledWith(expect.objectContaining({ category: ["/", "model"] }));

		});

	});

	describe("pacing requests", () => {

		/**
		 * Submits the given number of requests in sequence through a quota.
		 *
		 * @returns The time elapsed in ms from the first submission to the last completion
		 */
		async function elapsed(quota: Quota, count: number) {

			const start = Date.now();

			await Array.from({ length: count }).reduce<Promise<unknown>>(
				previous => previous.then(() => quota.submit(async () => "value", recover)),
				Promise.resolve()
			);

			return Date.now()-start;

		}

		it("leaves the pace to the throttle until a limit is advertised", async () => {

			expect(await elapsed(createQuota("model"), 5)).toBeLessThan(250);

		});

		it("caps the pace at the advertised limit", async () => {

			const quota = createQuota("model");

			quota.limit(300); // one request every 200 ms

			expect(await elapsed(quota, 3)).toBeGreaterThanOrEqual(400);

		});

		it("follows a change of the advertised limit", async () => {

			const quota = createQuota("model");

			quota.limit(300);
			quota.limit(60*1000);

			expect(await elapsed(quota, 5)).toBeLessThan(250);

		});

		it("keeps the pace when no limit is advertised", async () => {

			const quota = createQuota("model");

			quota.limit(300);
			quota.limit(undefined);

			expect(await elapsed(quota, 3)).toBeGreaterThanOrEqual(400);

		});

		it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an advertised limit of %s", async limit => {

			expect(() => createQuota("model").limit(limit)).toThrow(TypeError);

		});

	});

});
