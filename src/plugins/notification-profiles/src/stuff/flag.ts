// Shared with the Equicord build (956zs/Equicord-Plugin notificationProfiles/flag.ts).
// Keep both copies identical; tests live in that repo (tests/notificationProfiles.test.mts).

// Cross-device state lives in a private Discord note on your own account
// (PUT /users/@me/notes/{yourId}): only you can see it and Discord syncs it to
// every device. It only says who turned Focus on; the journal with the old
// values stays on that device, so that device is the one that turns it off.

export interface Flag {
	/** Random id of the device that turned Focus on */
	device: string;
	/** Human name of that device, e.g. "phone" */
	label: string;
	/** ISO time Focus was turned on */
	at: string;
}

const PREFIX = "NP1 focus";
const NOTE_LIMIT = 256;

export function encodeFlag(flag: Flag): string {
	const label = flag.label.replace(/\s+/g, "_").slice(0, 32);
	return `${PREFIX} ${flag.device} ${label} ${flag.at}`.slice(0, NOTE_LIMIT);
}

/** null for no note, an unrelated note, or a malformed one */
export function parseFlag(note: string | null | undefined): Flag | null {
	if (!note?.startsWith(`${PREFIX} `)) return null;
	const [device, label, at] = note.slice(PREFIX.length + 1).trim().split(/\s+/);
	if (!device || !label || !at || Number.isNaN(Date.parse(at))) return null;
	return { device, label, at };
}

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

/** May this device turn Focus off? Only the device that turned it on can */
export function canLeave(note: string | null | undefined, myDevice: string): Decision {
	const flag = parseFlag(note);
	if (flag && flag.device !== myDevice) return { ok: false, reason: "otherDevice", flag };
	return { ok: true };
}

export const newDeviceId = () => Math.random().toString(36).slice(2, 10);
