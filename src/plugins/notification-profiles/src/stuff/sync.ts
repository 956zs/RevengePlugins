// Shared with the Equicord build (956zs/Equicord-Plugin notificationProfiles/sync.ts).
// Keep both copies identical; tests live in that repo (tests/notificationProfiles.test.mts).

// The Focus journal, shared between devices through messages in a group DM
// that only you are in. The journal is written as compact text split into
// numbered chunks; the first chunk carries the total length and a checksum,
// so a missing or damaged chunk is detected and never used for a restore.
//
// A chunk message looks like: NPJ <journalId> r<revision> <index>/<count> <data>
// and the first data starts with: <length>:<checksum>:

import {
	type Change,
	type DmPrefs,
	FOCUS_DM,
	FOCUS_GUILD,
	type GuildPrefs,
	type Journal,
	type Status,
} from "./planner";

export const SYNC_CHANNEL_NAME = "通知設定檔同步";
/** Below Discord's 2000 character limit without Nitro, with room for the header */
export const CHUNK_DATA = 1900;
const CHUNK_PREFIX = "NPJ";

// ---------- compact journal text ----------

// Short keys for the stored fields; "next" is not stored, it is always the
// Focus value for each changed field
const GUILD_KEYS: Record<keyof GuildPrefs, string> = {
	muted: "m",
	mute_config: "c",
	mobile_push: "p",
	message_notifications: "n",
	suppress_everyone: "e",
	suppress_roles: "r",
};
const DM_KEYS: Record<keyof DmPrefs, string> = { muted: "m", mute_config: "c" };

const STATUS_CODE: Record<Status, string> = { pending: "P", done: "D", failed: "F" };
const CODE_STATUS: Record<string, Status> = { P: "pending", D: "done", F: "failed" };

function packPrev(prev: object, keys: Record<string, string>) {
	const out: Record<string, unknown> = {};
	for (const [long, short] of Object.entries(keys)) {
		if (long in prev) out[short] = (prev as any)[long];
	}
	return out;
}

function unpackPrev(packed: Record<string, unknown>, keys: Record<string, string>, focus: object) {
	const prev: Record<string, unknown> = {};
	const next: Record<string, unknown> = {};
	for (const [long, short] of Object.entries(keys)) {
		if (short in packed) {
			prev[long] = packed[short];
			next[long] = (focus as any)[long];
		}
	}
	return { prev, next };
}

/** Items with the same old values and status share one group, so the text is mostly ids */
function group<T extends object>(rec: Record<string, Change<T>>, keys: Record<string, string>) {
	const groups = new Map<string, string[]>();
	for (const [id, change] of Object.entries(rec)) {
		const key = STATUS_CODE[change.status] + JSON.stringify(packPrev(change.prev, keys));
		const ids = groups.get(key);
		if (ids) ids.push(id);
		else groups.set(key, [id]);
	}
	return [...groups].map(([key, ids]) => [key, ids]);
}

function ungroup<T>(
	groups: unknown,
	keys: Record<string, string>,
	focus: object,
): Record<string, Change<T>> {
	const out: Record<string, Change<T>> = {};
	if (!Array.isArray(groups)) throw new Error("bad journal groups");
	for (const entry of groups) {
		const [key, ids] = entry as [string, string[]];
		const status = CODE_STATUS[key[0]];
		if (!status || !Array.isArray(ids)) throw new Error("bad journal group");
		const { prev, next } = unpackPrev(JSON.parse(key.slice(1)), keys, focus);
		for (const id of ids) out[id] = { prev, next, status } as Change<T>;
	}
	return out;
}

export function encodeJournal(j: Journal): string {
	return JSON.stringify({
		v: 1,
		p: j.profile,
		g: group(j.guilds, GUILD_KEYS),
		c: group(j.channels, DM_KEYS),
	});
}

export function decodeJournal(text: string): Journal {
	const raw = JSON.parse(text);
	if (raw?.v !== 1 || (raw.p !== "focus" && raw.p !== "normal")) {
		throw new Error("unknown journal format");
	}
	return {
		profile: raw.p,
		guilds: ungroup<GuildPrefs>(raw.g, GUILD_KEYS, FOCUS_GUILD),
		channels: ungroup<DmPrefs>(raw.c, DM_KEYS, FOCUS_DM),
	};
}

// ---------- chunks ----------

/** FNV-1a, enough to notice a damaged or mixed-up chunk */
export function checksum(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

/**
 * Every write is a new revision: the new chunks are sent first, the older
 * revisions deleted after, so an interrupted write still leaves a complete one
 */
export function toChunks(journalId: string, revision: number, text: string): string[] {
	const body = `${text.length}:${checksum(text)}:${text}`;
	const parts: string[] = [];
	for (let i = 0; i < body.length; i += CHUNK_DATA) parts.push(body.slice(i, i + CHUNK_DATA));
	return parts.map((data, i) =>
		`${CHUNK_PREFIX} ${journalId} r${revision} ${i + 1}/${parts.length} ${data}`
	);
}

export interface ChunkMessage {
	id: string;
	content: string;
}

interface Parsed {
	revision: number;
	index: number;
	count: number;
	data: string;
	id: string;
}

function parseChunk(m: ChunkMessage, journalId: string): Parsed | null {
	const head = `${CHUNK_PREFIX} ${journalId} `;
	if (!m.content.startsWith(head)) return null;
	const r = /^r(\d+) (\d+)\/(\d+) /.exec(m.content.slice(head.length));
	if (!r) return null;
	return {
		revision: Number(r[1]),
		index: Number(r[2]),
		count: Number(r[3]),
		data: m.content.slice(head.length + r[0].length),
		id: m.id,
	};
}

function assemble(chunks: Parsed[]): string {
	const { count } = chunks[0];
	const parts = new Map<number, string>();
	for (const c of chunks) {
		if (c.count !== count) throw new Error("chunks from different writes");
		const seen = parts.get(c.index);
		if (seen != null && seen !== c.data) throw new Error("conflicting chunks");
		parts.set(c.index, c.data);
	}
	let body = "";
	for (let i = 1; i <= count; i++) {
		const part = parts.get(i);
		if (part == null) throw new Error(`chunk ${i}/${count} missing`);
		body += part;
	}
	const m = /^(\d+):([0-9a-z]+):/.exec(body);
	if (!m) throw new Error("bad journal header");
	const text = body.slice(m[0].length);
	if (text.length !== Number(m[1]) || checksum(text) !== m[2]) {
		throw new Error("journal checksum mismatch");
	}
	return text;
}

/**
 * The newest revision that is complete and passes the checksum. Throws when
 * none is, with the reason for the newest one.
 */
export function fromChunks(
	messages: ChunkMessage[],
	journalId: string,
): { revision: number; text: string } {
	const byRevision = new Map<number, Parsed[]>();
	for (const m of messages) {
		const c = parseChunk(m, journalId);
		if (!c) continue;
		const list = byRevision.get(c.revision);
		if (list) list.push(c);
		else byRevision.set(c.revision, [c]);
	}
	if (!byRevision.size) throw new Error("no journal found");
	let firstError: unknown;
	for (const revision of [...byRevision.keys()].sort((a, b) => b - a)) {
		try {
			return { revision, text: assemble(byRevision.get(revision)!) };
		} catch (e) {
			firstError ??= e;
		}
	}
	throw firstError;
}

/** Message ids of this journal's chunks, optionally only revisions older than `below` */
export function chunkMessageIds(messages: ChunkMessage[], journalId: string, below = Infinity) {
	return messages.map(m => parseChunk(m, journalId)).filter((c): c is Parsed =>
		!!c && c.revision < below
	).map(c => c.id);
}

/**
 * The revision number for the next write. Usually the time, so two devices
 * writing at once never share a number; always above what is there already,
 * even with a clock running behind.
 */
export function nextRevision(messages: ChunkMessage[], journalId: string, now: number) {
	let top = 0;
	for (const m of messages) top = Math.max(top, parseChunk(m, journalId)?.revision ?? 0);
	return Math.max(top + 1, now);
}

/** Message ids of chunks that belong to any journal other than `keep` */
export function otherChunkIds(messages: ChunkMessage[], keep?: string) {
	return messages.filter(m => {
		const id = new RegExp(`^${CHUNK_PREFIX} (\\S+) r\\d+ \\d+/\\d+ `).exec(m.content)?.[1];
		return id != null && id !== keep;
	}).map(m => m.id);
}

export const newJournalId = () => Math.random().toString(36).slice(2, 10);
