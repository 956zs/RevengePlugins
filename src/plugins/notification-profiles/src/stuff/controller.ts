// Shared with the Equicord build (956zs/Equicord-Plugin notificationProfiles/controller.ts).
// Keep both copies identical; tests live in that repo (tests/notificationProfiles.test.mts).

// Turning Focus on and off, shared by the desktop and phone builds. All
// Discord access goes through Platform, so the whole flow (including two
// devices taking turns) is tested with fakes.
//
// Where things live:
//   - the flag (private note on your own account): which device turned
//     Focus on, the sync channel and the journal id
//   - the journal (chunked messages in a group DM with only you): old values
//     of everything Focus changed, so any device can restore
//   - a local copy of the journal on the device that turned Focus on, used
//     when the shared one cannot be read
//
// Restoring only puts back fields that still hold the Focus value, so using
// an outdated journal never undoes anything: at worst it finds nothing to do.

import { applyJournal, type Deps, restoreJournal, type Result, withRetry } from "./engine";
import { canEnter, canLeave, encodeFlag, type Flag, isShared, parseFlag } from "./flag";
import {
	type DmInfo,
	emptyJournal,
	type GuildPrefs,
	isKept,
	type Journal,
	matches,
	planFocus,
	planRestore,
} from "./planner";
import {
	type ChunkMessage,
	chunkMessageIds,
	decodeJournal,
	encodeJournal,
	fromChunks,
	newJournalId,
	nextRevision,
	otherChunkIds,
	toChunks,
} from "./sync";

export interface LocalState {
	journal: Journal;
	/** Id of the shared journal this local copy belongs to */
	journalId?: string;
}

export interface Options {
	whitelist: ReadonlySet<string>;
	excluded: ReadonlySet<string>;
	muteServers: boolean;
	muteGroupDMs: boolean;
}

export interface Platform {
	deviceId: string;
	deviceLabel: string;
	/** Notification settings access for the engine (its save hook is added here) */
	deps: Omit<Deps, "save">;
	guildIds(): string[];
	/** DMs and group DMs, without the sync channel */
	privateChannels(): DmInfo[];
	options(): Options;
	/** The note text, null when there is none; throws when it cannot be read */
	readNote(): Promise<string | null>;
	writeNote(text: string): Promise<void>;
	/** Finds or creates (and mutes) the group DM with only you */
	syncChannel(): Promise<string>;
	/** The newest messages; these throw HttpError so they can be retried */
	listMessages(channelId: string): Promise<ChunkMessage[]>;
	sendMessage(channelId: string, content: string): Promise<void>;
	deleteMessage(channelId: string, messageId: string): Promise<void>;
	loadLocal(): LocalState;
	saveLocal(state: LocalState): Promise<void>;
	now(): number;
}

type Results = { guilds: Result; channels: Result };

export type Outcome =
	/** syncError: the changes went through but the shared journal could not be updated */
	| { kind: "applied"; result: Results; syncError?: string }
	| { kind: "restored"; result: Results; complete: boolean; syncError?: string }
	| { kind: "already-normal" }
	| { kind: "other-device"; flag: Flag }
	| { kind: "foreign-note" }
	| { kind: "stale-stores" }
	| { kind: "journal-unreadable"; error: string }
	/** An earlier Focus on this device still has settings to put back */
	| { kind: "unrestored" };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const message = (e: unknown) => String((e as Error)?.message ?? e);

// ---------- shared journal in the sync channel ----------

/** Sends a new revision, then removes the older ones */
async function writeShared(p: Platform, channel: string, journalId: string, journal: Journal) {
	const before = await withRetry(() => p.listMessages(channel), p.deps);
	const revision = nextRevision(before, journalId, p.now());
	for (const chunk of toChunks(journalId, revision, encodeJournal(journal))) {
		await withRetry(() => p.sendMessage(channel, chunk), p.deps);
	}
	for (const id of chunkMessageIds(before, journalId, revision)) {
		await withRetry(() => p.deleteMessage(channel, id), p.deps).catch(() => {});
	}
}

async function readShared(p: Platform, channel: string, journalId: string): Promise<Journal> {
	const messages = await withRetry(() => p.listMessages(channel), p.deps);
	return decodeJournal(fromChunks(messages, journalId).text);
}

/** Removes the chunks of every journal except `keep`; failures only leave clutter */
async function cleanShared(p: Platform, channel: string, keep?: string) {
	const messages = await withRetry(() => p.listMessages(channel), p.deps);
	for (const id of otherChunkIds(messages, keep)) {
		await withRetry(() => p.deleteMessage(channel, id), p.deps).catch(() => {});
	}
}

// ---------- helpers ----------

/** Engine access that keeps this device's copy up to date, or leaves it alone */
function engineDeps(p: Platform, local: { journalId?: string } | null): Deps {
	return {
		...p.deps,
		save: local
			? j => p.saveLocal({ journal: clone(j), journalId: local.journalId })
			: async () => {},
	};
}

function plan(p: Platform): Journal {
	const o = p.options();
	const guilds: Record<string, GuildPrefs> = {};
	for (const id of p.guildIds()) {
		const cur = p.deps.currentGuild(id);
		if (cur) guilds[id] = cur;
	}
	return planFocus({
		guilds,
		dms: p.privateChannels().flatMap(info => {
			const prefs = p.deps.currentDm(info.id);
			return prefs ? [{ info, prefs }] : [];
		}),
		whitelist: o.whitelist,
		excludedGuilds: o.excluded,
		muteServers: o.muteServers,
		muteGroupDMs: o.muteGroupDMs,
	});
}

/** Does anything in the journal still hold the Focus value? */
function hasLeftovers(p: Platform, j: Journal) {
	const r = planRestore(j, p.deps.currentGuild, p.deps.currentDm);
	return Object.keys(r.guilds).length + Object.keys(r.channels).length > 0;
}

/**
 * Restoring trusts the local stores to show what the server has. If most
 * confirmed changes look untouched there, the stores are stale: stop rather
 * than skip everything.
 */
function storesLookStale(p: Platform, j: Journal) {
	const done = Object.entries(j.guilds).filter(([, c]) => c.status === "done");
	if (done.length < 3) return false;
	return done.filter(([id, c]) => matches(p.deps.currentGuild(id), c.prev)).length / done.length
		> 0.5;
}

/** Is the local copy the journal the flag points at (or a v1 Focus of this device)? */
const isCurrentCopy = (local: LocalState, flag: Flag | null, deviceId: string) =>
	local.journal.profile === "focus" && (isShared(flag)
		? flag.journal === local.journalId
		: !!flag && flag.device === deviceId && !local.journalId);

/**
 * Drops a local Focus copy that has nothing left to put back, e.g. after
 * another device restored it. A copy that still has settings at the Focus
 * value is kept: it may be the only record of their old values.
 */
export async function reconcile(p: Platform, note: string | null) {
	const local = p.loadLocal();
	if (local.journal.profile !== "focus" || isCurrentCopy(local, parseFlag(note), p.deviceId)) {
		return;
	}
	if (!hasLeftovers(p, local.journal)) await p.saveLocal({ journal: emptyJournal() });
}

// ---------- switching ----------

export async function enter(p: Platform): Promise<Outcome> {
	const note = await p.readNote();
	const d = canEnter(note, p.deviceId);
	if (!d.ok) {
		return d.reason === "otherDevice"
			? { kind: "other-device", flag: d.flag }
			: { kind: "foreign-note" };
	}
	const flag = parseFlag(note);
	const local = p.loadLocal();
	// Planning again over settings an older Focus still holds would record the
	// Focus values as the "old" ones and lose the real ones
	const current = isCurrentCopy(local, flag, p.deviceId);
	if (local.journal.profile === "focus" && !current && hasLeftovers(p, local.journal)) {
		return { kind: "unrestored" };
	}

	let journal: Journal | null = null;
	let channel = "";
	let journalId = "";
	if (isShared(flag)) {
		// Focus is already on from this device: retry what failed
		({ channel, journal: journalId } = flag);
		if (current) journal = clone(local.journal);
		else {
			try {
				journal = await readShared(p, channel, journalId);
			} catch (e) {
				return { kind: "journal-unreadable", error: message(e) };
			}
		}
	}
	if (journal?.profile !== "focus") {
		// A v1 Focus of this device moves to a shared journal as it is
		journal = current ? clone(local.journal) : plan(p);
		channel = await p.syncChannel();
		journalId = newJournalId();
		// The old values are stored before the flag points at them, and both
		// before any setting changes
		await cleanShared(p, channel, journalId);
		await writeShared(p, channel, journalId, journal);
		const at = current && flag ? flag.at : new Date(p.now()).toISOString();
		await p.writeNote(
			encodeFlag({ device: p.deviceId, label: p.deviceLabel, at, channel, journal: journalId }),
		);
	}

	const result = await applyJournal(journal, engineDeps(p, { journalId }));
	try {
		await writeShared(p, channel, journalId, journal);
		return { kind: "applied", result };
	} catch (e) {
		return { kind: "applied", result, syncError: message(e) };
	}
}

export async function leave(p: Platform): Promise<Outcome> {
	const note = await p.readNote();
	const d = canLeave(note, p.deviceId);
	if (!d.ok) {
		return d.reason === "otherDevice"
			? { kind: "other-device", flag: d.flag }
			: { kind: "foreign-note" };
	}
	const flag = parseFlag(note);
	const local = p.loadLocal();

	let journal: Journal;
	// The copy on this device, when it is the one being restored
	let own: LocalState | null = null;
	if (isShared(flag)) {
		const mine = isCurrentCopy(local, flag, p.deviceId);
		try {
			journal = await readShared(p, flag.channel, flag.journal);
		} catch (e) {
			if (!mine) return { kind: "journal-unreadable", error: message(e) };
			journal = clone(local.journal);
		}
		if (mine) own = local;
	} else {
		// A v1 flag of this device, or no flag: only the local copy exists
		journal = clone(local.journal);
		own = local;
	}

	if (journal.profile !== "focus") {
		if (flag) await p.writeNote("");
		if (own) await p.saveLocal({ journal: emptyJournal() });
		return { kind: "already-normal" };
	}
	if (storesLookStale(p, journal)) return { kind: "stale-stores" };

	const result = await restoreJournal(journal, engineDeps(p, own));
	// restoreJournal sets the profile back to normal once nothing is left
	const complete = (journal as Journal).profile === "normal";
	if (!complete) {
		if (!isShared(flag)) return { kind: "restored", result, complete };
		// What is left goes back where every device can retry it
		try {
			await writeShared(p, flag.channel, flag.journal, journal);
			return { kind: "restored", result, complete };
		} catch (e) {
			return { kind: "restored", result, complete, syncError: message(e) };
		}
	}

	// Release the flag before removing the journal it points at
	if (flag) await p.writeNote("");
	if (own) await p.saveLocal({ journal: emptyJournal() });
	else await reconcile(p, null);
	if (isShared(flag)) await cleanShared(p, flag.channel).catch(() => {});
	return { kind: "restored", result, complete };
}

/**
 * Applies or restores single items while Focus from this device is on
 * (whitelist / exclusion edits, new DMs)
 */
export async function syncItems(p: Platform, guildIds: string[], channelIds: string[]) {
	const local = p.loadLocal();
	if (local.journal.profile !== "focus") return;
	const flag = parseFlag(await p.readNote());
	if (!isShared(flag) || !isCurrentCopy(local, flag, p.deviceId)) return;

	const j = clone(local.journal);
	const o = p.options();
	const add: Journal = { profile: "focus", guilds: {}, channels: {} };
	const back: Journal = { profile: "focus", guilds: {}, channels: {} };

	for (const id of guildIds) {
		const cur = p.deps.currentGuild(id);
		if (!cur) continue;
		if (o.excluded.has(id)) {
			if (j.guilds[id]) back.guilds[id] = j.guilds[id];
		} else if (o.muteServers && !j.guilds[id]) {
			Object.assign(
				add.guilds,
				planFocus({
					guilds: { [id]: cur },
					dms: [],
					whitelist: o.whitelist,
					excludedGuilds: o.excluded,
					muteServers: true,
					muteGroupDMs: true,
				}).guilds,
			);
		}
	}
	const dms = new Map(p.privateChannels().map(c => [c.id, c]));
	for (const id of channelIds) {
		const info = dms.get(id);
		const cur = p.deps.currentDm(id);
		if (!info || !cur) continue;
		if (isKept(info, o.whitelist, o.muteGroupDMs)) {
			if (j.channels[id]) back.channels[id] = j.channels[id];
		} else if (!j.channels[id]) {
			Object.assign(
				add.channels,
				planFocus({
					guilds: {},
					dms: [{ info, prefs: cur }],
					whitelist: o.whitelist,
					excludedGuilds: o.excluded,
					muteServers: false,
					muteGroupDMs: o.muteGroupDMs,
				}).channels,
			);
		}
	}

	const backGuilds = Object.keys(back.guilds);
	const backChannels = Object.keys(back.channels);
	if (
		!backGuilds.length && !backChannels.length && !Object.keys(add.guilds).length
		&& !Object.keys(add.channels).length
	) return;

	if (backGuilds.length || backChannels.length) {
		// restoreJournal drops what it put back from `back`; mirror that in the main journal
		await restoreJournal(back, engineDeps(p, null));
		for (const id of backGuilds) if (!back.guilds[id]) delete j.guilds[id];
		for (const id of backChannels) if (!back.channels[id]) delete j.channels[id];
	}
	Object.assign(j.guilds, add.guilds);
	Object.assign(j.channels, add.channels);
	await applyJournal(j, engineDeps(p, local));
	await writeShared(p, flag.channel, flag.journal, j);
}

/**
 * Clears a flag whose journal is gone for good. Changes no notification
 * setting; a device that still has its own copy keeps it.
 */
export async function clearFlag(p: Platform) {
	await p.writeNote("");
	await reconcile(p, null);
}
