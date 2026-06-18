// Chat Markdown Export
// Exports a chosen VS Code chat session to a Markdown file in a "vschats"
// subfolder of the workspace root.
//
// VS Code does not expose a public API for reading chat session messages, so this
// extension reads the on-disk session journal that VS Code writes for the current
// workspace:  <globalStorage>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
//
// Each .jsonl file is an event journal:
//   {"kind":0,"v":{...}}            -> initial full snapshot of the session state
//   {"kind":1,"k":[path],"v":val}   -> set value at key-path
//   {"kind":2,"k":[path],"v":[...]} -> append items to the array at key-path
// We replay the journal to reconstruct the final session object, then render it.
//
// The command shows a picker of all sessions (newest first). VS Code records which
// session is "open" in the chat panel only after the view receives a real click, and
// no command an extension can call triggers that update — so we cannot reliably
// auto-detect a just-reopened session. Instead we read that recorded session from the
// workspace state DB (<hash>/state.vscdb, the memento key below) purely to mark and
// pre-select a best guess in the picker, so the common case is a single Enter.


const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Sub-folder (relative to the workspace root) where exported Markdown is written.
const OUTPUT_FOLDER = 'vschats';

// state.vscdb (ItemTable) key whose value records the chat session currently open
// in the Copilot panel. Its sessionResource.path is the base64-encoded session id.
const OPEN_SESSION_MEMENTO_KEY = 'memento/interactive-session-view-copilot';

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('chatMarkdownExport.exportActiveSession', () =>
			runExport(context)
		)
	);
}

function deactivate() {}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * @param {vscode.ExtensionContext} context
 */
async function runExport(context) {
	try {
		const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage(
				'Chat Markdown Export: open a folder or workspace first — the Markdown file is saved to a "' +
					OUTPUT_FOLDER +
					'" subfolder of the workspace root.'
			);
			return;
		}

		const sessionsDir = getChatSessionsDir(context);
		if (!sessionsDir || !fs.existsSync(sessionsDir)) {
			vscode.window.showErrorMessage('Chat Markdown Export: no chat sessions were found for this workspace.');
			return;
		}

		const sessions = listSessions(sessionsDir);
		if (sessions.length === 0) {
			vscode.window.showErrorMessage('Chat Markdown Export: no chat sessions were found for this workspace.');
			return;
		}

		// VS Code only records which session is "open" after the chat view receives a
		// real click, and nothing an extension can call triggers that update. So rather
		// than silently guess (and sometimes export the wrong session), we present a
		// picker with the best guess pre-selected: one Enter in the common case, or a
		// quick arrow-and-Enter when a different session was just reopened.
		const activeId = safeDetect(getStateDbPath(context));
		const chosen = await pickSession(sessions, activeId);
		if (!chosen) {
			return; // user cancelled
		}

		await exportSession(chosen, workspaceFolder);
	} catch (err) {
		const message = err && err.message ? err.message : String(err);
		vscode.window.showErrorMessage('Chat Markdown Export failed: ' + message);
	}
}

/**
 * @param {{ file: string, id: string, mtime: number }} session
 * @param {vscode.WorkspaceFolder} workspaceFolder
 */
async function exportSession(session, workspaceFolder) {
	const state = reconstructSession(session.file);
	if (!state) {
		vscode.window.showErrorMessage('Chat Markdown Export: could not read the selected chat session.');
		return;
	}

	const config = vscode.workspace.getConfiguration('chatMarkdownExport');
	const opts = {
		stats: { pendingTurns: 0, recoveredTurns: 0, interruptedTurns: 0, realignedTurns: 0 },
	};

	repairSessionForDisplay(state, opts.stats);

	// VS Code writes the chatSessions journal lazily and in request order, so the
	// most recent turns of an active session are often missing or truncated there.
	// The sibling Copilot transcript is updated more promptly, so we use it to
	// backfill any turn the journal has not finalized yet. Best-effort: if the
	// transcript is absent (e.g. a non-Copilot session) we keep the journal data.
	try {
		const transcriptFile = getTranscriptPath(session.file, session.id);
		if (transcriptFile && fs.existsSync(transcriptFile) && state && Array.isArray(state.requests)) {
			const turns = parseTranscriptTurns(transcriptFile);
			opts.stats.recoveredTurns = backfillFromTranscript(state.requests, turns);
		}
	} catch (_) {
		/* transcript backfill is best-effort; fall back to the journal alone */
	}

	const markdown = renderMarkdown(state, opts);

	// Write into a "vschats" subfolder of the workspace root, creating it if needed.
	const outputDir = vscode.Uri.joinPath(workspaceFolder.uri, OUTPUT_FOLDER);
	await vscode.workspace.fs.createDirectory(outputDir);

	const baseName = sanitizeFileName(sessionTitle(state));
	let target = vscode.Uri.joinPath(outputDir, baseName + '.md');
	if (!config.get('overwriteExisting', true)) {
		target = await uniqueUri(outputDir, baseName);
	}

	await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));

	const fileName = path.basename(target.fsPath);
	if (config.get('openAfterExport', true)) {
		const doc = await vscode.workspace.openTextDocument(target);
		await vscode.window.showTextDocument(doc, { preview: false });
	}
	vscode.window.showInformationMessage(
		'Chat Markdown Export: saved "' + fileName + '" to the ' + OUTPUT_FOLDER + ' folder.'
	);
	const recovered = opts.stats.recoveredTurns;
	const pending = opts.stats.pendingTurns;
	const interrupted = opts.stats.interruptedTurns;
	const realigned = opts.stats.realignedTurns;
	if (recovered > 0 || pending > 0 || interrupted > 0 || realigned > 0) {
		const notes = [];
		if (realigned > 0) {
			notes.push(
				'realigned ' + realigned + ' repl' + (realigned === 1 ? 'y' : 'ies')
				+ ' that VS Code had recorded under the wrong turn'
			);
		}
		if (recovered > 0) {
			notes.push(
				'recovered ' + recovered + ' recent turn' + (recovered === 1 ? '' : 's')
				+ ' from the live chat transcript'
			);
		}
		if (interrupted > 0) {
			notes.push(
				interrupted + ' turn' + (interrupted === 1 ? '' : 's') + ' had no recorded reply'
				+ ' (the request was interrupted or cancelled)'
			);
		}
		if (pending > 0) {
			notes.push(
				pending + ' turn' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are')
				+ ' still being written and may be blank or incomplete \u2014 re-export once the reply has finished'
			);
		}
		const summary = 'Chat Markdown Export: ' + notes.join('; ') + '.';
		if (pending > 0) {
			vscode.window.showWarningMessage(summary);
		} else {
			vscode.window.showInformationMessage(summary);
		}
	}
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace storage directory (the <hash> folder) from the extension's
 * own storage URI:  .../workspaceStorage/<hash>/<extensionId>  ->  .../<hash>
 * @param {vscode.ExtensionContext} context
 * @returns {string | undefined}
 */
function getWorkspaceStorageDir(context) {
	const storageUri = context.storageUri;
	if (!storageUri) {
		return undefined;
	}
	return path.dirname(storageUri.fsPath);
}

/**
 * Resolve the workspace-scoped chatSessions directory:  .../<hash>/chatSessions
 * @param {vscode.ExtensionContext} context
 * @returns {string | undefined}
 */
function getChatSessionsDir(context) {
	const hashDir = getWorkspaceStorageDir(context);
	return hashDir ? path.join(hashDir, 'chatSessions') : undefined;
}

/**
 * Resolve the workspace state database:  .../<hash>/state.vscdb
 * @param {vscode.ExtensionContext} context
 * @returns {string | undefined}
 */
function getStateDbPath(context) {
	const hashDir = getWorkspaceStorageDir(context);
	return hashDir ? path.join(hashDir, 'state.vscdb') : undefined;
}

/**
 * List session journals, newest first (by last-modified time).
 * @param {string} dir
 * @returns {{ file: string, id: string, mtime: number }[]}
 */
function listSessions(dir) {
	return fs
		.readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith('.jsonl'))
		.map((name) => {
			const file = path.join(dir, name);
			let mtime = 0;
			try {
				mtime = fs.statSync(file).mtimeMs;
			} catch (_) {
				/* ignore */
			}
			return { file, id: name.replace(/\.jsonl$/i, ''), mtime };
		})
		.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Show a picker of all sessions (newest first) and return the chosen one.
 * When `activeId` matches a session, that one is marked as currently active, moved
 * to the top, and highlighted by default so a single Enter exports it.
 * @param {{ file: string, id: string, mtime: number }[]} sessions newest-first
 * @param {string | null} [activeId] id of the session recorded as open, if known
 */
async function pickSession(sessions, activeId) {
	// Put the recorded-active session first (so it is the default highlight), keeping
	// the rest in newest-first order.
	const ordered = sessions.slice();
	if (activeId) {
		const i = ordered.findIndex((s) => s.id === activeId);
		if (i > 0) {
			ordered.unshift(ordered.splice(i, 1)[0]);
		}
	}

	const items = ordered.map((session, index) => {
		const state = reconstructSession(session.file);
		const title = state ? sessionTitle(state) : session.id;
		if (state) {
			repairSessionForDisplay(state);
		}
		const count = state && Array.isArray(state.requests) ? buildVisibleTurns(state.requests).length : 0;
		const isActive = activeId && session.id === activeId;
		const isNewest = index === 0 && !activeId;
		const marker = isActive ? '$(check) ' : isNewest ? '$(circle-filled) ' : '';
		const tag = isActive ? 'Active  ·  ' : index === 0 ? 'Most recent  ·  ' : '';
		return {
			label: marker + title,
			description: count + (count === 1 ? ' message' : ' messages'),
			detail: tag + 'Last modified ' + new Date(session.mtime).toLocaleString(),
			session,
		};
	});

	const choice = await vscode.window.showQuickPick(items, {
		title: 'Export Chat Session as Markdown',
		placeHolder: activeId
			? 'Press Enter to export the active session, or pick another'
			: 'Select a chat session to export',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	return choice && choice.session;
}

/**
 * Apply the same best-effort display repairs used by the Markdown export before
 * anything counts or renders visible turns.
 * @param {any} state reconstructed session (mutated in place)
 * @param {{ realignedTurns?: number }} [stats]
 */
function repairSessionForDisplay(state, stats) {
	// Before anything reads the reconstructed turns, first put generated continuation
	// replies where VS Code's own JSON export displays them, then repair replies VS Code
	// recorded against the wrong turn after a cancelled/aborted resend.
	// Best-effort: any failure leaves the journal data exactly as reconstructed.
	try {
		rehomeActiveRefinedReplies(state);
		rehomeGeneratedContinueReplies(state);
		const realignedTurns = reflowDisplacedReplies(state);
		if (stats) {
			stats.realignedTurns = realignedTurns;
		}
	} catch (_) {
		/* reply realignment is best-effort; fall back to the journal as-is */
	}
}

// ---------------------------------------------------------------------------
// Active-session detection
// ---------------------------------------------------------------------------

/**
 * detectOpenSessionId that never throws — used to highlight a best guess in the
 * picker. Note: VS Code records this only after the chat view receives a real
 * click, so a session reopened from history may not be reflected until then.
 * @param {string | undefined} stateDbPath
 * @returns {string | null}
 */
function safeDetect(stateDbPath) {
	try {
		return detectOpenSessionId(stateDbPath);
	} catch (_) {
		return null;
	}
}

/**
 * Best-effort id of the chat session currently open in the Copilot panel.
 * Tries a proper SQLite read first (reads the live b-tree, so it is always the
 * current value), then a dependency-free consensus byte scan, so it degrades
 * gracefully on runtimes without `node:sqlite`.
 * @param {string | undefined} stateDbPath
 * @returns {string | null}
 */
function detectOpenSessionId(stateDbPath) {
	if (!stateDbPath || !fs.existsSync(stateDbPath)) {
		return null;
	}
	try {
		const value = readStateValueViaSqlite(stateDbPath, OPEN_SESSION_MEMENTO_KEY);
		const id = sessionIdFromMemento(value);
		if (id) {
			return id;
		}
	} catch (_) {
		/* node:sqlite unavailable or DB locked — try the byte scan */
	}
	try {
		return consensusSessionIdViaScan(stateDbPath, OPEN_SESSION_MEMENTO_KEY);
	} catch (_) {
		return null;
	}
}

/**
 * Read a single ItemTable value using Node's built-in SQLite (experimental).
 * @param {string} stateDbPath
 * @param {string} key
 * @returns {string | null}
 */
function readStateValueViaSqlite(stateDbPath, key) {
	// Lazily required so the extension still loads where node:sqlite is absent.
	const { DatabaseSync } = require('node:sqlite');
	const db = new DatabaseSync(stateDbPath, { readOnly: true });
	try {
		const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
		if (!row || row.value == null) {
			return null;
		}
		return typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
	} finally {
		db.close();
	}
}

/**
 * Dependency-free fallback: scan the raw SQLite file for every readable copy of the
 * memento's session id and return it only if they all agree.
 *
 * state.vscdb retains stale copies of frequently-rewritten values in freelist pages
 * (the memento's inputText changes as you type). A first-match read could therefore
 * return an out-of-date session — dangerous right after switching sessions. Requiring
 * consensus means we never confidently return a stale id; ambiguity yields null so
 * the caller falls back to file mtime instead.
 * @param {string} stateDbPath
 * @param {string} key
 * @returns {string | null}
 */
function consensusSessionIdViaScan(stateDbPath, key) {
	const buf = fs.readFileSync(stateDbPath);
	const keyBuf = Buffer.from(key, 'utf8');
	const ids = new Set();
	let from = 0;
	for (;;) {
		const at = buf.indexOf(keyBuf, from);
		if (at === -1) {
			break;
		}
		const valueStart = at + keyBuf.length;
		const first = buf[valueStart];
		if (first === 0x7b /* { */ || first === 0x5b /* [ */) {
			const id = sessionIdFromMemento(extractJson(buf, valueStart));
			if (id) {
				ids.add(id);
			}
		}
		from = valueStart;
	}
	return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Extract a balanced JSON object/array (as text) starting at `start` in a buffer,
 * honouring string literals and escapes. Returns null if it never closes.
 * @param {Buffer} buf
 * @param {number} start
 * @returns {string | null}
 */
function extractJson(buf, start) {
	const open = buf[start];
	const close = open === 0x7b ? 0x7d : 0x5d;
	let depth = 0;
	let inString = false;
	let escaped = false;
	const limit = Math.min(buf.length, start + 1_000_000);
	for (let i = start; i < limit; i++) {
		const ch = buf[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === 0x5c /* \\ */) {
				escaped = true;
			} else if (ch === 0x22 /* " */) {
				inString = false;
			}
			continue;
		}
		if (ch === 0x22) {
			inString = true;
		} else if (ch === open) {
			depth++;
		} else if (ch === close) {
			depth--;
			if (depth === 0) {
				return buf.toString('utf8', start, i + 1);
			}
		}
	}
	return null;
}

/**
 * Pull the session id out of the open-session memento value.
 * The resource path is base64 of the session id, e.g. "/YWY5..." -> "af97009e-...".
 * @param {string | null} value
 * @returns {string | null}
 */
function sessionIdFromMemento(value) {
	if (!value) {
		return null;
	}
	let obj;
	try {
		obj = JSON.parse(value);
	} catch (_) {
		return null;
	}
	const resource = obj && obj.sessionResource;
	if (!resource) {
		return null;
	}
	let encoded = '';
	if (typeof resource.path === 'string' && resource.path) {
		encoded = resource.path.replace(/^\//, '');
	} else if (typeof resource.external === 'string') {
		const match = resource.external.match(/\/([^/]+)\/?$/);
		encoded = match ? match[1] : '';
	}
	if (!encoded) {
		return null;
	}
	let decoded;
	try {
		decoded = Buffer.from(encoded, 'base64').toString('utf8');
	} catch (_) {
		return null;
	}
	// Sanity check: session ids are uuid-like.
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)
		? decoded
		: null;
}

// ---------------------------------------------------------------------------
// Journal reconstruction
// ---------------------------------------------------------------------------

/**
 * Replay the JSONL journal into the final session state object.
 * @param {string} file
 * @returns {any | null}
 */
function reconstructSession(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (_) {
		return null;
	}

	let state = null;
	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		if (!line) {
			continue;
		}
		let op;
		try {
			op = JSON.parse(line);
		} catch (_) {
			continue; // skip a malformed/partial line rather than aborting
		}
		try {
			if (op.kind === 0) {
				state = op.v;
			} else if (op.kind === 1 && state) {
				setAtPath(state, op.k, op.v);
			} else if (op.kind === 2 && state) {
				tagDisplacedResponseParts(state, op.k, op.v);
				appendAtPath(state, op.k, op.v);
			}
		} catch (_) {
			// A single bad patch should not discard the whole reconstruction.
		}
	}
	return state;
}

function setAtPath(root, keyPath, value) {
	let node = root;
	for (let i = 0; i < keyPath.length - 1; i++) {
		node = node[keyPath[i]];
		if (node == null) {
			return;
		}
	}
	node[keyPath[keyPath.length - 1]] = value;
}

function appendAtPath(root, keyPath, items) {
	let node = root;
	for (let i = 0; i < keyPath.length; i++) {
		node = node[keyPath[i]];
		if (node == null) {
			return;
		}
	}
	if (Array.isArray(node) && Array.isArray(items)) {
		for (const item of items) {
			node.push(item);
		}
	}
}

/**
 * Flag response parts that VS Code appended onto the wrong turn. In a healthy session
 * the assistant's reply streams into the *current* (last) turn and is sealed with a
 * `result`; no more reply content arrives afterwards. But once a cancelled/aborted
 * resend shifts VS Code's write index, it keeps appending each later turn's reply onto
 * an *already-finalized earlier* turn while the genuine later turns stay blank. Such an
 * append is recognisable at replay time: the target turn already has a `result` and is
 * no longer the last request. We tag those parts (without moving them yet) so a later
 * pass can relocate them only when it is safe to do so.
 * @param {any} state reconstructed session so far
 * @param {(string|number)[]} keyPath append target path
 * @param {any[]} items parts being appended
 */
function tagDisplacedResponseParts(state, keyPath, items) {
	if (!Array.isArray(keyPath) || keyPath.length !== 3) {
		return;
	}
	if (keyPath[0] !== 'requests' || keyPath[2] !== 'response') {
		return;
	}
	if (!Array.isArray(items) || !state || !Array.isArray(state.requests)) {
		return;
	}
	const idx = keyPath[1];
	if (typeof idx !== 'number') {
		return;
	}
	const request = state.requests[idx];
	if (!request || !request.result || idx >= state.requests.length - 1) {
		return; // streaming into the live turn, or finalising the last turn: not displaced
	}
	for (const part of items) {
		if (part && typeof part === 'object') {
			part.__displacedFrom = idx;
		}
	}
}

// ---------------------------------------------------------------------------
// Transcript backfill
// ---------------------------------------------------------------------------
//
// The chatSessions journal is written lazily and in request order, so the latest
// turns of an active session are often unwritten or truncated. The GitHub Copilot
// Chat extension also keeps a structured transcript that VS Code updates promptly:
//   <hash>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl
// It is a JSONL event log; we use two event types:
//   {"type":"user.message","data":{"content":"..."}}
//   {"type":"assistant.message","data":{"content":"..."}}
// A turn is a user.message followed by the assistant.message parts up to the next
// user.message. We reconstruct those turns and, for any journal turn that is not
// finalized, splice in the matching transcript reply (matched by user text). The
// transcript can be missing some turns and is not index-aligned with the journal,
// so we align the two sequences from the end and match on prompt text.

/**
 * Resolve the Copilot transcript for a session from its journal path.
 * <hash>/chatSessions/<id>.jsonl -> <hash>/GitHub.copilot-chat/transcripts/<id>.jsonl
 * @param {string} journalFile
 * @param {string} sessionId
 * @returns {string}
 */
function getTranscriptPath(journalFile, sessionId) {
	const hashDir = path.dirname(path.dirname(journalFile));
	return path.join(hashDir, 'GitHub.copilot-chat', 'transcripts', sessionId + '.jsonl');
}

/** Collapse all runs of whitespace to single spaces and trim. */
function normWhitespace(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse a Copilot transcript into ordered turns: the user prompt and the
 * concatenated visible assistant reply for each.
 * @param {string} file
 * @returns {{ user: string, reply: string }[]}
 */
function parseTranscriptTurns(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (_) {
		return [];
	}
	const turns = [];
	let current = null;
	const commit = () => {
		if (current) {
			current.reply = current.parts.join('\n\n').trim();
			delete current.parts;
			turns.push(current);
		}
	};
	for (const line of raw.split(/\r?\n/)) {
		if (!line) {
			continue;
		}
		let ev;
		try {
			ev = JSON.parse(line);
		} catch (_) {
			continue; // skip a malformed/partial line
		}
		const data = ev && ev.data;
		if (ev.type === 'user.message') {
			commit();
			current = { user: normWhitespace(data && data.content), parts: [], reply: '' };
		} else if (ev.type === 'assistant.message' && current) {
			if (data && typeof data.content === 'string' && data.content.trim()) {
				current.parts.push(data.content.trim());
			}
		}
	}
	commit();
	return turns;
}

/**
 * Decide whether a journal prompt and a transcript prompt are the same turn.
 * Short prompts (e.g. "yes, please") must match exactly to avoid collisions;
 * longer prompts may match by prefix to tolerate wrapping/truncation differences.
 * @param {string} a
 * @param {string} b
 */
function userTextMatch(a, b) {
	if (!a || !b) {
		return false;
	}
	if (a === b) {
		return true;
	}
	if (Math.min(a.length, b.length) < 20) {
		return false;
	}
	return a.startsWith(b) || b.startsWith(a);
}

/**
 * Index of the first turn in the contiguous run of not-yet-finalized turns at the
 * very end of the session. VS Code writes results in request order, so this run is
 * exactly the "unwritten tail" we may need to recover. Interior turns that happen
 * to lack a `result` are older and already complete in the journal, so they are
 * deliberately excluded.
 * @param {any[]} requests journal requests, in order
 * @returns {number} an index in [0, requests.length]; equal to length when none pending
 */
function firstPendingTailIndex(requests) {
	if (!Array.isArray(requests)) {
		return 0;
	}
	let i = requests.length;
	while (i > 0 && !(requests[i - 1] && requests[i - 1].result)) {
		i--;
	}
	return i;
}

/**
 * Splice transcript replies into journal turns that VS Code has not finalized yet.
 * Aligns the two sequences from the end (the unwritten turns are always the most
 * recent ones) so duplicate short prompts still map to the correct reply. Mutates
 * `requests`, setting `__transcriptReply` on recovered turns. Returns the count.
 * @param {any[]} requests journal requests, in order
 * @param {{ user: string, reply: string }[]} turns transcript turns, in order
 * @returns {number}
 */
function backfillFromTranscript(requests, turns) {
	if (!Array.isArray(requests) || !turns.length) {
		return 0;
	}
	// Only the contiguous trailing run of unwritten turns is eligible for recovery;
	// bounding the scan there also prevents an old duplicate prompt from matching.
	const tailStart = firstPendingTailIndex(requests);
	if (tailStart >= requests.length) {
		return 0; // nothing pending
	}
	let recovered = 0;
	let ti = turns.length - 1;
	for (let ji = requests.length - 1; ji >= tailStart; ji--) {
		const req = requests[ji];
		const userText = normWhitespace(req && req.message && req.message.text);
		if (!userText) {
			continue;
		}
		let k = ti;
		while (k >= 0 && !userTextMatch(turns[k].user, userText)) {
			k--;
		}
		if (k < 0) {
			continue; // this journal turn is absent from the transcript; keep scanning
		}
		if (turns[k].reply && !req.__transcriptReply) {
			req.__transcriptReply = turns[k].reply;
			recovered++;
		}
		ti = k - 1; // consume this transcript turn and everything after it
	}
	return recovered;
}

/**
 * A same-text prompt immediately followed by another same-text prompt should only
 * collapse when the earlier request is the hidden superseded/empty send VS Code
 * does not show. Two completed identical prompts are legitimate separate turns.
 * @param {any} request
 */
function isSupersededOrEmpty(request) {
	const modelState = request && request.modelState;
	if (modelState && modelState.value === 3) {
		return true;
	}
	const response = request && Array.isArray(request.response) ? request.response : [];
	return !response.some(hasVisibleResponsePart);
}

/**
 * @param {any} part
 */
function hasVisibleResponsePart(part) {
	if (!part) {
		return false;
	}
	const kind = part.kind;
	if (kind === undefined || kind === null) {
		return typeof part.value === 'string' && part.value.trim().length > 0;
	}
	return kind === 'inlineReference'
		|| kind === 'toolInvocationSerialized'
		|| kind === 'toolInvocation'
		|| kind === 'textEditGroup'
		|| kind === 'notebookEditGroup'
		|| kind === 'warning';
}

/**
 * Whether a response has content the Markdown exporter can show directly. This is
 * narrower than hasVisibleResponsePart: operational tool/edit records are visible
 * in VS Code while work is happening, but they are not exported as chat prose.
 * @param {any} request
 */
function hasExportableResponseContent(request) {
	const response = request && Array.isArray(request.response) ? request.response : [];
	return response.some((part) => {
		if (!part) {
			return false;
		}
		const kind = part.kind;
		if (kind === undefined || kind === null) {
			return typeof part.value === 'string' && part.value.trim().length > 0;
		}
		return kind === 'inlineReference' || kind === 'warning';
	});
}

/**
 * @param {any} request
 * @returns {any[]}
 */
function primaryResponseParts(request) {
	const response = request && Array.isArray(request.response) ? request.response : [];
	return response.filter((part) => !(part && part.__displacedFrom !== undefined));
}

/**
 * @param {any} request
 * @returns {string}
 */
function primaryResponseBody(request) {
	return renderFinalResponse(primaryResponseParts(request));
}

/**
 * @param {any[]} parts
 * @returns {any[]}
 */
function finalResponseParts(parts) {
	if (!Array.isArray(parts)) {
		return [];
	}
	const finalStart = lastOperationalPartIndexBeforeFinalContent(parts) + 1;
	return parts.slice(finalStart);
}

/**
 * Render only the final visible prose block. Used for classification/reflow only;
 * the exported Markdown uses renderResponse so it preserves all visible fragments.
 * @param {any[]} parts
 * @returns {string}
 */
function renderFinalResponse(parts) {
	return renderResponse(finalResponseParts(parts), {});
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function promptTokens(value) {
	const tokens = String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
	return tokens || [];
}

/**
 * True when `nextText` is a refined resend of `prevText`, not a separate prompt.
 * The containment test catches same prompt + extra details while avoiding broad
 * prefix collapse for unrelated long prompts.
 * @param {string} prevText
 * @param {string} nextText
 */
function promptRefinesPrevious(prevText, nextText) {
	const prev = promptTokens(prevText);
	const next = promptTokens(nextText);
	if (prev.length < 12 || next.length < 12) {
		return false;
	}
	const prevSet = new Set(prev);
	const nextSet = new Set(next);
	let overlap = 0;
	for (const token of prevSet) {
		if (nextSet.has(token)) {
			overlap++;
		}
	}
	const containment = overlap / Math.min(prevSet.size, nextSet.size);
	return containment >= 0.92;
}

/**
 * @param {{ request: any, origIndex: number, text: string, isPendingTail: boolean }} prev
 * @param {any} request
 * @param {string} text
 * @param {boolean} isPendingTail
 */
function shouldReplacePreviousTurn(prev, request, text, isPendingTail) {
	if (!prev || prev.isPendingTail || isPendingTail || !text) {
		return false;
	}
	const prevRequest = prev.request;
	if (prevRequest && prevRequest.result && prevRequest.result.errorDetails && prevRequest.result.errorDetails.message) {
		return false; // keep explicit canceled turns visible
	}
	if (prev.text === text && isSupersededOrEmpty(prevRequest)) {
		return true;
	}
	if (!promptRefinesPrevious(prev.text, text)) {
		return false;
	}
	return !prevRequest || !prevRequest.result || !primaryResponseBody(prevRequest) || isSupersededOrEmpty(prevRequest);
}

/**
 * VS Code can keep the later/refined request id while displaying the response that
 * streamed under the earlier in-progress request. Preserve that display response
 * without overwriting the later request's own response, because a following
 * `@agent Continue` may still need to receive it.
 * @param {any} state reconstructed session (mutated in place)
 * @returns {number}
 */
function rehomeActiveRefinedReplies(state) {
	const requests = state && Array.isArray(state.requests) ? state.requests : null;
	if (!requests) {
		return 0;
	}
	let moved = 0;
	for (let i = 1; i < requests.length; i++) {
		const previous = requests[i - 1];
		const request = requests[i];
		const previousState = previous && previous.modelState ? previous.modelState.value : undefined;
		if (previousState !== 4) {
			continue;
		}
		const previousText = previous && previous.message && typeof previous.message.text === 'string' ? previous.message.text.trim() : '';
		const text = request && request.message && typeof request.message.text === 'string' ? request.message.text.trim() : '';
		if (!promptRefinesPrevious(previousText, text)) {
			continue;
		}
		const previousResponse = displayResponsePartsForActiveRefinement(previous);
		if (!previousResponse.length) {
			continue;
		}
		request.__displayResponseParts = previousResponse;
		previous.__hideFromVisible = true;
		moved++;
	}
	return moved;
}

/**
 * A refined prompt may keep the previous request's streamed response as its display
 * body. Keep that response plus the first late status prefix, but stop when the raw
 * journal starts replaying content that is already present in the display body.
 * @param {any} request
 * @returns {any[]}
 */
function displayResponsePartsForActiveRefinement(request) {
	const response = request && Array.isArray(request.response) ? request.response : [];
	const parts = [];
	let rendered = '';
	for (const part of response) {
		const isDisplaced = part && part.__displacedFrom !== undefined;
		const visible = renderResponse([part], {});
		if (isDisplaced && visible && visible.length >= 40 && textContainsNormalized(rendered, visible)) {
			break;
		}
		parts.push(part);
		if (visible) {
			rendered = renderResponse(parts, {});
		}
	}
	return parts;
}

/**
 * A trailing turn that has no `result` is either being generated right now or was
 * abandoned. VS Code records `modelState.value === 0` for a request whose reply was
 * interrupted/cancelled before the assistant responded — that turn will NEVER gain a
 * result, so telling the user to "re-export once it finishes" loops forever. An
 * actively-streaming turn instead carries `modelState.value === 4`. Only value 0 is
 * the terminal "aborted" state, so we key off it exactly and leave every other state
 * (4 in-progress, or anything unrecognized) on the existing wait-and-retry path.
 * @param {any} request
 */
function isAbortedUnfinalized(request) {
	const modelState = request && request.modelState;
	return !!(modelState && modelState.value === 0);
}

/**
 * @param {string} text
 */
function isGeneratedAgentContinue(text) {
	return /^@agent\s+Continue:\s*/i.test(text || '');
}

/**
 * Reduce the raw journal to the turns VS Code actually shows, dropping hidden
 * artifacts so the export matches the UI:
 *   1. Interior requests with no `result` are usually aborted/superseded attempts
 *      (the user resent, or VS Code cancelled them). Keep them only when they carry
 *      exportable response text, because VS Code can show those in chat history even
 *      without a final result marker. The live trailing run is also result-less but
 *      is kept, since that is the in-progress tail we may backfill.
 *   2. Internal continuation prompts (`@agent Continue: ...`) are VS Code agent
 *      control messages, not user-visible chat turns; their assistant response is
 *      merged into the previous visible turn because VS Code displays it there.
 *   3. A superseded/empty request immediately followed by another carrying identical
 *      prompt text is a re-send; only the later (final) one is kept.
 * @param {any[]} requests journal requests, in order
 * @returns {any[]} visible turns: { request, origIndex, text, isPendingTail, continuations? }
 */
function buildVisibleTurns(requests) {
	// Turns in the contiguous trailing run lack a `result` because VS Code has not
	// written them yet; only those are treated as pending/recoverable below.
	const tailStart = firstPendingTailIndex(requests);
	const visible = [];
	for (let i = 0; i < requests.length; i++) {
		const request = requests[i];
		if (!request) {
			continue;
		}
		if (request.__hideFromVisible) {
			continue;
		}
		const isPendingTail = i >= tailStart;
		if (!isPendingTail && !request.result && (isSupersededOrEmpty(request) || !hasExportableResponseContent(request))) {
			continue; // interior aborted/superseded attempt — hidden by VS Code
		}
		const text = request.message && typeof request.message.text === 'string' ? request.message.text.trim() : '';
		const prev = visible.length ? visible[visible.length - 1] : null;
		if (prev && prev.origIndex === i - 1 && shouldReplacePreviousTurn(prev, request, text, isPendingTail)) {
			visible[visible.length - 1] = { request, origIndex: i, text, isPendingTail }; // regeneration wins
			continue;
		}
		visible.push({ request, origIndex: i, text, isPendingTail });
	}
	return visible;
}

/**
 * Whether a visible turn already carries a reply of its own — primary (non-displaced)
 * response content, or a reply recovered from the transcript. Turns that fail this are
 * the blank slots a displaced reply can be moved back onto.
 * @param {{ request: any, continuations?: { request: any }[] }} turn
 * @returns {boolean}
 */
function turnHasOwnReply(turn) {
	const has = (request) => {
		if (!request) {
			return false;
		}
		if (typeof request.__transcriptReply === 'string' && request.__transcriptReply.trim()) {
			return true;
		}
		const response = responsePartsForRequest(request);
		return response.some((p) => p && p.__displacedFrom === undefined && hasVisibleResponsePart(p));
	};
	if (has(turn && turn.request)) {
		return true;
	}
	for (const c of (turn && turn.continuations) || []) {
		if (has(c && c.request)) {
			return true;
		}
	}
	return false;
}

/**
 * VS Code's built-in chat JSON export keeps generated `@agent Continue` prompts as
 * visible user turns. In the journal, the final answer for that continue can remain
 * attached to the immediately preceding user request, while the continue request
 * later receives displaced content for a following turn. Move the previous answer
 * onto the continue request so the display order matches VS Code's export model.
 * @param {any} state reconstructed session (mutated in place)
 * @returns {number}
 */
function rehomeGeneratedContinueReplies(state) {
	const requests = state && Array.isArray(state.requests) ? state.requests : null;
	if (!requests) {
		return 0;
	}
	let moved = 0;
	for (let i = 1; i < requests.length; i++) {
		const request = requests[i];
		const text = request && request.message && typeof request.message.text === 'string' ? request.message.text.trim() : '';
		if (!isGeneratedAgentContinue(text)) {
			continue;
		}
		const previous = requests[i - 1];
		const previousResponse = previous && Array.isArray(previous.response) ? previous.response : [];
		if (!previousResponse.length || !renderResponse(previousResponse, {})) {
			continue;
		}
		const currentResponse = Array.isArray(request.response) ? request.response : [];
		const currentPrefix = leadingPrimaryResponsePartsForContinue(request);
		const displaced = currentResponse.filter((part) => part && part.__displacedFrom !== undefined);
		for (const part of previousResponse) {
			if (part && typeof part === 'object') {
				delete part.__displacedFrom;
			}
		}
		request.response = currentPrefix.concat(previousResponse, displaced);
		previous.response = [];
		previous.__responseMovedToContinue = true;
		moved++;
	}
	return moved;
}

/**
 * Generated continue turns can have a small status prefix of their own before VS Code
 * displays the previous request's final text under the continue id. Stop that prefix
 * once a mutating tool has completed and the next visible prose begins.
 * @param {any} request
 * @returns {any[]}
 */
function leadingPrimaryResponsePartsForContinue(request) {
	const response = request && Array.isArray(request.response) ? request.response : [];
	const parts = [];
	let sawVisible = false;
	let sawCompletionBoundary = false;
	for (const part of response) {
		if (part && part.__displacedFrom !== undefined) {
			break;
		}
		const visible = renderResponse([part], {});
		if (visible && sawVisible && sawCompletionBoundary) {
			break;
		}
		parts.push(part);
		if (visible) {
			sawVisible = true;
		}
		if (isMutatingToolInvocation(part)) {
			sawCompletionBoundary = true;
		}
	}
	return parts;
}

/**
 * @param {any} part
 */
function isMutatingToolInvocation(part) {
	if (!part || !(part.kind === 'toolInvocationSerialized' || part.kind === 'toolInvocation')) {
		return false;
	}
	const id = String(part.toolId || '');
	return id === 'copilot_replaceString'
		|| id === 'copilot_insertEditIntoFile'
		|| id === 'copilot_createFile'
		|| id === 'copilot_createFileAtLocation'
		|| id === 'copilot_editFile';
}

/**
 * Repair the rare case where VS Code routed late-finalized replies onto the wrong
 * turns. After a cancelled/aborted resend, VS Code's journal writer can keep appending
 * each subsequent reply onto an already-finalized earlier turn (see
 * tagDisplacedResponseParts), leaving the genuine later turns blank. When the number of
 * displaced reply blocks exactly equals the number of blank answerable turns, each
 * block is moved — in order — back onto the turn it belongs to. Anything less certain
 * is left untouched, so healthy sessions are never altered.
 * @param {any} state reconstructed session (mutated in place)
 * @returns {number} number of replies relocated
 */
function reflowDisplacedReplies(state) {
	const requests = state && Array.isArray(state.requests) ? state.requests : null;
	if (!requests) {
		return 0;
	}
	// Group displaced parts by the (wrong) turn they were appended to, in turn order.
	const blocks = [];
	const byIndex = new Map();
	for (let i = 0; i < requests.length; i++) {
		const response = requests[i] && requests[i].response;
		if (!Array.isArray(response)) {
			continue;
		}
		for (const part of response) {
			if (part && part.__displacedFrom === i) {
				let block = byIndex.get(i);
				if (!block) {
					block = { sourceIndex: i, parts: [], hasMd: false };
					byIndex.set(i, block);
					blocks.push(block);
				}
				block.parts.push(part);
				if ((part.kind === undefined || part.kind === null) && typeof part.value === 'string' && part.value.trim()) {
					block.hasMd = true;
				}
			}
		}
	}
	for (const block of blocks) {
		block.body = renderFinalResponse(block.parts);
		block.fullBody = renderResponse(block.parts, {});
	}
	// Only blocks that render to visible prose are genuine relocated answers.
	const answerBlocks = blocks.filter((b) => b.body && !/^\s*```[\w-]*\s*$/.test(b.body));
	if (!answerBlocks.length) {
		return 0;
	}

	// Blank answerable turns, in display order, that have no reply of their own.
	const visible = buildVisibleTurns(requests);
	const lastVisible = visible.length ? visible[visible.length - 1] : null;
	const holes = [];
	for (const turn of visible) {
		const request = turn.request;
		// Canceled turns intentionally have no reply (they render a Canceled marker).
		if (request && request.result && request.result.errorDetails && request.result.errorDetails.message) {
			continue;
		}
		if (request && request.__responseMovedToContinue) {
			continue;
		}
		// The actively-streaming last turn is not a hole; it is still being written.
		if (turn === lastVisible && turn.isPendingTail && !isAbortedUnfinalized(request)) {
			continue;
		}
		if (request && request.result && turnHasOwnReply(turn)) {
			continue;
		}
		holes.push(turn);
	}

	// Only act when the two sequences line up one-to-one; otherwise stay out of the way.
	if (!holes.length || holes.length !== answerBlocks.length) {
		return 0;
	}

	// Both sequences are in ascending turn order. A genuine desync always recorded a
	// reply EARLIER than the turn it belongs to, so every block must map to a turn at or
	// after its source. A block that maps to its own turn is a harmless late flush (the
	// turn's real reply, just written after a later turn was created); a block that maps
	// to an EARLIER turn is not this pattern at all, so we bail rather than guess.
	let genuine = 0;
	for (let i = 0; i < holes.length; i++) {
		if (holes[i].origIndex < answerBlocks[i].sourceIndex) {
			return 0;
		}
		if (holes[i].origIndex !== answerBlocks[i].sourceIndex) {
			genuine++;
		}
	}
	if (genuine === 0) {
		return 0; // every block already sits on its own turn: nothing to relocate
	}

	for (let i = 0; i < holes.length; i++) {
		const currentBody = renderResponseForTurn(holes[i], {});
		answerBlocks[i].alreadyPresent = textContainsNormalized(currentBody, answerBlocks[i].fullBody);
		answerBlocks[i].mergedBody = answerBlocks[i].alreadyPresent ? '' : mergeOverlappingText(currentBody, answerBlocks[i].fullBody);
	}

	// Detach every displaced part from its wrong turn first, then re-home the blocks, so
	// a turn that is both a source and a destination is handled cleanly.
	for (let i = 0; i < requests.length; i++) {
		const request = requests[i];
		if (request && Array.isArray(request.response)) {
			request.response = request.response.filter((p) => !(p && p.__displacedFrom === i));
		}
	}
	for (let i = 0; i < holes.length; i++) {
		if (answerBlocks[i].alreadyPresent) {
			continue;
		}
		const request = holes[i].request;
		if (answerBlocks[i].mergedBody) {
			request.response = [{ value: answerBlocks[i].mergedBody }];
			continue;
		}
		if (!request.result) {
			request.response = [];
		} else if (!Array.isArray(request.response)) {
			request.response = [];
		}
		for (const part of answerBlocks[i].parts) {
			if (part && typeof part === 'object') {
				delete part.__displacedFrom;
			}
			request.response.push(part);
		}
	}
	return genuine;
}

/**
 * @param {string} haystack
 * @param {string} needle
 */
function textContainsNormalized(haystack, needle) {
	const h = String(haystack || '').replace(/\s+/g, ' ').trim();
	const n = String(needle || '').replace(/\s+/g, ' ').trim();
	return !!n && h.includes(n);
}

/**
 * @param {string} first
 * @param {string} second
 */
function mergeOverlappingText(first, second) {
	const a = String(first || '').trim();
	const b = String(second || '').trim();
	if (!a) {
		return b;
	}
	if (!b || a.includes(b)) {
		return a;
	}
	if (b.includes(a)) {
		return b;
	}
	const max = Math.min(a.length, b.length);
	for (let len = max; len >= 40; len--) {
		if (a.endsWith(b.slice(0, len))) {
			return (a + b.slice(len)).trim();
		}
	}
	return '';
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * @param {any} state
 * @param {{ stats?: { pendingTurns: number, recoveredTurns: number } }} opts
 */
function renderMarkdown(state, opts) {
	const requests = Array.isArray(state.requests) ? state.requests : [];
	const responder = state.responderUsername || 'Assistant';
	const visible = buildVisibleTurns(requests);

	const out = [];

	out.push('# ' + sessionTitle(state));
	out.push('');
	out.push('- **Session ID:** ' + (state.sessionId || 'unknown'));
	out.push('- **Exported:** ' + new Date().toISOString());
	const model = modelName(state);
	if (model) {
		out.push('- **Model:** ' + model);
	}
	out.push('- **Messages:** ' + visible.length);
	out.push('');
	out.push('---');
	out.push('');

	for (const turn of visible) {
		const request = turn.request;
		const isPendingTail = turn.isPendingTail;
		const userText = turn.text;
		out.push('### User');
		out.push('');
		out.push(userText || '_(empty message)_');
		out.push('');

		out.push('### ' + responder);
		out.push('');
		let body = renderResponseForTurn(turn, opts);
		if (request && request.result && request.result.errorDetails && request.result.errorDetails.message) {
			const note = '> [!WARNING] ' + String(request.result.errorDetails.message).replace(/\n/g, ' ');
			body = body ? body + '\n\n' + note : note;
		}
		// VS Code writes the chatSessions journal lazily and in request order, so the
		// trailing run of turns is often unwritten or truncated there. For those we
		// prefer a reply recovered from the live Copilot transcript (see
		// backfillFromTranscript), and otherwise flag the turn so a partial or blank
		// reply is never shown as final. Earlier turns always render from the journal.
		if (!isPendingTail) {
			out.push(body || '_(no response captured)_');
		} else {
			// Unfinalized trailing turn. VS Code writes the journal lazily, so the
			// newest turns can be empty or partial on disk. Two very different cases
			// live here and must be told apart, because their advice is opposite:
			//   * actively generating (modelState.value === 4): the reply is streaming
			//     right now, so waiting and re-exporting WILL complete it.
			//   * aborted/abandoned (modelState.value === 0): the assistant reply was
			//     interrupted or cancelled and will NEVER arrive, so "re-export once it
			//     finishes" can never be satisfied — that is the stuck-warning bug.
			const transcriptReply = transcriptReplyForTurn(turn);
			let chosen = body;
			let recovered = false;
			if (transcriptReply && (!body || transcriptReply.length > body.length)) {
				chosen = transcriptReply;
				recovered = true;
			}
			const aborted = isAbortedUnfinalized(request);
			const liveLastTurn = !aborted && turn === visible[visible.length - 1];
			if (chosen) {
				out.push(chosen);
				if (recovered) {
					out.push('');
					out.push('> [!NOTE] Recovered from the live chat transcript \u2014 VS Code had not yet written this turn to the session journal.');
				} else if (liveLastTurn) {
					if (opts && opts.stats) {
						opts.stats.pendingTurns += 1;
					}
					out.push('');
					out.push('> [!WARNING] This reply was still being written when the chat was exported, so it may be incomplete. Re-export once the response has finished.');
				}
				// Otherwise this is partial content from an interrupted turn: show what
				// was captured as-is, with no "re-export" nag (the reply never finished).
			} else if (liveLastTurn) {
				if (opts && opts.stats) {
					opts.stats.pendingTurns += 1;
				}
				out.push('_(response not yet captured \u2014 VS Code is still writing this turn; re-export once the reply has finished)_');
			} else {
				if (opts && opts.stats) {
					opts.stats.interruptedTurns = (opts.stats.interruptedTurns || 0) + 1;
				}
				out.push('_(no reply recorded \u2014 this request was interrupted or cancelled before the assistant responded)_');
			}
		}
		out.push('');
		out.push('---');
		out.push('');
	}

	return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

/**
 * @param {any} request
 * @returns {any[]}
 */
function responsePartsForRequest(request) {
	if (request && Array.isArray(request.__displayResponseParts)) {
		return request.__displayResponseParts;
	}
	return request && Array.isArray(request.response) ? request.response : [];
}

/**
 * @param {{ request: any, continuations?: { request: any }[] }} turn
 * @returns {any[]}
 */
function responsePartsForTurn(turn) {
	const parts = [];
	const add = (request) => {
		parts.push(...responsePartsForRequest(request));
	};
	add(turn && turn.request);
	for (const continuation of (turn && turn.continuations) || []) {
		add(continuation && continuation.request);
	}
	return parts;
}

/**
 * Render the main request and each generated continuation independently, then join
 * the visible chunks. Running one combined response through renderResponse lets a
 * later continuation's tool/edit records hide prose from the earlier request.
 * @param {{ request: any, continuations?: { request: any }[] }} turn
 * @param {any} opts
 * @returns {string}
 */
function renderResponseForTurn(turn, opts) {
	const blocks = [];
	const add = (request) => {
		const body = renderResponse(responsePartsForRequest(request), opts);
		if (body) {
			blocks.push(body);
		}
	};
	add(turn && turn.request);
	for (const continuation of (turn && turn.continuations) || []) {
		add(continuation && continuation.request);
	}
	return blocks.join('\n\n').trim();
}

/**
 * @param {{ request: any, continuations?: { request: any }[] }} turn
 * @returns {string}
 */
function transcriptReplyForTurn(turn) {
	let best = '';
	const consider = (request) => {
		const reply = request && typeof request.__transcriptReply === 'string' ? request.__transcriptReply : '';
		if (reply.length > best.length) {
			best = reply;
		}
	};
	consider(turn && turn.request);
	for (const continuation of (turn && turn.continuations) || []) {
		consider(continuation && continuation.request);
	}
	return best;
}

/**
 * Render an array of response parts to Markdown.
 *
 * Markdown parts are sometimes serialized as progressive snapshots, where a later
 * part is a prefix-superset of an earlier one. We therefore coalesce consecutive
 * markdown parts using a prefix test instead of blindly concatenating them.
 *
 * @param {any[]} parts
 * @param {any} _opts
 */
function renderResponse(parts, _opts) {
	// VS Code serializes each tool invocation twice: once when the call completes and
	// again after it generates a short title for it (the second copy carries an extra
	// `generatedTitle`). Both share the same `toolCallId`, so the journal — and thus a
	// naive replay — sees every tool block duplicated. Keep only the first occurrence
	// of each `toolCallId`; genuinely distinct calls (even repeated reads of the same
	// file) have different ids and are preserved.
	if (Array.isArray(parts)) {
		const seenToolCalls = new Set();
		parts = parts.filter((p) => {
			if (p && (p.kind === 'toolInvocationSerialized' || p.kind === 'toolInvocation') && p.toolCallId) {
				if (seenToolCalls.has(p.toolCallId)) {
					return false;
				}
				seenToolCalls.add(p.toolCallId);
			}
			return true;
		});
	}

	const blocks = [];
	let mdBuffer = null; // accumulated visible markdown (including inline references)
	// Raw text of the most recent markdown part. Consecutive markdown parts are
	// progressive snapshots of one streamed block (each a prefix-superset of the part
	// just before it); tracking the last one lets us collapse them into the longest
	// instead of concatenating. Any non-markdown part ends the run and clears this.
	let lastMd = null;

	const flushMarkdown = () => {
		if (mdBuffer != null) {
			const text = mdBuffer.trim();
			if (text) {
				blocks.push(text);
			}
			mdBuffer = null;
		}
		lastMd = null;
	};
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const kind = part && part.kind;
		if (isOperationalResponsePart(part)) {
			flushMarkdown();
			continue;
		}

		if (kind === undefined || kind === null) {
			// Markdown content. Collapse against the immediately preceding markdown part
			// (not the whole buffer, which may already hold earlier text and references)
			// so progressive snapshots extend in place instead of duplicating.
			if (typeof part.value === 'string') {
				if (isOperationalFenceWrapper(parts, i)) {
					flushMarkdown();
					continue;
				}
				const v = part.value;
				const inRun = lastMd != null && mdBuffer != null && mdBuffer.endsWith(lastMd);
				if (inRun && v.startsWith(lastMd)) {
					mdBuffer = mdBuffer.slice(0, mdBuffer.length - lastMd.length) + v; // extend in place
					lastMd = v;
				} else if (inRun && lastMd.startsWith(v)) {
					// An earlier/shorter snapshot of the same block — already represented.
				} else {
					mdBuffer = (mdBuffer == null ? '' : mdBuffer) + v;
					lastMd = v;
				}
			}
		} else if (kind === 'thinking') {
			// Internal reasoning is not part of the visible chat transcript. Treat it as a
			// boundary for streamed markdown snapshots, but do not export its contents.
			flushMarkdown();
		} else if (kind === 'inlineReference') {
			// Inline file/symbol reference — stays inside the markdown flow but ends the
			// current progressive-snapshot run.
			const name = referenceName(part);
			mdBuffer = (mdBuffer == null ? '' : mdBuffer) + '`' + name + '`';
			lastMd = null;
		} else if (kind === 'warning') {
			flushMarkdown();
			blocks.push('> [!WARNING] ' + collapse(markdownText(part.content)));
		}
		// All other kinds are internal or operational and skipped.
	}

	flushMarkdown();
	return blocks.join('\n\n').trim();
}

/**
 * VS Code wraps hidden edit/codeblock payloads with standalone markdown fences.
 * Once those operational payloads are removed, the wrapper fences would turn
 * ordinary prose into a broken code block, so suppress only fence-only chunks
 * adjacent to operational response parts.
 * @param {any[]} parts
 * @param {number} index
 */
function isOperationalFenceWrapper(parts, index) {
	const part = parts[index];
	if (!isFenceOnlyMarkdownPart(part)) {
		return false;
	}
	return isOperationalResponsePart(parts[index - 1]) || isOperationalResponsePart(parts[index + 1]);
}

/**
 * @param {any} part
 */
function isFenceOnlyMarkdownPart(part) {
	if (!part || !(part.kind === undefined || part.kind === null) || typeof part.value !== 'string') {
		return false;
	}
	return /^\s*(?:```[\w-]*\s*)+$/.test(part.value);
}

/**
 * @param {any[]} parts
 */
function lastOperationalPartIndexBeforeFinalContent(parts) {
	if (!Array.isArray(parts)) {
		return -1;
	}
	const finalContentIndex = lastVisibleTranscriptPartIndex(parts);
	const end = finalContentIndex >= 0 ? finalContentIndex - 1 : parts.length - 1;
	for (let i = end; i >= 0; i--) {
		if (isOperationalResponsePart(parts[i])) {
			return i;
		}
	}
	return -1;
}

/**
 * @param {any[]} parts
 */
function lastVisibleTranscriptPartIndex(parts) {
	if (!Array.isArray(parts)) {
		return -1;
	}
	for (let i = parts.length - 1; i >= 0; i--) {
		if (isVisibleTranscriptPart(parts[i])) {
			return i;
		}
	}
	return -1;
}

/**
 * @param {any} part
 */
function isVisibleTranscriptPart(part) {
	if (!part) {
		return false;
	}
	const kind = part.kind;
	if (kind === undefined || kind === null) {
		return typeof part.value === 'string' && part.value.trim().length > 0;
	}
	return kind === 'inlineReference' || kind === 'warning';
}

/**
 * Tool calls, edit groups, command buttons, and internal progress markers are useful
 * while the agent is working, but they are not chat transcript content.
 * @param {any} part
 */
function isOperationalResponsePart(part) {
	if (!part) {
		return false;
	}
	const kind = part.kind;
	return kind === 'toolInvocationSerialized'
		|| kind === 'toolInvocation'
		|| kind === 'textEditGroup'
		|| kind === 'notebookEditGroup'
		|| kind === 'progressTaskSerialized'
		|| kind === 'progressMessage'
		|| kind === 'mcpServersStarting'
		|| kind === 'undoStop'
		|| kind === 'codeblockUri';
}

/**
 * Combine a streamed value with the accumulated buffer, handling progressive
 * snapshots: if one string is a prefix of the other, keep the longer one;
 * otherwise treat it as a genuinely new chunk and concatenate.
 */
function mergeProgressive(current, value) {
	if (current == null) {
		return value;
	}
	if (value.startsWith(current)) {
		return value; // progressive extension of the same block
	}
	if (current.startsWith(value)) {
		return current; // shorter/earlier snapshot, ignore
	}
	return current + value; // new adjacent chunk
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sessionTitle(state) {
	if (state && typeof state.customTitle === 'string' && state.customTitle.trim()) {
		return state.customTitle.trim();
	}
	const requests = state && Array.isArray(state.requests) ? state.requests : [];
	if (requests.length && requests[0].message && typeof requests[0].message.text === 'string') {
		const firstLine = fallbackTitleText(requests[0].message.text);
		if (firstLine) {
			return firstLine.length > 60 ? firstLine.slice(0, 60).trim() : firstLine;
		}
	}
	return (state && state.sessionId) || 'chat-session';
}

function fallbackTitleText(text) {
	return String(text || '')
		.split(/\r?\n/)[0]
		.replace(/^[^\p{L}\p{N}]+/u, '')
		.trim();
}

function modelName(state) {
	const selected = state && state.inputState && state.inputState.selectedModel;
	if (selected && selected.metadata && typeof selected.metadata.name === 'string') {
		return selected.metadata.name;
	}
	const requests = state && Array.isArray(state.requests) ? state.requests : [];
	for (const request of requests) {
		if (request && typeof request.modelId === 'string' && request.modelId) {
			return request.modelId;
		}
	}
	return '';
}

function referenceName(part) {
	if (part && typeof part.name === 'string' && part.name) {
		return part.name;
	}
	const base = basenameOf(part && part.inlineReference);
	return base || 'reference';
}

function basenameOf(uriLike) {
	if (!uriLike) {
		return '';
	}
	let p = '';
	if (typeof uriLike === 'string') {
		p = uriLike;
	} else if (typeof uriLike.fsPath === 'string') {
		p = uriLike.fsPath;
	} else if (typeof uriLike.path === 'string') {
		p = uriLike.path;
	} else if (uriLike.uri) {
		p = uriLike.uri.fsPath || uriLike.uri.path || '';
	}
	if (!p) {
		return '';
	}
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

function markdownText(value) {
	if (!value) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value.value === 'string') {
		return value.value;
	}
	return '';
}

function collapse(text) {
	return String(text || '').replace(/\s*\n\s*/g, ' ').trim();
}

function sanitizeFileName(name) {
	let safe = String(name || 'chat-session')
		.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[^\p{L}\p{N}]+/u, '')
		.trim()
		.replace(/[.\s]+$/, ''); // Windows: no trailing dot/space
	if (!safe) {
		safe = 'chat-session';
	}
	return safe.slice(0, 120).trim() || 'chat-session';
}

/**
 * Return a URI that does not yet exist, appending " (n)" when needed.
 * @param {vscode.Uri} folder
 * @param {string} baseName
 */
async function uniqueUri(folder, baseName) {
	let candidate = vscode.Uri.joinPath(folder, baseName + '.md');
	let counter = 2;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			await vscode.workspace.fs.stat(candidate);
		} catch (_) {
			return candidate; // does not exist
		}
		candidate = vscode.Uri.joinPath(folder, baseName + ' (' + counter + ').md');
		counter++;
	}
}

module.exports = { activate, deactivate };
