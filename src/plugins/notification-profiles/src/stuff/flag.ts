// Shared with the Equicord build (956zs/Equicord-Plugin notificationProfiles/flag.ts).
// Keep both copies identical; tests live in that repo (tests/notificationProfiles.test.mts).

// Cross-device state lives in a private Discord note on your own account
// (PUT /users/@me/notes/{yourId}): only you can see it and Discord syncs it to
// every device. It says who turned Focus on and, since v2, where the journal
// with the old values is stored (a group DM with only you, see sync.ts), so
// any device can turn Focus off. A v1 flag has no shared journal: only the
// device that wrote it can turn Focus off.

export interface Flag {
	/** Random id of the device that turned Focus on */
	device: string;
	/** Human name of that device, e.g. "phone" */
	label: string;
	/** ISO time Focus was turned on */
	at: string;
	/** v2: the group DM holding the journal, and the journal's id in it */
	channel?: string;
	journal?: string;
}

const V1 = "NP1 focus";
const V2 = "NP2 focus";
const NOTE_LIMIT = 256;

export function encodeFlag(flag: Flag): string {
	const label = flag.label.replace(/\s+/g, "_").slice(0, 32);
	const text = flag.channel && flag.journal
		? `${V2} ${flag.device} ${label} ${flag.at} ${flag.channel} ${flag.journal}`
		: `${V1} ${flag.device} ${label} ${flag.at}`;
	return text.slice(0, NOTE_LIMIT);
}

/** null for no note, an unrelated note, or a malformed one */
export function parseFlag(note: string | null | undefined): Flag | null {
	const v2 = note?.startsWith(`${V2} `);
	if (!v2 && !note?.startsWith(`${V1} `)) return null;
	const [device, label, at, channel, journal] = note!.slice(V1.length + 1).trim().split(/\s+/);
	if (!device || !label || !at || Number.isNaN(Date.parse(at))) return null;
	if (!v2) return { device, label, at };
	if (!/^\d{15,25}$/.test(channel ?? "") || !journal) return null;
	return { device, label, at, channel, journal };
}

/** A v2 flag: the journal is shared, any device can restore */
export const isShared = (flag: Flag | null): flag is Flag & { channel: string; journal: string } =>
	!!flag?.channel && !!flag.journal;

/** The note does not belong to this plugin, so it must never be overwritten */
export const isForeignNote = (note: string | null | undefined) =>
	!!note?.trim() && !parseFlag(note);

export type Decision =
	| { ok: true }
	| { ok: false; reason: "otherDevice"; flag: Flag }
	| { ok: false; reason: "foreignNote" };

/** May this device turn Focus on, or retry it? */
export function canEnter(note: string | null | undefined, myDevice: string): Decision {
	if (isForeignNote(note)) return { ok: false, reason: "foreignNote" };
	const flag = parseFlag(note);
	if (flag && flag.device !== myDevice) return { ok: false, reason: "otherDevice", flag };
	return { ok: true };
}

/** May this device turn Focus off? Any device for a shared (v2) journal, otherwise only the one that turned it on */
export function canLeave(note: string | null | undefined, myDevice: string): Decision {
	const flag = parseFlag(note);
	if (flag && !isShared(flag) && flag.device !== myDevice) {
		return { ok: false, reason: "otherDevice", flag };
	}
	return { ok: true };
}

export const newDeviceId = () => Math.random().toString(36).slice(2, 10);
