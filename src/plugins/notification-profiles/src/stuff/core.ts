import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import * as controller from "./controller";
import { HttpError, type Result } from "./engine";
import { type Flag, isShared, newDeviceId, parseFlag } from "./flag";
import {
	type DmInfo,
	type DmPrefs,
	emptyJournal,
	FOCUS_DM,
	type GuildPrefs,
	type Journal,
} from "./planner";
import { SYNC_CHANNEL_NAME } from "./sync";

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

// Never store null: Vendetta storage wraps every object read in a Proxy, and
// typeof null is "object", so a null value breaks reads. Delete the key instead.
export const vstorage = storage as {
	whitelist: string[];
	excluded: string[];
	muteServers: boolean;
	muteGroupDMs: boolean;
	/** This phone's copy of the journal (the shared one lives in the sync channel) */
	journal: Journal;
	/** Id of the shared journal the copy belongs to */
	journalId?: string;
	failed: Failures;
	busy: boolean;
	deviceId: string;
	/** Last known cross-device flag (private note on your own account) */
	flag?: Flag;
	/** The shared journal of the current flag could not be read last time */
	journalLost?: boolean;
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

/** A group DM with nobody else in it, like the sync channel: never worth muting */
const isSolo = (c: any) => c.type === 3 && !c.recipients?.length;

function privateChannels(): DmInfo[] {
	return (ChannelStore.getSortedPrivateChannels() as any[])
		.filter(c => (c.type === 1 || c.type === 3) && !isSolo(c))
		.map(c => ({ id: c.id, type: c.type, recipients: c.recipients ?? [] }));
}

async function rest(
	method: "get" | "post" | "patch" | "del",
	url: string,
	options: { body?: object; query?: object } = {},
) {
	try {
		const res = await HTTP[method]({ url, ...options });
		return res?.body;
	} catch (e: any) {
		console.warn(
			"[NotificationProfiles]",
			method.toUpperCase(),
			url,
			e?.status,
			JSON.stringify(e?.body ?? e?.message ?? e).slice(0, 500),
		);
		throw new HttpError(typeof e?.status === "number" ? e.status : undefined, e?.body?.retry_after);
	}
}

const deps: controller.Platform["deps"] = {
	async patchGuilds(batch) {
		const body = await rest("patch", "/users/@me/guilds/settings", { body: { guilds: batch } });
		for (const [guildId, settings] of Object.entries(batch)) {
			FluxDispatcher.dispatch({ type: "USER_GUILD_SETTINGS_GUILD_UPDATE", guildId, settings });
		}
		return body;
	},
	async patchDms(overrides) {
		const body = await rest("patch", "/users/@me/guilds/@me/settings", {
			body: { channel_overrides: overrides },
		});
		FluxDispatcher.dispatch({
			type: "USER_GUILD_SETTINGS_CHANNEL_UPDATE_BULK",
			guildId: null,
			overrides,
		});
		return body;
	},
	currentGuild,
	currentDm,
	sleep: ms => new Promise(r => setTimeout(r, ms)),
};

export const guildName = (id: string) => GuildStore.getGuild(id)?.name ?? id;

// ---------- cross-device flag and shared journal ----------

export const deviceName = (label: string) =>
	({ desktop: "電腦", phone: "手機" } as Record<string, string>)[label] ?? label;
export const flagTime = (f: Flag) =>
	new Date(f.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
const noteUrl = () => `/users/@me/notes/${UserStore.getCurrentUser().id}`;

async function readNote(): Promise<string | null> {
	try {
		const res = await HTTP.get({ url: noteUrl() });
		return res?.body?.note || null;
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

/** The group DM with only you that holds the shared journal; made on first use */
async function syncChannel(): Promise<string> {
	const me = UserStore.getCurrentUser().id;
	const found = (ChannelStore.getSortedPrivateChannels() as any[])
		.find(c => isSolo(c) && c.ownerId === me && c.name === SYNC_CHANNEL_NAME);
	if (found) return found.id;
	const { id } = await rest("post", "/users/@me/channels", { body: { recipients: [] } });
	await rest("patch", `/channels/${id}`, { body: { name: SYNC_CHANNEL_NAME } });
	await deps.patchDms({ [id]: FOCUS_DM });
	return id;
}

const platform: controller.Platform = {
	get deviceId() {
		return vstorage.deviceId;
	},
	deviceLabel: DEVICE_LABEL,
	deps,
	guildIds: () => Object.keys(GuildStore.getGuilds()),
	privateChannels,
	options: () => ({
		whitelist: new Set(vstorage.whitelist),
		excluded: new Set(vstorage.excluded),
		muteServers: vstorage.muteServers,
		muteGroupDMs: vstorage.muteGroupDMs,
	}),
	readNote,
	writeNote,
	syncChannel,
	async listMessages(channelId) {
		const body = await rest("get", `/channels/${channelId}/messages`, { query: { limit: 100 } });
		return (Array.isArray(body) ? body : []).map((m: any) => ({
			id: String(m.id),
			content: String(m.content ?? ""),
		}));
	},
	async sendMessage(channelId, content) {
		// 4096: sent without a notification
		await rest("post", `/channels/${channelId}/messages`, { body: { content, flags: 4096 } });
	},
	async deleteMessage(channelId, messageId) {
		await rest("del", `/channels/${channelId}/messages/${messageId}`);
	},
	loadLocal: () => ({ journal: clone(vstorage.journal), journalId: vstorage.journalId }),
	async saveLocal(state) {
		vstorage.journal = clone(state.journal);
		if (state.journalId) vstorage.journalId = state.journalId;
		else delete vstorage.journalId;
	},
	now: () => Date.now(),
};

function setFlag(note: string | null) {
	const flag = parseFlag(note);
	if (flag?.journal !== vstorage.flag?.journal) delete vstorage.journalLost;
	if (flag) vstorage.flag = flag;
	else delete vstorage.flag;
}

export async function refreshFlag() {
	try {
		const note = await readNote();
		setFlag(note);
		if (!vstorage.busy) await controller.reconcile(platform, note);
	} catch (e) {
		console.warn("[NotificationProfiles]", e);
	}
}

/** The flag belongs to another device: Focus was turned on there */
export const flagElsewhere = () =>
	vstorage.flag && vstorage.flag.device !== vstorage.deviceId ? vstorage.flag : null;

/** Focus from another device that only that device can turn off (a v1 flag) */
export const lockedElsewhere = () => {
	const f = flagElsewhere();
	return f != null && !isShared(f);
};

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
		await refreshFlag();
	}
}

function report(
	kind: "focus" | "normal",
	r: { guilds: Result; channels: Result },
	syncError?: string,
) {
	vstorage.failed = {
		guilds: r.guilds.failed,
		channels: r.channels.failed,
		restoring: kind === "normal",
	};
	const sync = syncError ? `。同步頻道的紀錄沒更新（${syncError}）` : "";
	if (!r.guilds.failed.length && !r.channels.failed.length) {
		toast(
			(kind === "focus"
				? `專注模式：改了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`
				: `一般模式：還原了 ${r.guilds.ok.length} 個伺服器、${r.channels.ok.length} 個私訊`) + sync,
			!syncError,
		);
	} else {
		const names = r.guilds.failed.slice(0, 3).map(guildName).join("、");
		toast(
			`${kind === "focus" ? "有些沒改成功" : "有些沒還原"}：${r.guilds.failed.length} 個伺服器${
				names ? `（${names}…）` : ""
			}、${r.channels.failed.length} 個私訊。到外掛設定重試${sync}`,
			false,
		);
	}
}

function show(o: controller.Outcome) {
	switch (o.kind) {
		case "applied":
			return report("focus", o.result, o.syncError);
		case "restored":
			return report("normal", o.result, o.syncError);
		case "already-normal":
			vstorage.failed = { guilds: [], channels: [], restoring: false };
			return toast("已經是一般模式");
		case "other-device":
			return toast(
				`專注模式是${deviceName(o.flag.label)}在 ${
					flagTime(o.flag)
				} 開的，請到那台切換。那台資料不見的話，可以在設定清除同步旗標`,
				false,
			);
		case "foreign-note":
			return toast("你自己帳號的備註已經有別的內容，為了不蓋掉它，同步旗標用不了", false);
		case "stale-stores":
			return toast(
				"Discord 的設定看起來還沒同步，為了不漏還原先停下來。重開 Discord 後再試",
				false,
			);
		case "journal-unreadable":
			vstorage.journalLost = true;
			return toast(
				`讀不到同步頻道裡的紀錄（${o.error}），沒有改任何設定。到開專注模式的那台切回一般模式；那台的資料也不見了的話，才清除同步旗標`,
				false,
			);
		case "unrestored":
			return toast("上次的專注模式還有設定沒還原，先切回一般模式再開", false);
	}
}

export const enterFocus = () => run(async () => show(await controller.enter(platform)));
export const leaveFocus = () => run(async () => show(await controller.leave(platform)));

export const clearFlag = () =>
	run(async () => {
		await controller.clearFlag(platform);
		toast("已清除同步旗標");
	});

const syncItems = (guildIds: string[], channelIds: string[]) =>
	controller.syncItems(platform, guildIds, channelIds).catch(e =>
		console.error("[NotificationProfiles]", e)
	);

export function toggleWhitelist(userId: string) {
	const listed = vstorage.whitelist.includes(userId);
	vstorage.whitelist = listed
		? vstorage.whitelist.filter(id => id !== userId)
		: [...vstorage.whitelist, userId];
	const dmId = ChannelStore.getDMFromUserId(userId);
	if (dmId) void syncItems([], [dmId]);
	return !listed;
}

export function toggleExcluded(guildId: string) {
	const listed = vstorage.excluded.includes(guildId);
	vstorage.excluded = listed
		? vstorage.excluded.filter(id => id !== guildId)
		: [...vstorage.excluded, guildId];
	void syncItems([guildId], []);
	return !listed;
}

// Another device changed the flag: Discord pushes note updates to every session
function onNoteUpdate({ id, note }: { id?: string; note?: string }) {
	if (id !== UserStore.getCurrentUser()?.id) return;
	setFlag(note || null);
	if (!vstorage.busy) {
		controller.reconcile(platform, note || null).catch(e =>
			console.error("[NotificationProfiles]", e)
		);
	}
}

function onChannelCreate({ channel }: { channel?: { id: string } }) {
	if (channel && !vstorage.busy) void syncItems([], [channel.id]);
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
