# Pi Permissions Extension

Claude-Code-like permission gates for pi tool calls.

This extension lets read-only inspection run without prompts, blocks sensitive file access, and defaults to Claude-Code-like auto approval for safe tool calls while dangerous commands still prompt or block. A manual `ask` mode is available for sessions where you want mutating tool calls to require approval.

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

When loaded, the footer/status area shows the active mode. By default:

```text
permissions: auto
```

or, when manual approval mode is enabled:

```text
permissions: ask
```

## Modes

- `auto` (default): Claude-Code-like full auto approval. Non-sensitive writes/edits, non-denied non-dangerous bash commands (including read-only bash), and custom tools are accepted automatically. Dangerous bash commands still require approval or are blocked, and sensitive/denied paths remain blocked.
- `ask`: manual permission-gate behavior. Recognized read-only bash commands are accepted automatically; mutating or unknown bash/custom tools prompt unless allowlisted, and writes/edits show a read-only Claude-Code-style diff approval UI.

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

Auto is the default. To force manual approvals by default, set top-level config field `"mode": "ask"`.

## Default behavior

| Tool | Ask mode | Auto mode |
| --- | --- | --- |
| `read` | Allowed unless the path matches `paths.denyRead` or `paths.sensitive`. | Same. |
| `bash` | Recognized read-only commands are allowed without prompting. Mutating or unknown commands prompt unless they match exact/session/project/global allow rules. Dangerous commands still prompt/block. | Automatically allowed unless denied or dangerous. Dangerous commands still prompt/block. |
| `write` | Shows a read-only diff between the current file and proposed content, then asks Allow/Deny. | Automatically allowed unless the path is denied/sensitive. |
| `edit` | Shows a read-only diff of the proposed replacements, then asks Allow/Deny. | Automatically allowed unless the path is denied/sensitive. |
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

## Write/edit diff approvals

In `ask` mode, `write` and `edit` no longer open editable review buffers. Instead they show a read-only Claude-Code-style diff with colored additions/removals and syntax highlighting for recognized source-code file types.

Use arrow keys or `j`/`k` to scroll the diff, left/right or Tab to choose Allow/Deny, Enter to confirm, and Esc to deny. The proposed output cannot be edited in the approval UI; approving runs the original tool call exactly as produced.

In `auto` mode, `write` and `edit` are accepted automatically unless the target path matches `paths.denyWrite` or `paths.sensitive`.

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
  "mode": "auto",
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
  "mainEditor": {
    "vimMode": false
  }
}
```

### Config fields

- `mode`: `"ask"` or `"auto"`; default startup mode (`"auto"` unless configured otherwise). Session commands can override it until reload/restart.
- `bash.allowExact`: exact commands allowed without prompting. Usually only needed for commands you intentionally want to trust despite not being classified as read-only.
- `bash.allowPrefixes`: command prefixes allowed without prompting. Prefer narrow prefixes because these bypass ask-mode prompts.
- `bash.denyPatterns`: regular expressions checked against commands before allow rules.
- `tools.allow`: custom tool names allowed without prompting.
- `paths.denyRead`: path globs blocked for reads.
- `paths.denyWrite`: path globs blocked for writes/edits.
- `paths.sensitive`: path globs blocked for both reads and writes/edits.
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

Set `mainEditor.vimMode` to `true` in config:

```json
{
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

Write/edit diff approval is read-only and does not use vim mode.

## Limitations

- This is a guardrail, not a sandbox. Extensions run with your user permissions.
- Bash parsing/read-only classification is heuristic; shell syntax can hide side effects, and unknown commands may still prompt in `ask` mode.
- Path glob matching is intentionally simple.
- Write/edit diff approval is line-based; very large diffs may be shown as a full replacement preview.
- Non-interactive mode blocks approval-required actions rather than prompting.

## Checking

Validate package contents with:

```bash
npm pack --dry-run
```

After changing the extension code or config, reload pi with:

```text
/reload
```

or use:

```text
/permissions-reload
```

for config-only changes.

## License

This source is available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may download, copy, modify, and share it for noncommercial purposes. Commercial use is not permitted without separate written permission.
