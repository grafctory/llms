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
 * Model usage tracing.
 *
 * Attributes model calls to the source of their cost, such as the job or team issuing them, and logs the tokens each
 * call consumes with its labels, so that spend can be traced to its source from the log and in provider billing reports.
 *
 * @module
 */

import { log } from "@metreeca/tape";


/**
 * Model request labels.
 *
 * Identify the source the {@link Usage} of a request is attributed to: each key names a label, such as `job` or
 * `team`, and its value identifies the source along that label, such as `events-loader` or `data`.
 *
 * The labels of a request are logged with its usage (see {@link charge}). Where the provider accepts them, they are
 * also attached to the request itself, so its cost is split by source in the provider billing reports as well.
 *
 * > [!NOTE]
 * >
 * > Each provider sets its own limits on keys, values and their number: model connectors bring labels within the
 * > limits of their provider before attaching them to a request, and log them as supplied.
 *
 * @example
 *
 * ```typescript
 * const labels: Labels = { job: "events-loader", team: "data" };
 * ```
 */
export type Labels = {

	readonly [label: string]: string

}

/**
 * Token usage of a model request.
 *
 * States what a request consumed in the terms all providers bill by, so usage logged for any of them reads alike. Usage
 * is attributed to its source by the {@link Labels} of the request, and logged together with them by {@link charge}.
 */
export type Usage = {

	/**
	 * The input tokens the request consumed, including those spent on tool use prompts.
	 */
	readonly input: number

	/**
	 * The output tokens the request consumed, including those spent on reasoning.
	 */
	readonly output: number

	/**
	 * The output tokens the request spent on reasoning alone.
	 */
	readonly reasoning: number

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Logs the token usage of a model request.
 *
 * Meant for model connectors, which log every request they issue. Each entry is filed under the model and states the
 * labels and tokens of the request, so a cost spike can be traced to its source from the log alone.
 *
 * @param model The id of the model the request was submitted to
 * @param labels The labels identifying the cost source of the request
 * @param usage The tokens the request consumed
 */
export function charge(model: string, labels: Labels, usage: Usage): void {

	log(["/", model]).info(
		"tokens {input} in · {output} out · {reasoning} reasoning · {labels}",
		{ model, labels, ...usage }
	);

}
