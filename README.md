# Chat Markdown Export

A lightweight VS Code extension that exports a **selected chat session** to a Markdown
file saved in a **`vschats` subfolder of the open folder**, named after the session.
The `vschats` folder is created automatically the first time you export.

## Why export your chats?

Chat Markdown Export is designed for a few everyday VS Code Chat pain points:

- **Searchable history** — VS Code Chat keeps useful conversations, but it does not
  provide keyword search across your chat history. Exporting sessions to Markdown lets
  you search them with your editor, source control, or knowledge-base tools.
- **Project-local records** — Chat sessions are stored outside your workspace folder.
  If you rename or relocate a project, its chat history can become difficult to find
  again. Saving Markdown copies under `vschats` keeps important conversations with the
  project they belong to.
- **Reusable knowledge** — Some chats capture debugging trails, design decisions,
  prompts, summaries, explanations, or standout AI-generated answers worth keeping.
  Export them as individual Markdown files and fold them into your notes or knowledge
  base for later use.

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and run:

- **Chat Export: Export Chat Session as Markdown** — shows a list of this workspace's
  chat sessions (newest first) and exports the one you choose. The session currently
  open in the chat panel is marked and pre-selected, so in the common case you just
  press Enter.

The file is written to the `vschats` subfolder of the workspace root as
`<session name>.md` (the same name shown in the chat history), with illegal filename
characters replaced. The `vschats` folder is created if it does not already exist.

## How it works

VS Code has no public API for reading chat messages, so the extension reads the
session journal VS Code stores for the current workspace:

```
<user data>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
```

Each `.jsonl` file is an append-only journal (an initial snapshot followed by
set/append patches). The extension replays the journal to rebuild the conversation,
then renders each user prompt and assistant reply to Markdown.

### Which session is pre-selected?

The picker marks and pre-selects the session **currently open in the Copilot chat
panel**, so you usually just press Enter. VS Code records the open session in the
workspace state database (`<hash>/state.vscdb`, key
`memento/interactive-session-view-copilot`); the extension reads it with Node's
built-in SQLite (`node:sqlite`), falling back to a dependency-free byte scan that
only trusts an id when every readable copy agrees.

There is one important limitation: VS Code updates that record **only after the chat
view receives a real click**, and no command an extension can run triggers the same
update. So a session you just reopened from history is *not* detectable until you
interact with it — which is exactly why this command lists every session and lets you
choose, rather than silently guessing. If the open session can't be read at all, the
newest session is pre-selected instead. Sessions are always listed newest-first.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `chatMarkdownExport.openAfterExport` | `true` | Open the exported file after writing it. |
| `chatMarkdownExport.overwriteExisting` | `true` | Overwrite an existing file of the same name; when `false`, a ` (2)` suffix is added. |

## Install

From the VS Code **Extensions** view (`Ctrl+Shift+X`), search for **Chat Markdown
Export** and click **Install**. Or from a terminal (once published):

```powershell
code --install-extension Jun-Ye.chat-markdown-export
```

Then open the Command Palette (`Ctrl+Shift+P`) and run **Chat Export: Export Chat
Session as Markdown**.

## Develop / build from source

If you've cloned the [repository](https://github.com/Jellun/chat-markdown-export) and
want to hack on it:

- **Run without building** — open this folder in VS Code and press `F5` to launch the
  **Extension Development Host**. In that new window, open any folder, use the chat
  panel, then run the command from the Command Palette.
- **Package a `.vsix` locally:**

  ```powershell
  npm install -g @vscode/vsce
  cd chat-markdown-export
  vsce package
  code --install-extension chat-markdown-export-0.5.10.vsix
  ```

## Notes & limitations

- The on-disk session format is internal to VS Code and may change between versions;
  the parser is defensive and skips parts it doesn't recognize.
- Plain prose, code blocks, and inline file references from the assistant's final
  answer are exported. Internal reasoning/thinking blocks, tool calls, edit records,
  command/status updates, and agent progress notes are omitted.
- **The export mirrors what VS Code shows, not the raw on-disk log.** VS Code's
  append-only journal keeps artifacts its UI hides: aborted or superseded attempts (left
  behind when you cancel or re-send a prompt) and tool calls that are serialized twice
  (once on completion, then again once a short title is generated). The exporter drops
  interior aborted attempts, hides generated `@agent Continue` control prompts while
  merging their assistant output into the previous visible user turn,
  collapses an identical re-sent prompt into its final answer only when the earlier
  request is superseded or empty, de-duplicates the repeated tool calls (by their call
  id) and progressive markdown snapshots, and otherwise preserves every distinct turn
  in its original order.
- **Replies recorded against the wrong turn are realigned.** Rarely — typically after you
  cancel and re-send a prompt while a reply is generating — VS Code's journal routes each
  later reply onto an already-finished *earlier* turn, leaving the genuine later turns
  blank. When the exporter can pair the misplaced replies with the blank turns one-for-one
  and in order, it moves each reply back to the turn it belongs to; the notification then
  reports how many were realigned. If the pattern is at all ambiguous it leaves the turns
  untouched, so healthy sessions are never altered.
- **The most recent turns may export incomplete.** VS Code writes the chat **journal**
  to disk **lazily and in request order**, so during a long, active session the last few
  turns are often still buffered — a reply can be missing or truncated. To close that
  gap, the exporter reads GitHub Copilot's sibling **transcript** (which VS Code updates
  promptly) and **backfills** any trailing turn the journal hasn't finalized, matching by
  prompt text; recovered turns are marked with a small *"Recovered from the live chat
  transcript"* note. A turn that is in neither source yet (e.g. a reply still streaming as
  you export) is flagged with a warning, and a notification reports how many turns were
  recovered and how many are still pending — just re-export once the reply has finished.
  Backfill applies only to Copilot sessions; other chat providers fall back to the
  journal alone.
