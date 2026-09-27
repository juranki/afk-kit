/**
 * L1 transition tests for the pure Engine state machine (ticket afk-kit
 * #61, code-verify standard): deterministic decision logic, offline — no
 * git, no network, no stubs. The machine owns transitions and caps; every
 * side effect appears only as a command for the driver to interpret.
 */

import { describe, expect, test } from "bun:test";
import type { ClaimTicketOutcome } from "./claim.ts";
import {
	MAX_CYCLES,
	type MachineEvent,
	type MachineState,
	startState,
	transition,
} from "./machine.ts";
import type { CycleOutcome, ReviewOutcome } from "./ports.ts";
import type { CandidatePushOutcome, HandOffOutcome } from "./pr-ops.ts";

const CLAIMED: ClaimTicketOutcome = {
	status: "claimed",
	issue: 61,
	maintainer: "maintainer",
	slug: "drive-claim-through-approved",
	branch: "issue-61-drive-claim-through-approved",
	base: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	worktree: "/wt/afk-kit/issue-61-drive-claim-through-approved",
	text: "Claimed #61.",
};

const CLAIM_REFUSED: ClaimTicketOutcome = {
	status: "refused",
	issue: 61,
	text: "CLAIM_REFUSAL: #61 is already claimed by someone-else.",
};

const PR = { number: 99, url: "https://example.com/repo/pull/99" };

function bootstrapped(): MachineState {
	return transition(startState(), claimEvent(CLAIMED)).state;
}

function bootstrapEvent(outcome: BootstrapOutcome): MachineEvent {
	return { type: "bootstrap", outcome };
}

function cycleEvent(outcome: CycleOutcome): MachineEvent {
	return { type: "cycle", outcome };
}

function cycling(cycle = 1): MachineState {
	let state = transition(
		bootstrapped(),
		bootstrapEvent({
			status: "created",
			issue: 61,
			branch: CLAIMED.branch,
			pr: PR,
			text: "Bootstrapped.",
		}),
	).state;
	for (let n = 1; n < cycle; n++) {
		state = transition(
			state,
			cycleEvent({ status: "failed", cycle: n, reason: `cycle ${n} failed` }),
		).state;
	}
	if (state.name !== "cycle" || state.cycle !== cycle) {
		throw new Error(`fixture: expected cycle ${cycle}, got ${state.name}`);
	}
	return state;
}

/**
 * A verified candidate: the Implementer's facts agreed and Verify passed.
 * The cycle carries no approvals — approval belongs to the Review gate.
 */
const VERIFIED: CycleOutcome = {
	status: "verified",
	cycle: 1,
	verifyResults: [{ command: "bun test", ok: true }],
};

function publishing(cycle = 1): MachineState {
	const outcome: CycleOutcome = { ...VERIFIED, cycle };
	const { state } = transition(cycling(cycle), cycleEvent(outcome));
	if (state.name !== "publish" || state.cycle !== cycle) {
		throw new Error(`fixture: expected publish ${cycle}, got ${state.name}`);
	}
	return state;
}

function candidatePushEvent(outcome: CandidatePushOutcome): MachineEvent {
	return { type: "candidate-push", outcome };
}

const PUSHED: CandidatePushOutcome = {
	status: "pushed",
	issue: 61,
	branch: CLAIMED.branch,
	commits: 2,
	head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	text: "Pushed 2 candidate commits.",
};

const DUAL_APPROVAL: ReviewOutcome = {
	status: "approved",
	cycle: 1,
	approvals: [
		{ review: "standards", verdict: { verdict: "approve" } },
		{ review: "spec", verdict: { verdict: "approve" } },
	],
};

function reviewEvent(outcome: ReviewOutcome): MachineEvent {
	return { type: "review", outcome };
}

function reviewing(cycle = 1): MachineState {
	const { state } = transition(publishing(cycle), candidatePushEvent(PUSHED));
	if (state.name !== "review" || state.cycle !== cycle) {
		throw new Error(`fixture: expected review ${cycle}, got ${state.name}`);
	}
	return state;
}

function handoffEvent(outcome: HandOffOutcome): MachineEvent {
	return { type: "handoff", outcome };
}

function handingOff(): MachineState {
	const { state } = transition(reviewing(), reviewEvent(DUAL_APPROVAL));
	if (state.name !== "handoff") {
		throw new Error(`fixture: expected handoff, got ${state.name}`);
	}
	return state;
}

function claimEvent(outcome: ClaimTicketOutcome): MachineEvent {
	return { type: "claim", outcome };
}

describe("Engine state machine: Claim", () => {
	test("a claimed Claim bootstraps the draft PR", () => {
		const { state, effect } = transition(startState(), claimEvent(CLAIMED));

		expect(state.name).toBe("bootstrap");
		if (state.name === "bootstrap") {
			expect(state.claim.issue).toBe(61);
			expect(state.claim.branch).toBe(CLAIMED.branch);
			expect(state.claim.worktree).toBe(CLAIMED.worktree);
			expect(state.claim.base).toBe(CLAIMED.base);
		}
		expect(effect).toEqual({
			type: "bootstrap",
			input: {
				issue: 61,
				branch: CLAIMED.branch,
				worktree: CLAIMED.worktree,
			},
		});
	});

	test("a refused Claim is the refused terminal — no Claim survived", () => {
		const { state, effect } = transition(
			startState(),
			claimEvent(CLAIM_REFUSED),
		);

		expect(state).toEqual({
			name: "refused",
			reason: CLAIM_REFUSED.text,
		});
		expect(effect).toBeNull();
	});
});

describe("Engine state machine: terminals absorb", () => {
	test("a refused Run never acts again", () => {
		const refused = transition(startState(), claimEvent(CLAIM_REFUSED)).state;
		const again = transition(refused, claimEvent(CLAIMED));

		expect(again.state).toBe(refused);
		expect(again.effect).toBeNull();
	});
});

describe("Engine state machine: draft-PR bootstrap", () => {
	test("a created draft PR enters Cycle 1", () => {
		const { state, effect } = transition(
			bootstrapped(),
			bootstrapEvent({
				status: "created",
				issue: 61,
				branch: CLAIMED.branch,
				pr: PR,
				text: "Bootstrapped.",
			}),
		);

		expect(state).toEqual({
			name: "cycle",
			claim: {
				issue: 61,
				branch: CLAIMED.branch,
				base: CLAIMED.base,
				worktree: CLAIMED.worktree,
			},
			pr: PR,
			cycle: 1,
		});
		expect(effect).toEqual({ type: "cycle", cycle: 1 });
	});

	test("an already-open draft PR is the expected state — Cycle 1 begins", () => {
		const { state, effect } = transition(
			bootstrapped(),
			bootstrapEvent({
				status: "exists",
				issue: 61,
				branch: CLAIMED.branch,
				pr: PR,
				text: "exists",
			}),
		);

		expect(state.name).toBe("cycle");
		expect(effect).toEqual({ type: "cycle", cycle: 1 });
	});

	test("a refused bootstrap escalates — the Run is claimed", () => {
		const text = "PUBLISH_REFUSAL: bootstrap failed.\nCompensated: push.";
		const { state, effect } = transition(
			bootstrapped(),
			bootstrapEvent({
				status: "refused",
				issue: 61,
				branch: CLAIMED.branch,
				text,
			}),
		);

		expect(state).toEqual({
			name: "escalated",
			reason: text,
			stage: "bootstrap",
			cycle: null,
			facts: { branch: CLAIMED.branch, worktree: CLAIMED.worktree },
		});
		expect(effect).toEqual({ type: "escalate" });
	});
});

describe("Engine state machine: Implement–Review Cycles", () => {
	test("a verified cycle publishes the candidate commits", () => {
		const { state, effect } = transition(cycling(), cycleEvent(VERIFIED));

		expect(state.name).toBe("publish");
		if (state.name === "publish") {
			expect(state.verified.verifyResults).toEqual(VERIFIED.verifyResults);
		}
		expect(effect).toEqual({
			type: "candidate-push",
			input: { issue: 61, branch: CLAIMED.branch, worktree: CLAIMED.worktree },
		});
	});

	test("a failed cycle under the cap starts the next fresh cycle", () => {
		const { state, effect } = transition(
			cycling(2),
			cycleEvent({ status: "failed", cycle: 2, reason: "verify failed" }),
		);

		expect(state.name).toBe("cycle");
		if (state.name === "cycle") expect(state.cycle).toBe(3);
		expect(effect).toEqual({ type: "cycle", cycle: 3 });
	});

	test("Cycle 3 failing escalates — the cap is a code path", () => {
		const { state, effect } = transition(
			cycling(3),
			cycleEvent({ status: "failed", cycle: 3, reason: "verify failed again" }),
		);

		expect(state).toEqual({
			name: "escalated",
			reason: "verify failed again",
			stage: "cycle",
			cycle: 3,
			facts: { branch: CLAIMED.branch, worktree: CLAIMED.worktree, pr: PR },
		});
		expect(effect).toEqual({ type: "escalate" });
	});

	test("an escalate verdict ends the Run immediately", () => {
		const { state, effect } = transition(
			cycling(1),
			cycleEvent({
				status: "escalate",
				cycle: 1,
				reason: "unsafe continuation",
			}),
		);

		expect(state).toEqual({
			name: "escalated",
			reason: "unsafe continuation",
			stage: "cycle",
			cycle: 1,
			facts: { branch: CLAIMED.branch, worktree: CLAIMED.worktree, pr: PR },
		});
		expect(effect).toEqual({ type: "escalate" });
	});
});

describe("Engine state machine: publish and the Review gate", () => {
	test("a pushed candidate faces the parallel Reviews", () => {
		const { state, effect } = transition(
			publishing(),
			candidatePushEvent(PUSHED),
		);

		expect(state).toEqual({
			name: "review",
			claim: {
				issue: 61,
				branch: CLAIMED.branch,
				base: CLAIMED.base,
				worktree: CLAIMED.worktree,
			},
			pr: PR,
			cycle: 1,
			verified: { cycle: 1, verifyResults: VERIFIED.verifyResults },
		});
		expect(effect).toEqual({ type: "review", cycle: 1 });
	});

	test("an already-pushed candidate is the expected state — the Reviews still run", () => {
		const { state, effect } = transition(
			publishing(),
			candidatePushEvent({
				status: "current",
				issue: 61,
				branch: CLAIMED.branch,
				head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				text: "current",
			}),
		);

		expect(state.name).toBe("review");
		expect(effect?.type).toBe("review");
	});

	test("a refused candidate push escalates — side-effect uncertainty", () => {
		const text = "PUBLISH_REFUSAL: candidate push refused: non-fast-forward.";
		const { state, effect } = transition(
			publishing(),
			candidatePushEvent({
				status: "refused",
				issue: 61,
				branch: CLAIMED.branch,
				text,
			}),
		);

		expect(state.name).toBe("escalated");
		if (state.name === "escalated") {
			expect(state.stage).toBe("publish");
			expect(state.reason).toBe(text);
		}
		expect(effect).toEqual({ type: "escalate" });
	});

	test("dual approval is the only road to the handoff", () => {
		const { state, effect } = transition(
			reviewing(),
			reviewEvent(DUAL_APPROVAL),
		);

		expect(state.name).toBe("handoff");
		if (state.name === "handoff") {
			expect(state.approved).toEqual({
				cycle: 1,
				verifyResults: VERIFIED.verifyResults,
				approvals: DUAL_APPROVAL.approvals,
			});
		}
		if (effect?.type === "handoff") {
			expect(effect.input).toEqual({
				issue: 61,
				branch: CLAIMED.branch,
				worktree: CLAIMED.worktree,
				verifyResults: VERIFIED.verifyResults,
			});
		}
		expect(effect?.type).toBe("handoff");
	});

	test("review notes ride along to the handoff", () => {
		const { effect } = transition(
			reviewing(),
			reviewEvent({
				...DUAL_APPROVAL,
				reviewNotes: "Both Reviews left guidance for the Maintainer.",
			}),
		);

		if (effect?.type === "handoff") {
			expect(effect.input.reviewNotes).toBe(
				"Both Reviews left guidance for the Maintainer.",
			);
		}
		expect(effect?.type).toBe("handoff");
	});

	test("one requesting review fails the cycle while cycles remain", () => {
		const { state, effect } = transition(
			reviewing(1),
			reviewEvent({
				status: "changes-requested",
				cycle: 1,
				reason: "standards review requests changes: no tests",
			}),
		);

		expect(state.name).toBe("cycle");
		if (state.name === "cycle") expect(state.cycle).toBe(2);
		expect(effect).toEqual({ type: "cycle", cycle: 2 });
	});

	test("a Cycle 3 review requesting changes escalates — no Cycle 4 exists", () => {
		const { state, effect } = transition(
			reviewing(MAX_CYCLES),
			reviewEvent({
				status: "changes-requested",
				cycle: MAX_CYCLES,
				reason: "spec review requests changes: criterion unmet",
			}),
		);

		expect(state).toEqual({
			name: "escalated",
			reason: "spec review requests changes: criterion unmet",
			stage: "review",
			cycle: MAX_CYCLES,
			facts: { branch: CLAIMED.branch, worktree: CLAIMED.worktree, pr: PR },
		});
		expect(effect).toEqual({ type: "escalate" });
	});

	test("an escalate verdict ends the Run immediately from the gate", () => {
		const { state, effect } = transition(
			reviewing(),
			reviewEvent({
				status: "escalate",
				cycle: 1,
				reason: "standards review escalated: conflicting guidance",
			}),
		);

		expect(state).toEqual({
			name: "escalated",
			reason: "standards review escalated: conflicting guidance",
			stage: "review",
			cycle: 1,
			facts: { branch: CLAIMED.branch, worktree: CLAIMED.worktree, pr: PR },
		});
		expect(effect).toEqual({ type: "escalate" });
	});

	test("a handed-off PR is handed-over-to-maintainer — the Engine stops", () => {
		const { state, effect } = transition(
			handingOff(),
			handoffEvent({
				status: "handed-off",
				issue: 61,
				branch: CLAIMED.branch,
				pr: PR,
				text: "Handed off.",
			}),
		);

		expect(state).toEqual({
			name: "handed-over",
			facts: {
				branch: CLAIMED.branch,
				worktree: CLAIMED.worktree,
				pr: PR,
			},
			cycle: 1,
		});
		expect(effect).toBeNull();
	});

	test("a refused handoff escalates — the Escalation preserves the PR", () => {
		const text = "HANDOFF_REFUSAL: handoff failed at mark the PR ready.";
		const { state, effect } = transition(
			handingOff(),
			handoffEvent({
				status: "refused",
				issue: 61,
				branch: CLAIMED.branch,
				text,
			}),
		);

		expect(state.name).toBe("escalated");
		if (state.name === "escalated") {
			expect(state.stage).toBe("handoff");
			expect(state.facts.pr).toEqual(PR);
		}
		expect(effect).toEqual({ type: "escalate" });
	});
});

describe("Engine state machine: invariants", () => {
	test("a handed-over Run never waits for the Engine to act again", () => {
		const handedOver = transition(
			handingOff(),
			handoffEvent({
				status: "handed-off",
				issue: 61,
				branch: CLAIMED.branch,
				pr: PR,
				text: "Handed off.",
			}),
		).state;

		for (const event of [
			claimEvent(CLAIMED),
			cycleEvent({ status: "failed", cycle: 2, reason: "late failure" }),
			handoffEvent({
				status: "handed-off",
				issue: 61,
				branch: CLAIMED.branch,
				pr: PR,
				text: "Handed off again.",
			}),
		]) {
			const { state, effect } = transition(handedOver, event);
			expect(state).toBe(handedOver);
			expect(effect).toBeNull();
		}
	});

	test("no transition ever merges or touches the immutable brief", () => {
		const legal = new Set([
			"claim",
			"bootstrap",
			"cycle",
			"candidate-push",
			"review",
			"handoff",
			"escalate",
		]);
		const states: MachineState[] = [
			startState(),
			bootstrapped(),
			cycling(1),
			cycling(3),
			publishing(),
			reviewing(),
			handingOff(),
			{ name: "refused", reason: "x" },
			{
				name: "escalated",
				reason: "x",
				stage: "cycle",
				cycle: 1,
				facts: {},
			},
			{ name: "handed-over", facts: {}, cycle: 1 },
		];
		for (const state of states) {
			for (const event of [
				claimEvent(CLAIMED),
				claimEvent(CLAIM_REFUSED),
				bootstrapEvent({
					status: "created",
					issue: 61,
					branch: CLAIMED.branch,
					pr: PR,
					text: "b",
				}),
				cycleEvent(VERIFIED),
				cycleEvent({ status: "failed", cycle: 1, reason: "f" }),
				cycleEvent({ status: "escalate", cycle: 1, reason: "e" }),
				candidatePushEvent({
					status: "pushed",
					issue: 61,
					branch: CLAIMED.branch,
					commits: 1,
					head: "b",
					text: "p",
				}),
				reviewEvent(DUAL_APPROVAL),
				reviewEvent({
					status: "changes-requested",
					cycle: 1,
					reason: "r",
				}),
				reviewEvent({ status: "escalate", cycle: 1, reason: "e" }),
				handoffEvent({
					status: "handed-off",
					issue: 61,
					branch: CLAIMED.branch,
					pr: PR,
					text: "h",
				}),
			]) {
				const { effect } = transition(state, event);
				if (effect !== null) {
					expect(legal.has(effect.type)).toBe(true);
					expect(effect.type === "merge").toBe(false);
				}
			}
		}
	});
});

describe("Engine state machine: the cap is a code path", () => {
	test("at most three Implement–Review Cycles", () => {
		expect(MAX_CYCLES).toBe(3);
	});
});
