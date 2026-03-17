import { findByName } from "@vendetta/metro";
import { ReactNative as RN } from "@vendetta/metro/common";
import { before, instead } from "@vendetta/patcher";
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

export default function patchIcons(
	plus: PlusStructure,
	tree: string[],
	config: IconpackConfig,
) {
	const { iconpack } = state.iconpack;
	if (config.biggerStatus) {
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

		// FIXME the great component functionification of 2025
		// RN.Image may be a memo/forwardRef wrapper, so patch its inner render where possible.
		const DEBUG = false;
		const log = (...args: any[]) =>
			DEBUG && console.log("[Themes+][icons]", ...args);

		const findForwardRef = (t: any, depth = 0, seen = new Set<any>()): any => {
			if (!t || depth > 10 || seen.has(t)) return null;
			seen.add(t);
			if (typeof t === "object" && typeof t.render === "function") return t;
			if (typeof t === "object") {
				const inner = t.type ?? t.defaultProps?.type;
				return inner ? findForwardRef(inner, depth + 1, seen) : null;
			}
			return null;
		};

		const findMemoWithCallableType = (
			t: any,
			depth = 0,
			seen = new Set<any>(),
		): any => {
			if (!t || depth > 10 || seen.has(t)) return null;
			seen.add(t);
			if (typeof t === "object" && typeof t.type === "function") return t;
			if (typeof t === "object") {
				const inner = t.type ?? t.defaultProps?.type;
				return inner ? findMemoWithCallableType(inner, depth + 1, seen) : null;
			}
			return null;
		};

		const patchImage = (_args: any[], orig: (...args: any[]) => any) => {
			const args = _args.slice();
			const props = args[0];

			if (!props || props.ignore || props.vanilla) return orig(...args);

			const source = props.source;
			const resolvedSource = Array.isArray(source)
				? (source.find(x => x && typeof x === "object") ?? source.find(x => x != null))
				: source;
			if (!resolvedSource) return orig(...args);

			let asset: BunnyAsset | null = null;

			// theme mod icons (bunny, revenge)
			const modIcon = Object.entries(modIcons).find(
				([_, { raw }]) => resolvedSource?.uri === raw,
			);
			if (modIcon) {
				asset = {
					httpServerLocation: "//_",
					width: 64,
					height: 64,
					name: modIcon[0],
					type: "png",
				};
			} // custom themed icons API
			else if (
				resolvedSource
				&& typeof resolvedSource.uri === "string"
				&& typeof resolvedSource.width === "number"
				&& typeof resolvedSource.height === "number"
				&& typeof resolvedSource.file === "string"
				&& resolvedSource.allowIconTheming
			) {
				const [file, ...parent] = resolvedSource.file
					.split("/")
					.reverse() as string[];
				const [ext, ...base] = file.split(".").reverse();

				asset = {
					httpServerLocation: `//_/external${parent[0] ? "/" : ""}${parent.reverse().join("/")}`,
					width: resolvedSource.width,
					height: resolvedSource.height,
					name: base.reverse().join("."),
					type: ext,
				};
			} // any other asset
			else if (typeof resolvedSource === "number") {
				asset = getAssetByID(resolvedSource) as any;
			}

			if (!asset?.httpServerLocation) return orig(...args);

			const nextProps = { ...props };
			args[0] = nextProps;

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
				&& typeof resolvedSource === "number"
			) {
				overlay = getIconOverlay(plus, resolvedSource, nextProps.style);
				if (overlay) {
					if (overlay.replace) {
						nextProps.source = getAssetIDByName(overlay.replace);
					}
					if (overlay.style) {
						nextProps.style = [nextProps.style, overlay.style];
					}
				}
			}

			if (plus.icons) {
				const tint = getIconTint(plus, resolvedSource, asset.name);
				if (tint) {
					nextProps.style = [
						nextProps.style,
						{
							tintColor: tint,
						},
					];
				}
			}

			if (useIconpack) {
				const original = nextProps.source;
				nextProps.source = {
					uri: iconpack.load + assetIconpackLocation,
					headers: {
						"cache-contorl": "public, max-age=3600",
					},
					width: asset.width,
					height: asset.height,
					original,
				};
			}

			const ret = orig(...args);

			return overlay?.children
				? (
					<RN.View>
						{ret}
						{overlay.children}
					</RN.View>
				)
				: ret;
		};

		const imageType: any = RN.Image;
		const forwardRef = findForwardRef(imageType);
		if (forwardRef) {
			log("Patching RN.Image forwardRef.render");
			patches.push(instead("render", forwardRef, patchImage));
		} else {
			const memoWrapper = findMemoWithCallableType(imageType);
			if (memoWrapper) {
				log("Patching RN.Image memo.type");
				patches.push(instead("type", memoWrapper, patchImage));
			} else if (typeof imageType === "function") {
				log("Patching RN.Image directly");
				patches.push(instead("Image", RN, patchImage));
			} else {
				log("Unable to patch RN.Image", imageType);
			}
		}

	}
}
