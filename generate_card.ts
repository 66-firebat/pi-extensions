/**
 * Anki Card Generator — Uses the model to compact information into flashcard format. To be used with the apy python package to upload cards to the local anki database
 *
 * Usage:
 *   /generate-card                 Prepare AI-powered card generation
 *   /generate-card --num 3         Generate multiple cards (default: 1)
 *   /generate-card --tags tag1,tag2    Add multiple tags (comma-separated)
 *   /generate-card --tag tag1 tag2       Add multiple tags (space-separated)
 *
 * How it works:
 * 1. Captures the last user message and assistant response
 * 2. Sets up the editor with an anki generation prompt
 * 3. User presses Enter to submit
 * 4. The response is parsed and displayed
 *
 * Generated format:
 *   # Note
 *   tags: tag1, tag2
 *   ## Front
 *   Question
 *   ## Back
 *   Answer
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";

interface AnkiGenState {
	userMsg: string;
	assistantMsg: string;
	numCards: number;
	tags: string[];
	active: boolean;
	promptPrepared: boolean;
	pendingPrompt: string;
}

const state: AnkiGenState = {
	userMsg: "",
	assistantMsg: "",
	numCards: 1,
	tags: [],
	active: false,
	promptPrepared: false,
	pendingPrompt: "",
};

const ANKI_SYSTEM_PREFIX = `<anki_mode>
You are an expert at creating Anki flashcards. When the user asks you to create flashcards, you MUST follow this exact format:

# Note (must include this line)
tags: (add relevant tags) 
## Front
Question or prompt (end with ?)
## Back
Answer or explanation

Rules:
- Extract the KEY concepts worth memorizing
- Keep questions focused and specific  
- Answers should be complete but concise
- Generate exactly the number of cards requested
- Include relevant tags based on the topic
- Output ONLY the Anki cards, no preamble or explanation
- Separate multiple cards with a blank line
- Make questions natural (not just "What is X?")
</anki_mode>

`;

function extractTextContent(content: string | TextContent[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => "text" in block)
		.map((block) => block.text)
		.join("\n");
}

function parseArgs(args: string): { numCards: number; tags: string[] } {
	const result = { numCards: 1, tags: [] as string[] };
	const tokens = args.split(/\s+/).filter(Boolean);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--num" && i + 1 < tokens.length) {
			const num = parseInt(tokens[++i], 10);
			if (!isNaN(num) && num > 0 && num <= 10) {
				result.numCards = num;
			}
		} else if ((token === "--tags" || token === "--tag") && i + 1 < tokens.length) {
			// Collect all remaining tokens as tags (space-separated)
			// Also support comma-separated within each token
			const tagTokens = tokens.slice(i + 1).filter(t => !t.startsWith("--"));
			const allTags = tagTokens.join(" ").split(",").map((t: string) => t.trim()).filter(Boolean);
			result.tags = allTags;
			// Skip processed tag tokens
			i += tagTokens.length;
		}
	}

	return result;
}

function extractAnkiNotes(text: string): { front: string; back: string; raw: string }[] {
	const notes: { front: string; back: string; raw: string }[] = [];

	// Split by "# Note" markers
	const parts = text.split(/# Note\n?/).filter((p) => p.trim());

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		// Check for Front/Back sections
		const frontMatch = trimmed.match(/##\s*Front\s*\n([\s\S]*?)(?=##\s*Back|$)/i);
		const backMatch = trimmed.match(/##\s*Back\s*\n([\s\S]*?)$/i);

		if (frontMatch && backMatch) {
			const front = frontMatch[1].trim();
			const back = backMatch[1].trim();

			if (front && back) {
				notes.push({
					front,
					back,
					raw: `# Note\n${trimmed}`,
				});
			}
		}
	}

	return notes;
}

// Generates the anki note format. 
function formatNote(front: string, back: string, tags: string[]): string {
	const tagLine = tags.length > 0 ? `tags: ${tags.join(", ")}` : "";
	const tagSection = tagLine ? `\n${tagLine}` : "";

	return `# Note${tagSection}
## Front
${front}
## Back
${back}`;
}

export default function (pi: ExtensionAPI) {
	let systemPromptOverride: string | null = null;

	// Track messages for context
	pi.on("message_end", async (event) => {
		const message = event.message;

		if (message.role === "user") {
			state.userMsg = extractTextContent(message.content);
		} else if (message.role === "assistant") {
			state.assistantMsg = extractTextContent(message.content);

			// If we just generated anki cards, process the response
			if (state.active) {
				const responseText = state.assistantMsg;
				const notes = extractAnkiNotes(responseText);

				if (notes.length > 0) {
					const formattedNotes = notes.map((note) =>
						formatNote(note.front, note.back, state.tags)
					).join("\n\n");

					// Output to console
					// console.log("\n" + "-".repeat(60));
					// console.log("  ANKI CARDS (AI-GENERATED)");
					// console.log("-".repeat(60) + "\n");
					// console.log(formattedNotes);
					// console.log("\n" + "─".repeat(60));
					// console.log(`Generated ${notes.length} card(s)`);
					// console.log("─".repeat(60) + "\n");
				}

				state.active = false;
			}
		}
	});

	// Clear state on session start
	pi.on("session_start", async () => {
		state.userMsg = "";
		state.assistantMsg = "";
		state.active = false;
		state.promptPrepared = false;
		state.pendingPrompt = "";
		systemPromptOverride = null;
	});

	// Inject anki system prompt when generating
	pi.on("before_agent_start", async (event) => {
		if (systemPromptOverride) {
			const result = {
				systemPrompt: systemPromptOverride + event.systemPrompt,
			};
			systemPromptOverride = null;
			return result;
		}
		return;
	});

	// Intercept input to substitute the anki prompt
	pi.on("input", async (event) => {
		if (state.promptPrepared && state.pendingPrompt) {
			// Replace the user's input with our anki prompt
			state.promptPrepared = false;
			return {
				action: "transform" as const,
				text: state.pendingPrompt,
			};
		}
		return { action: "continue" as const };
	});

	// Register the command
	pi.registerCommand("generate-card", {
		description: "Generate Anki cards using AI from the last conversation",
		handler: async (args, ctx) => {
			const options = parseArgs(args || "");
			state.numCards = options.numCards;
			state.tags = options.tags;

			// Get context from last messages
			if (!state.userMsg && !state.assistantMsg) {
				ctx.ui.notify(
					"No conversation history. Have a discussion first, then run /generate-card",
					"warning"
				);
				return;
			}

			// Build the anki generation prompt
			const ankiPrompt = `Create ${state.numCards} Anki flashcard(s) based on this:

Output the card(s) in this exact Anki format, although you can change the content under the ## Back line to make it as concise as possible. If there are no explicit tags, simply ensure that the tags field is blank, do not add tags. Make sure you send the message back to me, instead of just thinking and stopping. CRITICAL: It is important that you only give one sentence/equation for a question:

# Note
tags: ${state.tags.join(" ") || ""}
## Front
${state.userMsg || "(no question)"}
## Back
${state.assistantMsg || "(no answer)"}

	`;



			// Set up state for the next input
			state.pendingPrompt = ankiPrompt;
			state.promptPrepared = true;
			state.active = true;
			// systemPromptOverride = "ANKI_SYSTEM_PREFIX";
			systemPromptOverride = "Do NOT write anything to the filesystem";

			// Set the editor text to show the prompt
			ctx.ui.setEditorText(ankiPrompt);

			ctx.ui.notify(
				"Press Enter to generate " + state.numCards + " Anki card(s)",
				"info"
			);
		},
	});
}
