// Shared with the Equicord build (956zs/Equicord-Plugin notificationProfiles/planner.ts).
// Keep both copies identical; tests live in that repo (tests/notificationProfiles.test.mts).


// Pure planning for Focus mode. No Discord imports, so it is tested on its
// own (planner.test.mjs) and can be shared with a mobile build.
//
// Every change is recorded as { prev, next } per field before anything is
// sent. Restoring only puts back fields that still hold the Focus value, so
// anything the user changed by hand while Focus was on is left alone.

export interface MuteConfig {
    selected_time_window: number;
    end_time: string | null;
}

export interface GuildPrefs {
    muted: boolean;
    mute_config: MuteConfig | null;
    mobile_push: boolean;
    message_notifications: number;
    suppress_everyone: boolean;
    suppress_roles: boolean;
}

export interface DmPrefs {
    muted: boolean;
    mute_config: MuteConfig | null;
}

/** UserNotificationSetting: 0 all, 1 only mentions, 2 nothing (no notifications, not even direct mentions) */
export const NOTIFY_NOTHING = 2;

const FOREVER: MuteConfig = { selected_time_window: -1, end_time: null };

export const FOCUS_GUILD: GuildPrefs = {
    muted: true,
    mute_config: FOREVER,
    mobile_push: false,
    message_notifications: NOTIFY_NOTHING,
    suppress_everyone: true,
    suppress_roles: true,
};

export const FOCUS_DM: DmPrefs = { muted: true, mute_config: FOREVER };

export interface DmInfo {
    id: string;
    /** 1 = DM, 3 = group DM */
    type: number;
    recipients: string[];
}

export type Status = "pending" | "done" | "failed";

export interface Change<T> {
    prev: Partial<T>;
    next: Partial<T>;
    status: Status;
}

export interface Journal {
    /** focus: Focus is (being) applied; normal: nothing to restore */
    profile: "normal" | "focus";
    guilds: Record<string, Change<GuildPrefs>>;
    channels: Record<string, Change<DmPrefs>>;
}

export const emptyJournal = (): Journal => ({ profile: "normal", guilds: {}, channels: {} });

// Deep equality that ignores key order: Discord answers mute_config as
// {end_time, selected_time_window}, the other way round from what is sent
function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as any)[k])]));
    return v ?? null;
}

export const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The fields of `target` that differ from `current`, with their old values */
export function diff<T extends object>(current: T, target: Partial<T>): Change<T> | null {
    const prev: Partial<T> = {};
    const next: Partial<T> = {};
    for (const key of Object.keys(target) as (keyof T)[]) {
        if (!same(current[key], target[key])) {
            prev[key] = current[key];
            next[key] = target[key];
        }
    }
    return Object.keys(next).length ? { prev, next, status: "pending" } : null;
}

export function isKept(dm: DmInfo, whitelist: ReadonlySet<string>, muteGroupDMs: boolean) {
    if (dm.type === 1) return dm.recipients.some(id => whitelist.has(id));
    return !muteGroupDMs;
}

export interface FocusInput {
    guilds: Record<string, GuildPrefs>;
    dms: { info: DmInfo; prefs: DmPrefs; }[];
    whitelist: ReadonlySet<string>;
    excludedGuilds: ReadonlySet<string>;
    muteServers: boolean;
    muteGroupDMs: boolean;
}

export function planFocus(input: FocusInput): Journal {
    const journal: Journal = { profile: "focus", guilds: {}, channels: {} };

    if (input.muteServers) {
        for (const [id, prefs] of Object.entries(input.guilds)) {
            if (input.excludedGuilds.has(id)) continue;
            const change = diff(prefs, FOCUS_GUILD);
            if (change) journal.guilds[id] = change;
        }
    }

    for (const { info, prefs } of input.dms) {
        if (isKept(info, input.whitelist, input.muteGroupDMs)) continue;
        const change = diff(prefs, FOCUS_DM);
        if (change) journal.channels[info.id] = change;
    }
    return journal;
}

/**
 * The fields to put back for one item: those the Focus change actually wrote
 * and that still hold the Focus value now
 */
export function restoreFields<T extends object>(change: Change<T>, current: T): Partial<T> | null {
    // Also covers "pending"/"failed" items: whatever landed still matches Focus
    const out: Partial<T> = {};
    for (const key of Object.keys(change.next) as (keyof T)[]) {
        if (same(current[key], change.next[key])) out[key] = change.prev[key];
    }
    return Object.keys(out).length ? out : null;
}

export function planRestore(
    journal: Journal,
    currentGuild: (id: string) => GuildPrefs | null,
    currentDm: (id: string) => DmPrefs | null,
) {
    const guilds: Record<string, Partial<GuildPrefs>> = {};
    const channels: Record<string, Partial<DmPrefs>> = {};
    for (const [id, change] of Object.entries(journal.guilds)) {
        const cur = currentGuild(id);
        const fields = cur && restoreFields(change, cur);
        if (fields) guilds[id] = fields;
    }
    for (const [id, change] of Object.entries(journal.channels)) {
        const cur = currentDm(id);
        const fields = cur && restoreFields(change, cur);
        if (fields) channels[id] = fields;
    }
    return { guilds, channels };
}

/** True when every field in `want` matches `current` */
export const matches = <T extends object>(current: T | null, want: Partial<T>) =>
    current != null && (Object.keys(want) as (keyof T)[]).every(k => same(current[k], want[k]));

export function parseIds(text: string): string[] {
    return [...new Set(text.split(/[\s,;]+/).map(s => s.trim()).filter(s => /^\d{15,25}$/.test(s)))];
}

export function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}
