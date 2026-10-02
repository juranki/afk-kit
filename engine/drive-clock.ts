/** Time seam scoped to the driver's Run deadline and interruption settlement. */
export interface DriveClock {
	/** Epoch milliseconds, comparable to the persisted Run started timestamp. */
	now(): number;
	/** Schedule a one-shot wait; never calls fire inline. Returns its canceller. */
	schedule(delayMs: number, fire: () => void): () => void;
}

export const realDriveClock: DriveClock = {
	now: () => Date.now(),
	schedule(delayMs, fire) {
		const timer = setTimeout(fire, delayMs);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};
