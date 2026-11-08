import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { applyJournal, type Deps, HttpError, restoreJournal } from "./engine";
import {
	canEnter,
	canLeave,
	type Decision,
	encodeFlag,
	type Flag,
	newDeviceId,
	parseFlag,
} from "./flag";
import {
	type DmInfo,
	type DmPrefs,
	emptyJournal,
	type GuildPrefs,
	isKept,
	type Journal,
	matches,
	planFocus,
} from "./planner";

const UserGuildSettingsStore = findByStoreName("UserGuildSettingsStore");
const ChannelStore = findByStoreName("ChannelStore");
const GuildStore = findByStoreName("GuildStore");
const HTTP = findByProps("getAPIBaseURL", "patch");
const UserStore = findByStoreName("UserStore");

const DEVICE_LABEL = "phone";

export interface Failures {
	guilds: string[];
	channels: string[];
	restoring: boolean;
}

export const vstorage = storage as {
	whitelist: string[];
	excluded: string[];
	muteServers: boolean;
	muteGroupDMs: boolean;
	journal: Journal;
	failed: Failures;
	busy: boolean;
	deviceId: string;
	/**
	 * Last known cross-device flag (private note on your own account).
	 * Never null: Vendetta storage wraps every object read in a Proxy, and
	 * typeof null is "object", so a null value breaks reads. Delete instead.
	 */
	flag?: Flag;
};

export function initStorage() {
	vstorage.whitelist ??= [];
	vstorage.excluded ??= [];
	vstorage.muteServers ??= true;
	vstorage.muteGroupDMs ??= true;
	vstorage.journal ??= emptyJournal();
	vstorage.failed ??= { guilds: [], channels: [], restoring: false };
	vstorage.busy = false;
	vstorage.deviceId ??= newDeviceId();
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const toast = (text: string, ok = true) =>
	showToast(text, getAssetIDByName(ok ? "CircleCheckIcon-primary" : "CircleXIcon-primary"));

// ---------- Discord access ----------

export function currentGuild(id: string): GuildPrefs | null {
	if (!GuildStore.getGuild(id)) return null;
	const s = UserGuildSettingsStore;
	return {
		muted: s.isMuted(id),
		mute_config: s.getMuteConfig(id) ?? null,
		mobile_push: s.isMobilePushEnabled(id),
		message_notifications: s.getMessageNotifications(id),
		suppress_everyone: s.isSuppressEveryoneEnabled(id),
		suppress_roles: s.isSuppressRolesEnabled(id),
	};
}

export function currentDm(id: string): DmPrefs | null {
	if (!ChannelStore.getChannel(id)) return null;
	return {
		muted: UserGuildSettingsStore.isChannelMuted(null, id),
		mute_config: UserGuildSettingsStore.getChannelMuteConfig(null, id) ?? null,
	};
}

function privateChannels(): DmInfo[] {
	return (ChannelStore.getSortedPrivateChannels() as any[])
		.filter(c => c.type === 1 || c.type === 3)
		.map(c => ({ id: c.id, type: c.type, recipients: c.recipients ?? [] }));
}

async function patch(url: string, body: object) {
	try {
		const res = await HTTP.patch({ url, body });
		return res?.body;
	} catch (e: any) {
		console.warn(
			"[NotificationProfiles] PATCH",
			url,
			e?.status,
			JSON.stringify(e?.body ?? e?.message ?? e).slice(0, 500),
		);
		throw new HttpError(typeof e?.status === "number" ? e.status : undefined, e?.body?.retry_after);
	}
}

const deps: Deps = {
	async patchGuilds(batch) {
		const body = await patch("/users/@me/guilds/settings", { guilds: batch });
		for (const [guildId, settings] of Object.entries(batch)) {
			FluxDispatcher.dispatch({ type: "USER_GUILD_SETTINGS_GUILD_UPDATE", guildId, settings });
		}
		return body;
	},
	async patchDms(overrides) {
		const body = await patch("/users/@me/guilds/@me/settings", { channel_overrides: overrides });
		FluxDispatcher.dispatch({
			type: "USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK",
			guildId: null,
			overrides,
		});
		return body;
	},
	currentGuild,
	currentDm,
	async save(j) {
		vstorage.journal = clone(j);
	},
	sleep: ms => new Promise(r => setTimeout(r, ms)),
};

export const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? id;

// ---------- guards ----------

/** Restoring trusts the stores; if most confirmed changes look untouched there, they are stale */
function storesLookStale(j: Journal) {
	const done = Object.entries(j.guilds).filter(([, c]) => c.status === "done");
	if (done.length < 3) return false;
	return done.filter(([id, c]) => matches(currentGuild(id), c.prev)).length / done.length > 0.5;
}

// ---------- cross-device flag ----------

export const deviceName = (label: string) =>
	({ desktop: "電腦", phone: "手機" } as Record<string, string>)[label] ?? label;
export const flagTime = (f: Flag) =>
	new Date(f.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
const noteUrl = () => `/users/@me/notes/${UserStore.getCurrentUser().id}`;

async function readNote(): Promise<string | null> {
	try {
		const res = await HTTP.get({ url: noteUrl() });
		return res?.body?.note ?? null;
	} catch (e: any) {
		if (e?.status === 404) return null;
		throw new Error(`讀不到同步旗標（HTTP ${e?.status ?? "?"}）`);
	}
}

async function writeNote(note: string) {
	try {
		await HTTP.put({ url: noteUrl(), body: { note } });
	} catch (e: any) {
		throw new Error(`寫不進同步旗標（HTTP ${e?.status ?? "?"}）`);
	}
}

function setFlag(flag: Flag | null) {
	if (flag) vstorage.flag = flag;
	else delete vstorage.flag;
}

export async function refreshFlag() {
	try {
		setFlag(parseFlag(await readNote()));
	} catch (e) {
		console.warn("[NotificationProfiles]", e);
	}
}

/** The flag belongs to another device: Focus was turned on there */
export const flagElsewhere = () =>
	vstorage.flag && vstorage.flag.device !== vstorage.deviceId ? vstorage.flag : null;

function refuse(d: Exclude<Decision, { ok: true }>) {
	toast(
		d.reason === "otherDevice"
			? `專注模式是${deviceName(d.flag.label)}在 ${
				flagTime(d.flag)
			} 開的，請到那台切換。那台資料不見的話，可以在設定清除同步旗標`
			: "你自己帳號的備註已經有別的內容，為了不蓋掉它，同步旗標用不了",
		false,
	);
}

export const clearFlag = () =>
	run(async () => {
		await writeNote("");
		setFlag(null);
		toast("已清除同步旗標");
	});

// ---------- switching ----------

async function run(task: () => Promise<void>) {
	if (vstorage.busy) return toast("還在處理上一個動作", false);
	vstorage.busy = true;
	try {
		await task();
	} catch (e) {
		console.error("[NotificationProfiles]", e);
		toast(`出錯了：${String((e as Error)?.message ?? e)}`, false);
	} finally {
		vstorage.busy = false;
	}
}

function report(kind: "focus" | "normal", r: Awaited<ReturnType<typeof applyJournal>>) {
	vstorage.failed = {
		guilds: r.guilds.failed,
		channels: r.channels.failed,
		restoring: kind === "normal",
	};
	if (!r.guilds.failed.length && !r.channels.failed.length) {
		toast(
			kind === "focus"
				? `專注模式：改了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`
				: `一般模式：還原了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`,
		);
	} else {
		const names = r.guilds.failed.slice(0, 3).map(guildName).join("、");
		toast(
			`${kind === "focus" ? "有些沒改成功" : "有些沒還原"}：${r.guilds.failed.length} 個伺服器${
				names ? `（${names}…）` : ""
			}、${r.channels.failed.length} 個私訊。到外掛設定重試`,
			false,
		);
	}
}

export const enterFocus = () =>
	run(async () => {
		const note = await readNote();
		const d = canEnter(note, vstorage.deviceId);
		if (!d.ok) return refuse(d);
		// Claim Focus for this device before changing anything
		if (!parseFlag(note)) {
			vstorage.flag = {
				device: vstorage.deviceId,
				label: DEVICE_LABEL,
				at: new Date().toISOString(),
			};
			await writeNote(encodeFlag(vstorage.flag));
		}
		let j = clone(vstorage.journal);
		if (j.profile !== "focus") {
			const guilds: Record<string, GuildPrefs> = {};
			for (const id of Object.keys(GuildStore.getGuilds())) {
				const cur = currentGuild(id);
				if (cur) guilds[id] = cur;
			}
			j = planFocus({
				guilds,
				dms: privateChannels().map(info => ({ info, prefs: currentDm(info.id)! })).filter(d =>
					d.prefs
				),
				whitelist: new Set(vstorage.whitelist),
				excludedGuilds: new Set(vstorage.excluded),
				muteServers: vstorage.muteServers,
				muteGroupDMs: vstorage.muteGroupDMs,
			});
		}
		// also retries anything that failed last time
		report("focus", await applyJournal(j, deps));
	});

export const leaveFocus = () =>
	run(async () => {
		const note = await readNote();
		const d = canLeave(note, vstorage.deviceId);
		if (!d.ok) return refuse(d);
		const j = clone(vstorage.journal);
		if (j.profile !== "focus") {
			if (parseFlag(note)) {
				// Our own flag with nothing to restore: just release it
				await writeNote("");
				setFlag(null);
			}
			toast("已經是一般模式");
			return;
		}
		if (storesLookStale(j)) {
			toast("Discord 的設定看起來還沒同步，為了不漏還原先停下來。重開 Discord 後再試", false);
			return;
		}
		report("normal", await restoreJournal(j, deps));
		// Release the flag only once everything is back
		if (vstorage.journal.profile === "normal" && parseFlag(note)) {
			await writeNote("");
			setFlag(null);
		}
	});

/** Applies or restores single items while Focus is on (whitelist / exclusion edits, new DMs) */
async function syncItems(guildIds: string[], channelIds: string[]) {
	const j = clone(vstorage.journal);
	if (j.profile !== "focus") return;
	const wl = new Set(vstorage.whitelist);
	const ex = new Set(vstorage.excluded);
	const add: Journal = { profile: "focus", guilds: {}, channels: {} };
	const back: Journal = { profile: "focus", guilds: {}, channels: {} };

	for (const id of guildIds) {
		const cur = currentGuild(id);
		if (!cur) continue;
		if (ex.has(id)) {
			if (j.guilds[id]) back.guilds[id] = j.guilds[id];
		} else if (vstorage.muteServers && !j.guilds[id]) {
			Object.assign(
				add.guilds,
				planFocus({
					guilds: { [id]: cur },
					dms: [],
					whitelist: wl,
					excludedGuilds: ex,
					muteServers: true,
					muteGroupDMs: true,
				})
					.guilds,
			);
		}
	}
	for (const id of channelIds) {
		const ch = ChannelStore.getChannel(id);
		const cur = currentDm(id);
		if (!ch || !cur || (ch.type !== 1 && ch.type !== 3)) continue;
		const info: DmInfo = { id, type: ch.type, recipients: ch.recipients ?? [] };
		if (isKept(info, wl, vstorage.muteGroupDMs)) {
			if (j.channels[id]) back.channels[id] = j.channels[id];
		} else if (!j.channels[id]) {
			Object.assign(
				add.channels,
				planFocus({
					guilds: {},
					dms: [{ info, prefs: cur }],
					whitelist: wl,
					excludedGuilds: ex,
					muteServers: false,
					muteGroupDMs: vstorage.muteGroupDMs,
				}).channels,
			);
		}
	}

	const backGuilds = Object.keys(back.guilds);
	const backChannels = Object.keys(back.channels);
	if (backGuilds.length || backChannels.length) {
		// restoreJournal drops what it put back from `back`; mirror that in the main journal
		await restoreJournal(back, { ...deps, save: async () => {} });
		for (const id of backGuilds) if (!back.guilds[id]) delete j.guilds[id];
		for (const id of backChannels) if (!back.channels[id]) delete j.channels[id];
		await deps.save(j);
	}
	if (Object.keys(add.guilds).length || Object.keys(add.channels).length) {
		Object.assign(j.guilds, add.guilds);
		Object.assign(j.channels, add.channels);
		await applyJournal(j, deps);
	}
}

const quiet = (p: Promise<void>) => p.catch(e => console.error("[NotificationProfiles]", e));

export function toggleWhitelist(userId: string) {
	const listed = vstorage.whitelist.includes(userId);
	vstorage.whitelist = listed
		? vstorage.whitelist.filter(id => id !== userId)
		: [...vstorage.whitelist, userId];
	const dmId = ChannelStore.getDMFromUserId(userId);
	if (dmId) quiet(syncItems([], [dmId]));
	return !listed;
}

export function toggleExcluded(guildId: string) {
	const listed = vstorage.excluded.includes(guildId);
	vstorage.excluded = listed
		? vstorage.excluded.filter(id => id !== guildId)
		: [...vstorage.excluded, guildId];
	quiet(syncItems([guildId], []));
	return !listed;
}

// Another device changed the flag: Discord pushes note updates to every session
function onNoteUpdate({ id, note }: { id?: string; note?: string }) {
	if (id === UserStore.getCurrentUser()?.id) setFlag(parseFlag(note));
}

function onChannelCreate({ channel }: { channel?: { id: string } }) {
	if (channel) quiet(syncItems([], [channel.id]));
}

export function subscribe() {
	FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
	FluxDispatcher.subscribe("USER_NOTE_UPDATE", onNoteUpdate);
	void refreshFlag();
	return () => {
		FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
		FluxDispatcher.unsubscribe("USER_NOTE_UPDATE", onNoteUpdate);
	};
}

export const pendingCount = (j: Journal) =>
	Object.values(j.guilds).filter(c => c.status !== "done").length
	+ Object.values(j.channels).filter(c => c.status !== "done").length;
