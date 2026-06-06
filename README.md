# Chat Markdown Export

A small VS Code extension that exports your **current chat session** to a Markdown
file saved in a **`vschats` subfolder of the open folder**, named after the session.
The `vschats` folder is created automatically the first time you export.

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
| `chatMarkdownExport.includeReasoning` | `false` | Include the assistant's internal "thinking" blocks in collapsible `<details>` sections. |
| `chatMarkdownExport.openAfterExport` | `true` | Open the exported file after writing it. |
| `chatMarkdownExport.overwriteExisting` | `true` | Overwrite an existing file of the same name; when `false`, a ` (2)` suffix is added. |

## Install

From the VS Code **Extensions** view (`Ctrl+Shift+X`), search for **Chat Markdown
Export** and click **Install**. Or from a terminal (once published):

```powershell
code --install-extension JunYe.chat-markdown-export
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
  code --install-extension chat-markdown-export-0.5.1.vsix
  ```

## Notes & limitations

- The on-disk session format is internal to VS Code and may change between versions;
  the parser is defensive and skips parts it doesn't recognize.
- Rich response parts (file edits, tool calls) are summarized as short notes; plain
  prose, code blocks, and inline file references are exported in full.
- **The most recent reply may export blank.** VS Code writes chat history to disk
  lazily, so the latest assistant turn is often still buffered in memory when you run
  the export. When that happens the turn is marked *"response not yet saved to disk"*
  and a warning is shown — just wait a few seconds and run the export again to capture it.
