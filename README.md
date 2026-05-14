# Pi Permissions Extension

Claude-Code-like permission gates for pi tool calls.

This extension lets read-only inspection run without prompts, blocks sensitive file access, and asks before mutating tool calls in the default `ask` mode. It also has a Claude-Code-like full auto mode for sessions where you want safe tool calls accepted automatically while dangerous commands still prompt or block.

## Install

```bash
pi install git:github.com/majorgilles/pi-permissions
```

For a one-off run without adding it to settings:

```bash
pi -e git:github.com/majorgilles/pi-permissions
```

## Files

- Package extension entrypoint: `index.ts`
- Global config: `~/.pi/agent/permissions.json`
- Project config: `.pi/permissions.json`

Project config is additive: project rules are merged with global rules.

## Loading

When installed with pi's package manager, the extension loads automatically on startup.

If pi is already running, use:

```text
/reload
```

When loaded, the footer/status area shows the active mode:

```text
permissions: ask
```

or, when auto mode is enabled:

```text
permissions: auto
```

## Modes

- `ask` (default): manual permission-gate behavior. Recognized read-only bash commands are accepted automatically; mutating or unknown bash/custom tools prompt unless allowlisted, and writes/edits open review editors.
- `auto`: Claude-Code-like full auto approval. Non-sensitive writes/edits, non-denied non-dangerous bash commands (including read-only bash), and custom tools are accepted automatically. Dangerous bash commands still require approval or are blocked, and sensitive/denied paths remain blocked.

Toggle for the current session:

```text
/permissions-auto on
/permissions-auto off
```

or:

```text
/permissions-mode auto
/permissions-mode ask
```

Ask is the default. To default to full auto instead, set top-level config field `"mode": "auto"`.

## Default behavior

| Tool | Ask mode | Auto mode |
| --- | --- | --- |
| `read` | Allowed unless the path matches `paths.denyRead` or `paths.sensitive`. | Same. |
| `bash` | Recognized read-only commands are allowed without prompting. Mutating or unknown commands prompt unless they match exact/session/project/global allow rules. Dangerous commands still prompt/block. | Automatically allowed unless denied or dangerous. Dangerous commands still prompt/block. |
| `write` | Opens an editor with the full proposed content before executing. | Automatically allowed unless the path is denied/sensitive. |
| `edit` | Opens an editor for each replacement before executing. | Automatically allowed unless the path is denied/sensitive. |
| unknown/custom tools | Prompt by default, with limited persistence options. | Automatically allowed. |
| no UI | Blocks anything that requires approval. | Auto-approved operations proceed; danger prompts still block because there is no UI. |

Read-only built-ins `grep`, `find`, and `ls` are treated as known built-ins rather than unknown custom tools. Common read-only bash commands (`pwd`, `ls`, `cat`, `rg`, `grep`, `find`, `git status`, `git diff`, etc.) are also auto-allowed in every mode when they do not use output redirection or unsafe options such as `find -exec`/`-delete`.

## Bash approvals

For a bash command that requires approval, the prompt offers:

- Deny
- Allow once
- Allow for this session
- Allow this exact command for this project
- Allow this command prefix for this project
- Allow this exact command globally

The extension intentionally does **not** offer global prefix approval from the prompt.

## Dangerous commands

Deny and danger checks take precedence over allow rules.

The extension blocks obviously catastrophic recursive deletes, such as broad `rm -rf` against `/`, `~`, `.`, or `*`.

It requires extra confirmation for risky patterns such as:

- recursive deletes like `rm -rf path`
- `sudo` / `su`
- `git clean ... -f`
- `git reset --hard` / `--merge` / `--keep`
- `git checkout -- ...`, `git restore .`, etc.
- recursive `chmod -R` / `chown -R`
- disk operations such as `dd`, `mkfs`, `fdisk`, `diskpart`
- `curl ... | sh`, `wget ... | bash`, etc.

These checks are heuristic and should not be treated as a complete sandbox.

## Write/edit review

Review editors use syntax highlighting for recognized source-code file types. For `write`, the proposed file content is highlighted using the target file extension. For `edit`, the original commented block and replacement block are highlighted; only the replacement block remains editable/applicable as before.

### `write`

The review editor contains the full proposed file contents. The accepted editor contents become the final `write.content`.

### `edit`

Each replacement is reviewed separately. The buffer includes commented instructions and original text, followed by:

```text
--- replacement ---
<proposed replacement>
```

Only the text after `--- replacement ---` is applied as `newText`.

In `ask` mode, `write` and `edit` are always reviewed. In `auto` mode, they are accepted automatically unless the target path matches `paths.denyWrite` or `paths.sensitive`.

## Config

Global config lives at:

```text
~/.pi/agent/permissions.json
```

Project config lives at:

```text
.pi/permissions.json
```

Example:

```json
{
  "version": 1,
  "mode": "ask",
  "bash": {
    "allowExact": [],
    "allowPrefixes": [],
    "denyPatterns": []
  },
  "tools": {
    "allow": []
  },
  "paths": {
    "denyRead": [],
    "denyWrite": [],
    "sensitive": [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "**/*secret*",
      "**/*credential*",
      "**/*token*",
      "**/id_rsa",
      "**/id_ed25519",
      "**/*.pem",
      "**/*.key"
    ]
  },
  "reviewEditor": {
    "vimMode": false
  },
  "mainEditor": {
    "vimMode": false
  }
}
```

### Config fields

- `mode`: `"ask"` or `"auto"`; default startup mode (`"ask"` unless configured otherwise). Session commands can override it until reload/restart.
- `bash.allowExact`: exact commands allowed without prompting. Usually only needed for commands you intentionally want to trust despite not being classified as read-only.
- `bash.allowPrefixes`: command prefixes allowed without prompting. Prefer narrow prefixes because these bypass ask-mode prompts.
- `bash.denyPatterns`: regular expressions checked against commands before allow rules.
- `tools.allow`: custom tool names allowed without prompting.
- `paths.denyRead`: path globs blocked for reads.
- `paths.denyWrite`: path globs blocked for writes/edits.
- `paths.sensitive`: path globs blocked for both reads and writes/edits.
- `reviewEditor.vimMode`: temporarily enable vim-style editor bindings for review editors where supported. Review editors also syntax-highlight recognized code files where the current pi version honors custom editor components.
- `mainEditor.vimMode`: replace pi's main input editor with a simple vim-style modal editor.

## Admin commands

```text
/permissions
```

Show the effective policy summary.

```text
/permissions-auto [on|off|toggle]
```

Toggle Claude-Code-like auto approval for the current session.

```text
/permissions-mode [ask|auto]
```

Show or set the current session permission mode.

```text
/permissions-edit global
```

Open `~/.pi/agent/permissions.json` in an editor and reload it after saving valid JSON.

```text
/permissions-edit project
```

Open `.pi/permissions.json` for the current working directory and reload it after saving valid JSON.

```text
/permissions-reload
```

Reload global and project configs without restarting pi.

## Vim mode

Vim bindings are off by default.

Set either value to `true` in config:

```json
{
  "reviewEditor": { "vimMode": true },
  "mainEditor": { "vimMode": true }
}
```

Implemented normal-mode keys include:

- `Esc`: insert mode → normal mode
- `i`: normal mode → insert mode
- `a`: append / insert after cursor
- `h`, `j`, `k`, `l`: movement
- `0`, `$`: line start/end
- `x`: delete character

Note: `reviewEditor.vimMode` depends on whether the current pi version's `ctx.ui.editor` honors the editor component factory. If not, main editor vim mode still works when enabled.

## Limitations

- This is a guardrail, not a sandbox. Extensions run with your user permissions.
- Bash parsing/read-only classification is heuristic; shell syntax can hide side effects, and unknown commands may still prompt in `ask` mode.
- Path glob matching is intentionally simple.
- The edit review UI is compact, not a full diff UI.
- Non-interactive mode blocks approval-required actions rather than prompting.

## Updating

After changing the extension code or config, run:

```text
/reload
```

or use:

```text
/permissions-reload
```

for config-only changes.
