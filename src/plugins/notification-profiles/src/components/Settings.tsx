import { findByStoreName } from "@vendetta/metro";
import { React, ReactNative as RN } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";

import {
	clearFlag,
	deviceName,
	enterFocus,
	flagElsewhere,
	flagTime,
	guildName,
	leaveFocus,
	pendingCount,
	refreshFlag,
	toggleExcluded,
	toggleWhitelist,
	vstorage,
} from "../stuff/core";

const { FormSection, FormRow, FormSwitchRow, FormDivider } = Forms;
const UserStore = findByStoreName("UserStore");

const icon = (name: string) => <FormRow.Icon source={getAssetIDByName(name)} />;

export default () => {
	useProxy(vstorage);
	React.useEffect(() => void refreshFlag(), []);

	const j = vstorage.journal;
	const elsewhere = flagElsewhere();
	const focus = j.profile === "focus" || elsewhere != null;
	const f = vstorage.failed;
	const failedCount = f.guilds.length + f.channels.length;
	const leftovers = focus ? pendingCount(j) : 0;

	return (
		<RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
			<FormSection title={vstorage.busy ? "模式（處理中…）" : "模式"}>
				<FormRow
					label="一般模式"
					subLabel={elsewhere
						? `要在${deviceName(elsewhere.label)}切回`
						: focus
						? "把專注模式改過的設定還原"
						: "照 Discord 原本的通知設定"}
					leading={icon("BellIcon")}
					trailing={!focus ? icon("CheckmarkLargeIcon") : undefined}
					onPress={() => void leaveFocus()}
				/>
				<FormDivider />
				<FormRow
					label={elsewhere ? `專注模式（${deviceName(elsewhere.label)}開的）` : "專注模式"}
					subLabel={elsewhere
						? `${flagTime(elsewhere)} 在${deviceName(elsewhere.label)}開的`
						: `只通知白名單的 ${vstorage.whitelist.length} 個人的私訊`}
					leading={icon("BellSlashIcon")}
					trailing={focus ? icon("CheckmarkLargeIcon") : undefined}
					onPress={() => void enterFocus()}
				/>
				{j.profile === "focus" && (
					<FormRow
						label={`專注模式改了 ${Object.keys(j.guilds).length} 個伺服器、${
							Object.keys(j.channels).length
						} 個私訊`}
						subLabel="切回一般模式只會還原這些"
					/>
				)}
				{elsewhere && (
					<FormRow
						label="清除同步旗標"
						subLabel={`只有${deviceName(elsewhere.label)}的資料不見時才需要；不會改任何通知設定`}
						leading={icon("TrashIcon")}
						onPress={() => void clearFlag()}
					/>
				)}
			</FormSection>

			{(failedCount > 0 || leftovers > 0) && (
				<FormSection title="需要處理">
					<FormRow
						label={f.restoring ? "重試還原" : "重試沒改成功的"}
						subLabel={`${f.guilds.length} 個伺服器、${f.channels.length} 個私訊${
							f.guilds.length ? `：${f.guilds.slice(0, 5).map(guildName).join("、")}` : ""
						}`}
						leading={icon("RetryIcon")}
						onPress={() => void (f.restoring ? leaveFocus() : enterFocus())}
					/>
				</FormSection>
			)}

			<FormSection title="白名單（點一下移除）">
				{vstorage.whitelist.length === 0 && (
					<FormRow label="還沒有人" subLabel="在任何聊天輸入 /專注白名單 選人加入" />
				)}
				{vstorage.whitelist.map(id => {
					const user = UserStore.getUser(id);
					return (
						<FormRow
							key={id}
							label={user?.globalName ?? user?.username ?? id}
							subLabel={user ? `@${user.username}` : id}
							leading={icon("UserIcon")}
							onPress={() => toggleWhitelist(id)}
						/>
					);
				})}
			</FormSection>

			<FormSection title="不會動的伺服器（點一下移除）">
				{vstorage.excluded.length === 0 && (
					<FormRow label="沒有" subLabel="在伺服器的頻道輸入 /專注排除" />
				)}
				{vstorage.excluded.map(id => (
					<FormRow
						key={id}
						label={guildName(id)}
						leading={icon("ServerIcon")}
						onPress={() => toggleExcluded(id)}
					/>
				))}
			</FormSection>

			<FormSection title="選項">
				<FormSwitchRow
					label="專注時讓伺服器不通知"
					subLabel="靜音、手機推播關閉、通知設為「無」"
					value={vstorage.muteServers}
					onValueChange={(v: boolean) => (vstorage.muteServers = v)}
				/>
				<FormSwitchRow
					label="專注時把群組私訊靜音"
					value={vstorage.muteGroupDMs}
					onValueChange={(v: boolean) => (vstorage.muteGroupDMs = v)}
				/>
			</FormSection>
		</RN.ScrollView>
	);
};
