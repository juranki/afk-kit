/** The shared 100-page, 100-item bound for tracker evidence collection. */
export async function collectTrackerPages<T>(options: {
	readPage: (page: number) => Promise<unknown>;
	malformed: string;
	exhausted: string;
	checkAccumulation?: (items: T[]) => void;
}): Promise<T[]> {
	const all: T[] = [];
	for (let page = 1; page <= 100; page++) {
		const batch = await options.readPage(page);
		if (!Array.isArray(batch)) throw new Error(options.malformed);
		all.push(...batch);
		options.checkAccumulation?.(all);
		if (batch.length < 100) return all;
	}
	throw new Error(options.exhausted);
}
