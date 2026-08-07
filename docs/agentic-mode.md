# Resonant agent mode contract

Agent mode lets a local MCP-capable host compose, arrange, mix, inspect, and render Resonant projects. It does not embed a model or send music to a model provider. The host launches `resonant-mcp` over STDIO and decides which model may call its tools.

## Required workflow

1. Call `get_capabilities` to learn project limits and musical conventions.
2. For lyrics or songs, call `list_songwriting_languages`. Match the user's language by ID, name, locale, or alias; use its returned coaching guide and the `write_song` prompt. Analyze, revise, and save the lyric before generation. Never silently substitute English.
3. Call `create_project`, `list_projects`, or `inspect_project` to establish the target and current revision.
4. Pass `expectedRevision` on mutations after reading a project. If another writer changed it, inspect again instead of overwriting.
5. Compose with `set_clip_notes` and `duplicate_clip`; create the song with `set_arrangement`; shape it with `set_track_mix`, `set_project_settings`, and `set_clip_automation`.
6. Call `validate_project` and `analyze_mix` before `render_wav`.
7. Preserve the user's current file. Prefer a new project or explicit output path when the request does not authorize modifying an existing piece.

## Tool inventory

| Area | Tools | Purpose |
| --- | --- | --- |
| Discovery | `get_capabilities`, `list_projects`, `inspect_project`, `validate_project` | Learn supported operations and inspect bounded project data without returning embedded PCM |
| Songwriting | `list_songwriting_languages`, `analyze_lyrics`, `save_songwriting_draft`; `write_song` prompt | Draft, revise, analyze, and persist generator-ready lyrics through replaceable language packs |
| AI generation | `start_ai_generation`, `get_ai_generation_status`, `collect_ai_generation`, `abandon_ai_generation` | Run optional ACE-Step work as durable jobs without holding one MCP request open; `generate_ai_music` remains a blocking compatibility tool |
| Composition | `create_project`, `set_project_settings`, `set_clip_notes`, `duplicate_clip` | Establish tempo/loop and author 16-step drum or melodic material |
| Arrangement | `set_arrangement` | Place shared clip references on the linear timeline |
| Mixing | `set_track_mix`, `set_clip_automation`, `analyze_mix` | Shape levels, pan, delay, instrument settings, automation, and inspect rendered measurements |
| Audio | `import_wav`, `externalize_audio_assets`, `analyze_vocal_lyrics`, `render_wav` | Deduplicate audio in the shared asset library, migrate legacy embedded clips, triage lyric delivery, and create a deterministic stereo master |
| Recovery | `list_history`, `undo_last_change` | Inspect and restore the server's bounded pre-change snapshots |

## Safety and limits

- `RESONANT_PROJECT_ROOT` is the only readable/writable root. Relative paths are preferred; traversal and symlink escape attempts fail.
- ACE-Step generation can condition on existing workspace WAV files. Use `referenceAudioPath` with `text2music` for global timbre/style guidance, including an approximate vocal character. Use `sourceAudioPath` with `cover` to retain whole-song structure or with `repaint` plus a time interval to regenerate part of an existing recording. Reference conditioning is not a guarantee of exact voice cloning, and agents should only use voices the user owns or has permission to use.
- Project writes are atomic and keep at most 20 pre-change snapshots, capped at 500 MB total per project, under `.resonant-history`.
- No tool deletes projects, runs commands, opens network connections, starts recording, or controls arbitrary applications.
- Tools cap project, note, arrangement, audio-import, and render sizes before allocating large buffers.
- Tool results contain summaries and stable identifiers. Audio payloads are never returned to the model.
- Use a stable `idempotencyKey` for AI generation. Polling is reconnect-safe. Abandoning prevents collection, but ACE-Step currently has no per-task GPU interrupt; stopping the whole shared engine would also interrupt unrelated work.
- ACE-Step runs independently of the short-lived MCP STDIO process, so polling and collection can continue after an assistant reconnects. Reusing an idempotency key returns the active or completed job; after explicit abandonment, the same key starts a replacement job.
- Pass the songwriting `language` to AI-generation tools when known. Resonant translates native section-control labels for ACE-Step while preserving the actual sung lyric text.
- Agent mix measurements are diagnostic. A musician remains responsible for listening and final artistic approval.

## Connect a host

The Windows installer includes the bundled MCP server and exposes copy-ready client configurations under **Quick Start → Connect Codex, Claude, or another AI assistant**. It runs through Resonant's embedded Node runtime, so installed users do not need a separate Node.js installation. Choose the music workspace deliberately; that folder becomes the server's read/write boundary.

When running from source, run `npm install` and `npm run build:mcp` first. The checked-in project configurations launch `mcp-dist/server.mjs` with Node.js and confine it to the repository root.

Codex reads `.codex/config.toml` in a trusted project. Restart the Codex app, CLI, or IDE session after building, then use `/mcp` to inspect the current Resonant tool inventory.

Claude Code reads `.mcp.json`. Start it from the repository, accept the workspace trust prompt, and use `/mcp` to confirm the server. `${CLAUDE_PROJECT_DIR:-.}` uses Claude's project directory when available and a project-root working-directory fallback during host configuration expansion.

To run the server manually for another MCP host:

```powershell
node mcp-dist/server.mjs --root "C:\path\to\your\music-workspace"
```

STDOUT is reserved for MCP JSON-RPC; diagnostics go to STDERR. The server performs no network requests.

## Desktop coordination

The file on disk is the durable agent boundary. Save or open a `.resonant` project before asking an agent to modify it. Resonant watches the containing directory so atomic external replacements are detected on Windows. If the in-app project is clean, the external revision loads automatically. If there are unsaved in-app changes, Resonant asks before discarding them and otherwise leaves the agent revision waiting on disk.

Agent mode does not yet start playback, capture a microphone, or edit transient unsaved state. Those actions require a future authenticated live-session bridge rather than expanding the filesystem MCP server.
