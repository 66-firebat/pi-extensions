import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface SessionEntry {
	mtime: number;
	sizeBytes: number;
	displayDate: string;
	displaySize: string;
	filename: string;
	dirHint: string;
	shortHash: string;
}

function getShortHash(filename: string): string {
	// Filename pattern: <timestamp>_<uuid>.jsonl
	// Extract first 8 characters of the UUID portion
	const match = filename.match(/^[^_]+_([a-fA-F0-9]{8})/);
	return match ? match[1]! : "";
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}K`;
	return `${bytes}B`;
}

function formatDate(ts: number): string {
	const d = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function decodeSessionDir(dirname: string): string {
	// The session dir format is: --<cwd-with-slashes-replaced-by-dashes>--
	// where the leading / or \ was stripped first.
	// Decode by: strip --, replace dashes with /, prepend /
	let s = dirname.replace(/^--/, "").replace(/--$/, "");
	if (!s) return dirname;
	return "/" + s.replace(/-/g, "/");
}

function collectRecentSessions(sessionDir: string, count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	try {
		const subdirs = readdirSync(sessionDir, { withFileTypes: true });
		for (const sub of subdirs) {
			if (!sub.isDirectory()) continue;
			const subPath = join(sessionDir, sub.name);
			try {
				const files = readdirSync(subPath);
				for (const f of files) {
					if (!f.endsWith(".jsonl")) continue;
					const full = join(subPath, f);
					try {
						const stat = statSync(full);
						entries.push({
							mtime: stat.mtimeMs,
							sizeBytes: stat.size,
							displayDate: formatDate(stat.mtimeMs),
							displaySize: formatSize(stat.size),
							filename: f,
							dirHint: decodeSessionDir(sub.name),
							shortHash: getShortHash(f),
						});
					} catch {
						// skip unreadable files
					}
				}
			} catch {
				// skip unreadable dirs
			}
		}
	} catch {
		// session dir doesn't exist or is unreadable
	}

	entries.sort((a, b) => b.mtime - a.mtime);
	return entries.slice(0, count);
}

export default function sessionHistoryHeader(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		const agentDir =
			process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || "~", ".pi", "agent");
		const sessionDir = join(agentDir, "sessions");

		ctx.ui.setHeader((_tui: TUI, theme: Theme) => {
			let cached: SessionEntry[] = [];
			let lastRefresh = 0;

			const refresh = () => {
				const now = Date.now();
				// Forces the system to revisit the session save directory every 6 minutes
				if (now - lastRefresh > 360_000) {
					cached = collectRecentSessions(sessionDir, 6);
					lastRefresh = now;
				}
			};

			refresh();

			return {
				// The render frame runs every time the TUI updates, potentially several times a second
				render(): string[] {
					refresh();
					const lines: string[] = [""];

					if (cached.length === 0) {
						lines.push(theme.fg("dim", "  No recent sessions"));
						lines.push("");
						return lines;
					}

					const dateW = 12;
					const sizeW = 6;
					const hashW = 9;

					lines.push("  " + theme.fg("accent", "Recent Sessions"));

					// Column header — same field widths as data rows so they align
					const hdrDate = "DATE  TIME".padEnd(dateW);
					const hdrSize = "SIZE".padStart(sizeW);
					const hdrHash = "HASH".padEnd(hashW);
					lines.push(
						"  " +
							theme.fg("dim", hdrDate) +
							" " +
							theme.fg("dim", hdrSize) +
							" " +
							theme.fg("dim", hdrHash) +
							" " +
							theme.fg("dim", "QUERY_LOCATION"),
					);
					lines.push("  " + theme.fg("dim", "------------------------------------------------------------------------------------"));

					for (const s of cached) {
						const datePart = theme.fg("muted", s.displayDate.padEnd(dateW));
						const sizePart = theme.fg("dim", s.displaySize.padStart(sizeW));
						const hashPart = s.shortHash
							? theme.fg("muted", s.shortHash.padEnd(hashW))
							: "".padEnd(hashW + 1);
						const namePart = theme.fg("muted", s.dirHint);
						lines.push(`  ${datePart} ${sizePart} ${hashPart} ${namePart}`);
					}

					lines.push("");
					return lines;
				},
				dispose() {},
			};
		});
	});
}
