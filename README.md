# Pi Permissions Extension

Simplified auto/ask guardrails for pi tool calls.

The extension now has only two permission behaviors:

- dangerous bash commands are always flagged in both modes
- `ask` mode shows read-only diffs for `write` and `edit` with Allow/Deny controls

Granular session/project/global allowlists, custom-tool approvals, bash prefix approvals, path deny/sensitive rules, and persisted permission grants have been removed.

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
- Optional global preferences: `~/.pi/agent/permissions.json`
- Optional project preferences: `.pi/permissions.json`

Preference files only configure the default mode and optional vim editor setting. Legacy granular permission fields are ignored.

## Loading

When installed with pi's package manager, the extension loads automatically on startup.

If pi is already running, use:

```text
/reload
```

When loaded, the footer/status area shows the active mode:

```text
permissions: auto
```

or:

```text
permissions: ask
```

## Modes

- `auto` (default): reads, writes/edits, non-dangerous bash commands, and custom tools are allowed automatically. Dangerous bash commands still prompt or block.
- `ask`: reads, non-dangerous bash commands, and custom tools are allowed automatically. `write` and `edit` show a read-only diff with Allow/Deny controls. Dangerous bash commands still prompt or block.

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

To choose the startup mode by preference, set top-level config field `"mode": "ask"` or `"mode": "auto"`.

## Default behavior

| Tool | Ask mode | Auto mode |
| --- | --- | --- |
| `read` | Allowed. | Allowed. |
| `bash` | Allowed unless classified as dangerous. Dangerous commands prompt/block. | Allowed unless classified as dangerous. Dangerous commands prompt/block. |
| `write` | Shows a read-only diff, then asks Allow/Deny. | Allowed. |
| `edit` | Shows a read-only diff of the proposed replacements, then asks Allow/Deny. | Allowed. |
| unknown/custom tools | Allowed. | Allowed. |
| no UI | Blocks approval-required dangerous bash and ask-mode write/edit diffs. | Blocks approval-required dangerous bash; otherwise allows. |

## Dangerous commands

Danger checks run before mode behavior.

The extension blocks obviously catastrophic recursive deletes, such as broad `rm -rf` against `/`, `~`, `.`, or `*`.

It requires approval for risky patterns such as:

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

In `ask` mode, `write` and `edit` show a read-only Claude-Code-style diff with transparent-style red backgrounds for deletions, transparent-style green backgrounds for additions, and syntax highlighting for recognized source-code file types.

Use arrow keys or `j`/`k` to scroll the diff, left/right or Tab to choose Allow/Deny, and Enter to choose. Choosing Deny (including via Esc, `n`, or `d`) opens a text input where you can tell pi what to do instead; that feedback is returned to the model as the blocked tool result. Submit blank to deny without feedback, or press Esc in the text input to return to the diff review. The proposed output cannot be edited in the approval UI; approving runs the original tool call exactly as produced.

In `auto` mode, `write` and `edit` are accepted automatically.

## Preferences

Global preferences live at:

```text
~/.pi/agent/permissions.json
```

Project preferences live at:

```text
.pi/permissions.json
```

Example:

```json
{
  "version": 2,
  "mode": "auto",
  "mainEditor": {
    "vimMode": false
  }
}
```

### Preference fields

- `mode`: `"ask"` or `"auto"`; default startup mode (`"auto"` unless configured otherwise). Session commands can override it until reload/restart.
- `mainEditor.vimMode`: replace pi's main input editor with a simple vim-style modal editor.

Legacy fields such as `bash.allowExact`, `bash.allowPrefixes`, `bash.denyPatterns`, `tools.allow`, `paths.denyRead`, `paths.denyWrite`, and `paths.sensitive` are intentionally ignored.

## Admin commands

```text
/permissions
```

Show the effective simplified guardrail summary.

```text
/permissions-auto [on|off|toggle]
```

Toggle auto/ask mode for the current session.

```text
/permissions-mode [ask|auto]
```

Show or set the current session permission mode.

```text
/permissions-edit global
```

Open `~/.pi/agent/permissions.json` in an editor and reload it after saving valid JSON preferences.

```text
/permissions-edit project
```

Open `.pi/permissions.json` for the current working directory and reload it after saving valid JSON preferences.

```text
/permissions-reload
```

Reload global and project preferences without restarting pi.

## Vim mode

Vim bindings are off by default.

Set `mainEditor.vimMode` to `true` in preferences:

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
- Dangerous bash classification is heuristic; shell syntax can hide side effects.
- Reads/writes are intentionally unrestricted in auto mode.
- Write/edit diff approval is line-based; very large diffs may be shown as a full replacement preview.
- Non-interactive mode blocks approval-required actions rather than prompting.

## Checking

Validate package contents with:

```bash
npm pack --dry-run
```

After changing the extension code or preferences, reload pi with:

```text
/reload
```

or use:

```text
/permissions-reload
```

for preference-only changes.

## License

This source is available under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may download, copy, modify, and share it for noncommercial purposes. Commercial use is not permitted without separate written permission.
