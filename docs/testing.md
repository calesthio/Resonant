# Testing and quality gates

- `npm test`: pure time, project validation, command, persistence, and offline-render tests.
- `npm run check`: TypeScript and all tests.
- `npm run build`: production renderer build.
- `npm run package:win`: checks, builds, and creates the portable Windows executable.
- `npm run package:release`: runs the complete desktop and MCP gates, then creates both Windows package formats, release notes, manifest, and SHA-256 checksums.
- `npm run build:mcp`: bundles the local STDIO MCP server for Node.js 22.
- `npm run mcp:smoke`: spawns the compiled server through an MCP client and completes a blank-project-to-analyzed-WAV workflow using a generated SoundFont pack, including instrument discovery/assignment, deterministic repeat rendering, and adversarial rejection checks.
- `npm run mcp:packaged-smoke`: assembles an unpacked Windows application, verifies the license and launcher are present, then starts the 29-tool MCP server from inside `app.asar` through Resonant's embedded Node runtime.
- `npm run electron:smoke`: drives the production Electron renderer through the first-run instrument library, project creation, MIDI editing, real audio import, fake-device recording, transport and loop boundaries, arrangement editing, mixing, autosave, save/reopen, and WAV export. Set `RESONANT_SMOKE_AUDIO` to an absolute WAV path to choose the import fixture.
  Arrangement gesture coverage includes native Ctrl+A/field selection, Delete/undo, group duplication and movement, left/right snapped edge resizing, Escape cancellation, cursor-anchored wheel zoom, unsnapped ruler/playhead seeking, and the elapsed-time readout.

## Arrangement editing

- Click a block to select it; Shift-click or Ctrl/Cmd-click toggles additional blocks. Ctrl/Cmd+A selects all arrangement blocks. Escape clears the selection.
- Delete or Backspace removes the selected instances in one undo step, preserving shared clip sources. Ctrl/Cmd+D duplicates the selected group after its end.
- Drag a block body to move the selection, or an edge to trim/extend that instance. The double-arrow cursor marks resize handles. Moves and edges snap to quarter beats. Extending repeats the source; it does not time-stretch audio. Left-edge trimming preserves the source phase and the right edge.
- A drag previews immediately, commits once on release, and can be cancelled with Escape. Arrow keys move by one beat (Ctrl/Cmd for quarter beats); Shift+arrows resize the right edge.
- Wheel over the timeline to zoom at the cursor; Shift+wheel scrolls horizontally. Zoom buttons anchor at the viewport center.
- Click or drag the ruler, the red playhead handle, or empty space below the arrangement to seek without snapping. Seeking pauses playback; Space resumes from the chosen position. A focused playhead supports arrows (quarter beat) and Shift+arrows (0.01 beat).
- The transport shows minutes:seconds.milliseconds above bars/beats, and the ruler labels both bar numbers and elapsed time. Normal text-field editing and modal dialogs retain their keyboard shortcuts.
- `npm run mcp:audit -- <project.resonant> <output.wav> <report.json>`: inspects, validates, analyzes, and renders an existing project through the local MCP server without editing project JSON.

Reference environment: Windows 11 Home x64 (build 26200), Intel Core i9-14900HX, 32 GB RAM, Node 22.14, 44.1 kHz export. Release budgets are: installed first launch under 5 s; installed aggregate idle working set under 550 MB; audible starter-session playback with reported output latency under 100 ms; 32-bar offline render under 5 s; atomic save and reopen under 500 ms for projects without long embedded recordings. The installer is the performance-supported Windows path. The unsigned portable artifact has a functional launch gate but no startup-time budget because self-extraction and first-scan time varied from 16 to 38 seconds on the same machine.

Measured 0.1.0 results: installed first launch 2.253 s; installed aggregate working set 487,415,808 bytes across four Electron processes; portable first launch 16.753 s; live output latency 58 ms; 32-bar reference render 475 ms; atomic save 5.82 ms; reopen and validation 1.66 ms. Re-run the release gates below to produce fresh machine-local reports.

Agent-mode gates add strict MCP TypeScript checks, workspace and music-operation unit tests, Codex TOML and Claude JSON config parsing, STDIO tool/resource/prompt discovery, revision-conflict rejection, traversal rejection, schema rejection, two-render hash equality, and a desktop production-build regression check. Smoke-test reports are generated locally under the ignored `.agent/evidence/` directory.
