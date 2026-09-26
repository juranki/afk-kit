#!/usr/bin/env bun
// PROTOTYPE probe: what does the confined bash tool return when the run is
// aborted mid-command? Decides whether the trace can be trusted on the
// wall-clock-cap path (ticket #45).
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { buildConfinedEnv, materializeConfinement } from "../../extensions/subagent/confinement.ts";

const material = materializeConfinement("/tmp/probe-confinement");
const tool = createBashTool("/tmp", {
	spawnHook: (ctx) => ({ ...ctx, env: buildConfinedEnv(ctx.env, material) }),
});

const controller = new AbortController();
setTimeout(() => controller.abort(), 4000);
const t0 = Date.now();
const result = await tool.execute(
	"probe-call-1",
	{ command: "sleep 90 && echo done", timeout: 120 },
	controller.signal,
	(update) => console.log(`update: ${JSON.stringify(update).slice(0, 160)}`),
);
console.log(`elapsed: ${Date.now() - t0}ms`);
console.log(`result: ${JSON.stringify(result).slice(0, 400)}`);

// second probe: same command WITHOUT model timeout, for contrast
{
	const c2 = new AbortController();
	setTimeout(() => c2.abort(), 4000);
	const t1 = Date.now();
	try {
		const r2 = await tool.execute("probe-call-2", { command: "sleep 90 && echo done" }, c2.signal, () => {});
		console.log(`[no-timeout] elapsed: ${Date.now() - t1}ms result: ${JSON.stringify(r2).slice(0, 200)}`);
	} catch (e) {
		console.log(`[no-timeout] elapsed: ${Date.now() - t1}ms threw: ${(e as Error).message.slice(0, 120)}`);
	}
}
