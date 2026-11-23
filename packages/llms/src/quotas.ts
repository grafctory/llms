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
 *
 * @module
 */

import type { Optional } from "@metreeca/core";
import { createThrottle } from "@metreeca/core/async";
import { log } from "@metreeca/tape";


/**
 * Model rate quota.
 *
 * Submits requests to a single model, paced against an adaptive throttle shared by all of them, so that concurrent
 * consumers of the model keep within its rate quota. Attempts are logged under the model name.
 *
 * @typeParam V The type of the value the request resolves to
 *
 * @param request The request to submit, issued anew on every attempt
 * @param recover The recovery deciding whether a rejection is retried: returns the delay in ms the request is to be
 *                retried after, 0 leaving the pace to the throttle, or undefined to give up with the rejection
 *
 * @returns The value `request` resolves to, once an attempt succeeds
 *
 * @throws The rejection of the last attempt, if `recover` gives up on it
 */
export type Quota = <V>(
	request: () => Promise<V>,
	recover: (error: unknown) => Optional<number>
) => Promise<V>


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

	const throttle = createThrottle({
		minimum: 100,
		maximum: 60*1000,
		buildup: 1.10,
		backoff: 1.10,
		recover: 0.95
	});

	return (request, recover) => throttle.retry(request, {

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
