import { React, ReactNative as RN } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";

import { lang } from "..";
import CustomTwemoji from "../components/CustomTwemoji";
import { getSrc, parse } from "./parser";

export default function() {
	const patches: (() => void)[] = [];

	// FIXME the great component functionification of 2025
	// RN.Image may be a memo/forwardRef wrapper, so patch its inner render where possible.
	const DEBUG = false;
	const log = (...args: any[]) =>
		DEBUG && console.log("[Twemoji Everywhere][patcher]", ...args);

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

	const getEmojiIdFromAssetUri = (uri: string) => {
		if (!uri.startsWith("asset:/emoji-")) return;

		const raw = uri.slice("asset:/emoji-".length).split("?")[0];
		const id = raw.replace(/\.[^\.]+$/, "");
		return id || undefined;
	};

	const mapEmojiSourceItem = (item: any) => {
		if (!item) return;

		if (typeof item === "number") {
			const resolved = (RN.Image as any)?.resolveAssetSource?.(item);
			if (!resolved || typeof resolved !== "object") return;

			const uri = (resolved as any).uri;
			if (typeof uri !== "string") return;

			const id = getEmojiIdFromAssetUri(uri);
			return id ? { ...resolved, uri: getSrc(id) } : undefined;
		}

		if (typeof item !== "object") return;

		const uri = (item as any).uri;
		if (typeof uri !== "string") return;

		const id = getEmojiIdFromAssetUri(uri);
		return id ? { ...item, uri: getSrc(id) } : undefined;
	};

	const mapEmojiSourceProp = (source: any) => {
		if (!source) return;

		if (Array.isArray(source)) {
			let didChange = false;
			const next = source.map((entry) => {
				const mapped = mapEmojiSourceItem(entry);
				if (!mapped) return entry;
				didChange = true;
				return mapped;
			});
			return didChange ? next : undefined;
		}

		return mapEmojiSourceItem(source);
	};

	const patchImageArgs = (args: any[]) => {
		const props = args[0];
		if (!props || props.vanilla) return;

		const nextSource = mapEmojiSourceProp(props.source);
		if (!nextSource) return;

		const nextArgs = args.slice();
		nextArgs[0] = { ...props, source: nextSource };
		return nextArgs;
	};

	const imageType: any = RN.Image;
	const forwardRef = findForwardRef(imageType);
	if (forwardRef) {
		log("Patching RN.Image forwardRef.render");
		patches.push(before("render", forwardRef, patchImageArgs));
	} else {
		const memoWrapper = findMemoWithCallableType(imageType);
		if (memoWrapper) {
			log("Patching RN.Image memo.type");
			patches.push(before("type", memoWrapper, patchImageArgs));
		} else if (typeof imageType === "function") {
			log("Patching RN.Image directly");
			patches.push(before("Image", RN, patchImageArgs));
		} else {
			log("Unable to patch RN.Image", imageType);
		}
	}

	patches.push(
		before("Text", RN, args => {
			const x = args[0];
			if (!x) return;

			let children: any[] = [];

			const style = RN.StyleSheet.flatten(x.style) ?? {};
			const twemoji = (src: string) =>
				React.createElement(CustomTwemoji, {
					emoji: src,
					size: style.fontSize,
				});

			if (Array.isArray(x.children)) {
				for (const c of x.children) {
					children.push(
						...(typeof c === "string" ? parse(c, twemoji) : [c]),
					);
				}
			} else {
				children = typeof x.children === "string"
					? parse(x.children, twemoji)
					: [x.children];
			}

			const nextArgs = args.slice();
			nextArgs[0] = { ...x, children };
			return nextArgs;
		}),
	);

	patches.push(lang.unload);

	return () => {
		for (const x of patches) {
			x();
		}
	};
}
