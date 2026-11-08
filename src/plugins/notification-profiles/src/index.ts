import { registerCommand } from "@vendetta/commands";
import { findByStoreName } from "@vendetta/metro";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import Settings from "./components/Settings";
import {
	enterFocus,
	guildName,
	initStorage,
	leaveFocus,
	subscribe,
	toggleExcluded,
	toggleWhitelist,
} from "./stuff/core";

const UserStore = findByStoreName("UserStore");

const unloads: (() => void)[] = [];

// Local commands only run on this phone, nothing is sent to the chat
function command(
	name: string,
	description: string,
	execute: (args: any[], ctx: any) => void,
	options: any[] = [],
) {
	unloads.push(registerCommand({
		name,
		displayName: name,
		description,
		displayDescription: description,
		options,
		applicationId: "-1",
		inputType: 1,
		type: 1,
		execute: (args, ctx) => {
			execute(args, ctx);
		},
	}));
}

export function onLoad() {
	initStorage();
	unloads.push(subscribe());

	command("專注", "切到專注模式：只通知白名單的人的私訊", () => void enterFocus());
	command("一般", "切回一般模式：還原專注模式改過的設定", () => void leaveFocus());
	command(
		"專注白名單",
		"把一個人加入或移出專注模式的白名單",
		args => {
			const userId = args.find(a => a.name === "使用者")?.value;
			if (!userId) return;
			const added = toggleWhitelist(userId);
			const user = UserStore.getUser(userId);
			showToast(
				`${added ? "加入" : "移出"}白名單：${user?.globalName ?? user?.username ?? userId}`,
				getAssetIDByName("CircleCheckIcon-primary"),
			);
		},
		[{
			name: "使用者",
			displayName: "使用者",
			description: "要加入或移出的人",
			displayDescription: "要加入或移出的人",
			type: 6,
			required: true,
		}],
	);
	command("專注排除", "這個伺服器在專注模式也不要動（再用一次取消）", (_args, ctx) => {
		const guildId = ctx?.guild?.id;
		if (!guildId) {
			showToast("要在伺服器的頻道裡使用", getAssetIDByName("CircleXIcon-primary"));
			return;
		}
		const added = toggleExcluded(guildId);
		showToast(
			`${guildName(guildId)}：${added ? "專注模式不會動它" : "專注模式會照常處理它"}`,
			getAssetIDByName("CircleCheckIcon-primary"),
		);
	});
}

export function onUnload() {
	for (const u of unloads.splice(0)) u();
}

export const settings = Settings;
