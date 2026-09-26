// PROTOTYPE probe: time `sleep N && echo done` under the confined env, spawn-like pi does.
import { spawn } from "node:child_process";
import { buildConfinedEnv, materializeConfinement } from "../../extensions/subagent/confinement.ts";

const material = materializeConfinement("/tmp/probe-confinement2");
const env = buildConfinedEnv(process.env, material);
console.error(`PATH=${env.PATH?.split(":")[0]}… GIT_CONFIG_GLOBAL=${env.GIT_CONFIG_GLOBAL}`);

for (const n of [3]) {
	const t0 = Date.now();
	await new Promise<void>((resolve) => {
		const child = spawn("/bin/bash", ["-c", `sleep ${n} && echo done`], { env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("close", (code) => {
			console.log(`sleep ${n}: exit=${code} out=${JSON.stringify(out)} elapsed=${Date.now() - t0}ms`);
			resolve();
		});
	});
}
