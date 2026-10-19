import { findByName, findByProps } from "@vendetta/metro";
import { React, ReactNative as RN } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { getAssetByID, getAssetIDByName } from "@vendetta/ui/assets";

import type { PlusStructure } from "$/typings";

import { PatchType } from "..";
import { state } from "../stuff/active";
import { getIconOverlay, getIconTint } from "../stuff/iconOverlays";
import { patches } from "../stuff/loader";
import modIcons from "../stuff/modIcons";
import { fixPath } from "../stuff/util";
import type { BunnyAsset, IconpackConfig } from "../types";

const Status = findByName("Status", false);
const jsxRuntime = findByProps("jsx", "jsxs");
// the original Image function component, Discord keeps references to it from before plugins load,
// so patching RN.Image misses most icons
const Image = findByProps(
	"getSize",
	"prefetch",
	"resolveAssetSource",
) as unknown as (props: any) => React.ReactElement;

export default function patchIcons(
	plus: PlusStructure,
	tree: string[],
	config: IconpackConfig,
) {
	const { iconpack } = state.iconpack;
	// Status no longer exists on newer versions, patching undefined would throw and skip the icon patches below
	if (config.biggerStatus && Status) {
		patches.push(
			before("default", Status, ([props], ...args) => [
				{
					...props,
					size: Math.floor(props.size * 1.5),
				},
				...args,
			]),
		);
	}

	if (plus.icons || plus.customOverlays || iconpack) {
		if (plus.icons) state.patches.push(PatchType.Icons);
		if (plus.customOverlays) {
			state.patches.push(PatchType.CustomIconOverlays);
		}
		if (iconpack) state.patches.push(PatchType.Iconpack);

		// elements created before unpatching keep this component, so it has to fall back to Image
		let active = true;

		const PatchedImage = (_props: any) => {
			const props = { ..._props };

			if (!active || props.ignore) return Image(props);
			const { source } = props;

			let asset: BunnyAsset | null = null;

			// theme mod icons (bunny, revenge)
			const modIcon = Object.entries(modIcons).find(
				([_, { raw }]) => source?.uri === raw,
			);
			if (modIcon) {
				asset = {
					httpServerLocation: "//_",
					width: 64,
					height: 64,
					name: modIcon[0],
					type: "png",
				};
			} // custom themhed icons API
			else if (
				source
				&& typeof source.uri === "string"
				&& typeof source.width === "number"
				&& typeof source.height === "number"
				&& typeof source.file === "string"
				&& source.allowIconTheming
			) {
				const [file, ...parent] = source.file
					.split("/")
					.reverse() as string[];
				const [ext, ...base] = file.split(".").reverse();

				asset = {
					httpServerLocation: `//_/external${parent[0] ? "/" : ""}${parent.reverse().join("/")}`,
					width: source.width,
					height: source.height,
					name: base.reverse().join("."),
					type: ext,
				};
			} // any other asset
			else if (typeof source === "number") {
				asset = getAssetByID(source) as any;
			}

			if (!asset?.httpServerLocation) return Image(props);

			const assetIconpackLocation = iconpack
				&& fixPath(
					[
						...asset.httpServerLocation.split("/").slice(2),
						`${asset.name}${iconpack.suffix}.${asset.type}`,
					].join("/"),
				);
			const useIconpack = assetIconpackLocation
				&& (tree.length ? tree.includes(assetIconpackLocation) : true);

			let overlay: any;
			if (
				plus.customOverlays
				&& !useIconpack
				&& typeof source === "number"
			) {
				overlay = getIconOverlay(plus, source, props.style);
				if (overlay) {
					if (overlay.replace) {
						props.source = getAssetIDByName(overlay.replace);
					}
					if (overlay.style) {
						props.style = [props.style, overlay.style];
					}
				}
			}

			if (plus.icons) {
				const tint = getIconTint(plus, source, asset.name);
				if (tint) {
					props.style = [
						props.style,
						{
							tintColor: tint,
						},
					];
				}
			}

			if (useIconpack) {
				props.source = {
					uri: iconpack.load + assetIconpackLocation,
					headers: {
						"cache-contorl": "public, max-age=3600",
					},
					width: asset.width,
					height: asset.height,
					original: props.source,
				};
			}

			const ret = Image(props);

			return overlay?.children
				? (
					<RN.View>
						{ret}
						{overlay.children}
					</RN.View>
				)
				: ret;
		};

		// Image is a plain function component now, so swap it out wherever an element gets created
		const swapImage = (args: any[]) => {
			// some elements get created with an undefined type, never turn those into PatchedImage
			if (!Image || args[0] !== Image) return;

			const swapped = args.slice();
			swapped[0] = PatchedImage;
			return swapped;
		};

		patches.push(
			before("jsx", jsxRuntime, swapImage),
			before("jsxs", jsxRuntime, swapImage),
			before("createElement", React, swapImage),
			() => {
				active = false;
			},
		);
	}
}
