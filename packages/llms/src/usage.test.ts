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
import { charge } from "./usage.js";


describe("charge", () => {

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

	it("logs the model, labels and token usage under a category naming the model", async () => {

		charge("model", { job: "test" }, { input: 1, output: 2, reasoning: 3 });

		expect(sink).toHaveBeenCalledWith(expect.objectContaining({
			category: ["/", "model"],
			level: "info",
			properties: { model: "model", labels: { job: "test" }, input: 1, output: 2, reasoning: 3 }
		}));

	});

});
