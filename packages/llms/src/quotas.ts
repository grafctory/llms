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
 * Model rate quotas.
 *
 * Lets a model connector keep concurrent requests to a model within its rate quota, retrying those the provider rejects
 * over it and logging each attempt under the model name, so a long run completes rather than failing on rate limits.
 * Where the provider advertises the request limit of a model, the pace follows it instead of probing it by rejections.
 *
 * @module
 */

import { assert, type Optional } from "@grafctory/core";
import { createThrottle, type Throttle } from "@grafctory/core/async";
import { log } from "@grafctory/tape";


/**
 * The smallest delay in ms a quota leaves between two requests before its model advertises a request limit.
 *
 * Set to the smallest delay the throttle can still back off from: delays are whole ms, so below 5 ms a 1.10 backoff
 * rounds back to the delay it started from and the throttle would keep its pace however many requests are rejected.
 */
const Floor = 10;

/**
 * The largest delay in ms a quota leaves between two requests, however low the limit its model advertises.
 */
const Ceiling = 60*1000;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Model rate quota.
 *
 * Submits requests to a single model, paced against an adaptive throttle shared by all of them, so that concurrent
 * consumers of the model keep within its rate quota. Attempts are logged under the model name.
 *
 * Until the provider advertises the request limit of the model, the pace is set by the throttle alone, slowing down on
 * rejections and speeding up on successes; once advertised, the limit caps how fast the throttle may go.
 */
export type Quota = {

	/**
	 * Submits a request to the model.
	 *
	 * @typeParam V The type of the value the request resolves to
	 *
	 * @param request The request to submit, issued anew on every attempt
	 * @param recover The recovery deciding whether a rejection is retried: returns the delay in ms the request is to
	 *                be retried after, 0 leaving the pace to the throttle, or undefined to give up with the rejection
	 *
	 * @returns The value `request` resolves to, once an attempt succeeds
	 *
	 * @throws The rejection of the last attempt, if `recover` gives up on it
	 */
	submit<V>(request: () => Promise<V>, recover: (error: unknown) => Optional<number>): Promise<V>

	/**
	 * Caps the pace of the model at the request limit the provider advertises for it.
	 *
	 * Meant to be called with whatever each response or rejection advertises, as often as the provider replies: requests
	 * already waiting keep the pace they were submitted at, so a change of limit takes effect from the next request on.
	 *
	 * @param limit The number of requests per minute the provider accepts for the model, or undefined if the provider
	 *              advertises none, leaving the pace as it stands until a later call states a limit
	 *
	 * @throws {@link !TypeError TypeError} If `limit` is neither undefined nor a positive finite number
	 */
	limit(limit: Optional<number>): void

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Opens the rate quota of a model.
 *
 * Meant for model connectors: a connector opens one quota per model and submits every request to that model through
 * it, so that concurrent jobs drawing on the same model are paced together rather than each at a pace of its own.
 *
 * @param model The id of the model the quota paces requests to
 *
 * @returns A new quota for `model`, pacing only the requests submitted through it
 */
export function createQuota(model: string): Quota {

	const logger = log(["/", model]);

	const pace = { floor: Floor, throttle: throttle(Floor) };


	return Object.freeze({
		submit,
		limit
	});


	/**
	 * Creates the throttle pacing requests to the model.
	 *
	 * @param floor The smallest delay in ms the throttle may leave between two requests
	 *
	 * @returns A new throttle with no requests submitted yet, never pacing faster than `floor`
	 */
	function throttle(floor: number): Throttle {

		return createThrottle({
			minimum: floor,
			maximum: Ceiling,
			buildup: 1.10,
			backoff: 1.10,
			recover: 0.95
		});

	}

	function submit<V>(request: () => Promise<V>, recover: (error: unknown) => Optional<number>): Promise<V> {

		return pace.throttle.retry(request, {

			recover,

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

	function limit(limit: Optional<number>): void {

		const $limit = assert(limit, limit => limit === undefined || Number.isFinite(limit) && limit > 0,
			`illegal request limit <${limit}>`
		);

		const floor = $limit === undefined ? pace.floor : Math.min(Math.ceil(60*1000/$limit), Ceiling);

		if ( floor !== pace.floor ) {
			Object.assign(pace, { floor, throttle: throttle(floor) });
		}

	}

}
