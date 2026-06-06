// Chat Markdown Export
// Exports the current VS Code chat session to a Markdown file in a "vschats"
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
	const opts = { includeReasoning: config.get('includeReasoning', false), stats: { pendingTurns: 0 } };
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
	if (opts.stats.pendingTurns > 0) {
		vscode.window.showWarningMessage(
			'Chat Markdown Export: the latest reply was not fully saved to disk yet, so it appears blank in the export. '
			+ 'VS Code writes chat history lazily \u2014 wait a few seconds, then run the export again to capture it.'
		);
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
		const count = state && Array.isArray(state.requests) ? state.requests.length : 0;
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

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * @param {any} state
 * @param {{ includeReasoning: boolean }} opts
 */
function renderMarkdown(state, opts) {
	const requests = Array.isArray(state.requests) ? state.requests : [];
	const responder = state.responderUsername || 'Assistant';
	const out = [];

	out.push('# ' + sessionTitle(state));
	out.push('');
	out.push('- **Session ID:** ' + (state.sessionId || 'unknown'));
	out.push('- **Exported:** ' + new Date().toISOString());
	const model = modelName(state);
	if (model) {
		out.push('- **Model:** ' + model);
	}
	out.push('- **Messages:** ' + requests.length);
	out.push('');
	out.push('---');
	out.push('');

	for (const request of requests) {
		const userText = request && request.message && typeof request.message.text === 'string'
			? request.message.text.trim()
			: '';
		out.push('### User');
		out.push('');
		out.push(userText || '_(empty message)_');
		out.push('');

		out.push('### ' + responder);
		out.push('');
		let body = renderResponse(Array.isArray(request.response) ? request.response : [], opts);
		if (request && request.result && request.result.errorDetails && request.result.errorDetails.message) {
			const note = '> [!WARNING] ' + String(request.result.errorDetails.message).replace(/\n/g, ' ');
			body = body ? body + '\n\n' + note : note;
		}
		if (body) {
			out.push(body);
		} else if (!(request && request.result)) {
			// Empty body on a turn that has no `result` yet: VS Code finalizes and
			// flushes a completed turn to disk lazily, so the most recent reply is
			// frequently still buffered in memory when an export runs. Flag it so the
			// caller can advise the user to re-export once the journal catches up.
			if (opts && opts.stats) {
				opts.stats.pendingTurns += 1;
			}
			out.push('_(response not yet saved to disk \u2014 VS Code writes chat history lazily; wait a few seconds and run the export again to capture it)_');
		} else {
			out.push('_(no response captured)_');
		}
		out.push('');
		out.push('---');
		out.push('');
	}

	return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
}

/**
 * Render an array of response parts to Markdown.
 *
 * Markdown parts are sometimes serialized as progressive snapshots, where a later
 * part is a prefix-superset of an earlier one. We therefore coalesce consecutive
 * markdown parts using a prefix test instead of blindly concatenating them.
 *
 * @param {any[]} parts
 * @param {{ includeReasoning: boolean }} opts
 */
function renderResponse(parts, opts) {
	const blocks = [];
	let mdBuffer = null; // accumulated visible markdown (including inline references)
	let thinkBuffer = null; // accumulated reasoning text

	const flushMarkdown = () => {
		if (mdBuffer != null) {
			const text = mdBuffer.trim();
			if (text) {
				blocks.push(text);
			}
			mdBuffer = null;
		}
	};
	const flushThinking = () => {
		if (thinkBuffer != null) {
			const text = thinkBuffer.trim();
			if (opts.includeReasoning && text) {
				blocks.push('<details>\n<summary>Reasoning</summary>\n\n' + text + '\n\n</details>');
			}
			thinkBuffer = null;
		}
	};

	for (const part of parts) {
		const kind = part && part.kind;

		if (kind === undefined || kind === null) {
			// Markdown content.
			flushThinking();
			if (typeof part.value === 'string') {
				mdBuffer = mergeProgressive(mdBuffer, part.value);
			}
		} else if (kind === 'thinking') {
			flushMarkdown();
			if (typeof part.value === 'string') {
				thinkBuffer = mergeProgressive(thinkBuffer, part.value);
			}
		} else if (kind === 'inlineReference') {
			// Inline file/symbol reference — stays inside the markdown flow.
			flushThinking();
			const name = referenceName(part);
			mdBuffer = (mdBuffer == null ? '' : mdBuffer) + '`' + name + '`';
		} else if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
			flushThinking();
			flushMarkdown();
			const message = markdownText(part.invocationMessage) || markdownText(part.pastTenseMessage) || ('Used tool `' + (part.toolId || part.toolSpecificData && part.toolSpecificData.kind || 'tool') + '`');
			blocks.push('> ' + collapse(message));
		} else if (kind === 'textEditGroup' || kind === 'notebookEditGroup') {
			flushThinking();
			flushMarkdown();
			blocks.push('> Edited `' + basenameOf(part.uri) + '`');
		} else if (kind === 'warning') {
			flushThinking();
			flushMarkdown();
			blocks.push('> [!WARNING] ' + collapse(markdownText(part.content)));
		}
		// All other kinds (mcpServersStarting, progressMessage, undoStop, codeblockUri,
		// prepareToolInvocation, command buttons, etc.) are internal and skipped.
	}

	flushThinking();
	flushMarkdown();
	return blocks.join('\n\n').trim();
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
		const firstLine = requests[0].message.text.split(/\r?\n/)[0].trim();
		if (firstLine) {
			return firstLine.length > 60 ? firstLine.slice(0, 60).trim() + '…' : firstLine;
		}
	}
	return (state && state.sessionId) || 'chat-session';
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
