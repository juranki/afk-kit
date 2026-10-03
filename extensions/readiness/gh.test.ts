import { expect, test } from "bun:test";
import { cleanupWorld, makeWorld } from "../../engine/test-world.ts";
import { fetchReadinessInput, runGh } from "./gh.ts";

test("assessment cancellation terminates an in-flight tracker subprocess", async () => {
	const w = await makeWorld(84, "Readiness", [
		{ args: ["api", "slow"], json: [], delayMs: 1000 },
	]);
	try {
		const controller = new AbortController();
		const started = Date.now();
		const read = runGh(w.checkout)(["api", "slow"], controller.signal);
		setTimeout(() => controller.abort(), 20);
		await expect(read).rejects.toThrow("aborted");
		expect(Date.now() - started).toBeLessThan(500);
	} finally {
		cleanupWorld(w);
	}
});

test("native dependencies are complete even when the Issue view truncates edges", async () => {
	const w = await makeWorld(84, "Readiness", [
		{
			args: [
				"issue",
				"view",
				"84",
				"--json",
				"body,labels,blockedBy,title,url,author,state,number",
			],
			json: {
				body: "Request",
				labels: [],
				blockedBy: { nodes: [{ number: 83, state: "CLOSED" }], totalCount: 2 },
			},
		},
		{
			args: [
				"api",
				"repos/{owner}/{repo}/issues/84/dependencies/blocked_by?per_page=100&page=1",
			],
			json: [
				{ number: 83, state: "closed" },
				{ number: 82, state: "open" },
			],
		},
	]);
	try {
		expect((await fetchReadinessInput(84, w.seams.gh)).nativeBlockers).toEqual([
			{ number: 83, state: "CLOSED" },
			{ number: 82, state: "OPEN" },
		]);
	} finally {
		cleanupWorld(w);
	}
});

test("tracker collection captures non-template intent and native edges without source syntax checks", async () => {
	const w = await makeWorld(84, "Readiness", [
		{
			args: [
				"issue",
				"view",
				"84",
				"--json",
				"body,labels,blockedBy,title,url,author,state,number",
			],
			json: {
				body: "Please wait for #83, as settled in discussion.",
				labels: [{ name: "ready-for-agent" }],
				blockedBy: { nodes: [{ number: 83, state: "CLOSED" }] },
			},
		},
	]);
	try {
		const input = await fetchReadinessInput(84, w.seams.gh);
		expect(input.body).toBe("Please wait for #83, as settled in discussion.");
		expect(input.nativeBlockers).toEqual([{ number: 83, state: "CLOSED" }]);
		expect(w.argvLog()).toEqual([
			"issue view 84 --json body,labels,blockedBy,title,url,author,state,number",
		]);
	} finally {
		cleanupWorld(w);
	}
});
