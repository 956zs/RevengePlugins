// Shared with the Equicord build (956zs/Equicord-Plugin notificationProfiles/engine.ts).
// Keep both copies identical; tests live in that repo (tests/notificationProfiles.test.mts).

// Sends a Focus journal to Discord and puts it back. Discord access is
// injected, so the retry and bookkeeping logic is tested with a fake API.
//
// Order of operations, so nothing is ever lost:
//   1. save the journal (every change starts "pending", with its old values)
//   2. send in batches, retrying 429 / 5xx / network errors
//   3. mark each item done or failed from the server's answer, save again
// Restoring removes an item from the journal only once it is confirmed back.

import {
	chunk,
	type DmPrefs,
	type GuildPrefs,
	type Journal,
	matches,
	planRestore,
} from "./planner";

export class HttpError extends Error {
	status: number | undefined;
	retryAfter: number | undefined;

	constructor(status: number | undefined, retryAfter?: number) {
		super(status ? `HTTP ${status}` : "network error");
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

export interface Deps {
	/** PATCH several guilds at once; resolves with the response body */
	patchGuilds(settings: Record<string, Partial<GuildPrefs>>): Promise<unknown>;
	/** PATCH DM channel overrides; resolves with the response body */
	patchDms(overrides: Record<string, Partial<DmPrefs>>): Promise<unknown>;
	currentGuild(id: string): GuildPrefs | null;
	currentDm(id: string): DmPrefs | null;
	save(journal: Journal): Promise<void>;
	sleep(ms: number): Promise<void>;
}

export const GUILD_BATCH = 25;
export const DM_BATCH = 50;
export const ATTEMPTS = 4;

async function withRetry<T>(fn: () => Promise<T>, deps: Deps): Promise<T> {
	for (let attempt = 0;; attempt++) {
		try {
			return await fn();
		} catch (e) {
			const status = (e as HttpError)?.status;
			const retryable = status === undefined || status === 429 || status >= 500;
			if (!retryable || attempt >= ATTEMPTS - 1) throw e;
			const after = (e as HttpError).retryAfter;
			await deps.sleep(status === 429 && after != null ? after * 1000 + 250 : 1000 * 2 ** attempt);
		}
	}
}

/** Ids the response says did not end up as wanted; empty when the body has no per-item data */
function rejectedGuilds(body: unknown, want: Record<string, Partial<GuildPrefs>>): Set<string> {
	const bad = new Set<string>();
	if (!Array.isArray(body)) return bad;
	const byId = new Map(
		body.filter(g => g && typeof g === "object").map((g: any) => [String(g.guild_id), g]),
	);
	for (const [id, fields] of Object.entries(want)) {
		const got = byId.get(id);
		if (got && !matches(got, fields)) bad.add(id);
	}
	return bad;
}

function rejectedDms(body: unknown, want: Record<string, Partial<DmPrefs>>): Set<string> {
	const bad = new Set<string>();
	const raw = (body as any)?.channel_overrides;
	if (!raw) return bad;
	const list: any[] = Array.isArray(raw)
		? raw
		: Object.entries(raw).map(([channel_id, v]) => ({ channel_id, ...(v as object) }));
	const byId = new Map(list.map(o => [String(o.channel_id), o]));
	for (const [id, fields] of Object.entries(want)) {
		const got = byId.get(id);
		if (got && !matches(got, fields)) bad.add(id);
	}
	return bad;
}

async function sendAll<T>(
	items: Record<string, Partial<T>>,
	size: number,
	send: (batch: Record<string, Partial<T>>) => Promise<unknown>,
	rejected: (body: unknown, batch: Record<string, Partial<T>>) => Set<string>,
	deps: Deps,
) {
	const ok: string[] = [];
	const failed: string[] = [];
	for (const ids of chunk(Object.keys(items), size)) {
		const batch = Object.fromEntries(ids.map(id => [id, items[id]]));
		try {
			const body = await withRetry(() => send(batch), deps);
			const bad = rejected(body, batch);
			for (const id of ids) (bad.has(id) ? failed : ok).push(id);
		} catch {
			failed.push(...ids);
		}
	}
	return { ok, failed };
}

export interface Result {
	ok: string[];
	failed: string[];
}

/** Applies every not-yet-done change in the journal */
export async function applyJournal(
	journal: Journal,
	deps: Deps,
): Promise<{ guilds: Result; channels: Result }> {
	await deps.save(journal);

	const pick = <T>(rec: Record<string, { next: Partial<T>; status: string }>) =>
		Object.fromEntries(
			Object.entries(rec).filter(([, c]) => c.status !== "done").map(([id, c]) => [id, c.next]),
		);

	const guilds = await sendAll(
		pick(journal.guilds),
		GUILD_BATCH,
		deps.patchGuilds,
		rejectedGuilds,
		deps,
	);
	const channels = await sendAll(
		pick(journal.channels),
		DM_BATCH,
		deps.patchDms,
		rejectedDms,
		deps,
	);

	for (const id of guilds.ok) journal.guilds[id].status = "done";
	for (const id of guilds.failed) journal.guilds[id].status = "failed";
	for (const id of channels.ok) journal.channels[id].status = "done";
	for (const id of channels.failed) journal.channels[id].status = "failed";
	await deps.save(journal);
	return { guilds, channels };
}

/**
 * Puts back what Focus changed. Items are dropped from the journal once they
 * are back (or were changed by hand meanwhile); failures stay for a retry.
 */
export async function restoreJournal(
	journal: Journal,
	deps: Deps,
): Promise<{ guilds: Result; channels: Result }> {
	const plan = planRestore(journal, deps.currentGuild, deps.currentDm);

	// Nothing left to put back for these: drop them
	for (const id of Object.keys(journal.guilds)) if (!(id in plan.guilds)) delete journal.guilds[id];
	for (const id of Object.keys(journal.channels)) {
		if (!(id in plan.channels)) delete journal.channels[id];
	}
	await deps.save(journal);

	const guilds = await sendAll(plan.guilds, GUILD_BATCH, deps.patchGuilds, rejectedGuilds, deps);
	const channels = await sendAll(plan.channels, DM_BATCH, deps.patchDms, rejectedDms, deps);

	for (const id of guilds.ok) delete journal.guilds[id];
	for (const id of channels.ok) delete journal.channels[id];
	if (!Object.keys(journal.guilds).length && !Object.keys(journal.channels).length) {
		journal.profile = "normal";
	}
	await deps.save(journal);
	return { guilds, channels };
}
