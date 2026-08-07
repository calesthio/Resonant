# Resonant 0.4.2

Resonant 0.4.2 adds safe audio-conditioned ACE-Step generation for connected MCP agents.

## What changed

- MCP clients can pass an existing workspace WAV to ACE-Step as reference audio for global timbre and style guidance, including approximate vocal character.
- Cover generation can use a workspace WAV as structural source audio with adjustable influence strength.
- Repaint generation can use a source WAV plus a bounded time interval and optional edit instruction.
- Audio inputs are resolved through Resonant’s confined workspace boundary. Missing files, non-WAV paths, traversal attempts, and symlink escapes are rejected before ACE-Step starts work.
- Invalid task combinations are rejected early, including covers without source audio, source audio attached to plain text-to-music jobs, and inverted repaint intervals.
- `get_capabilities` and the MCP tool schemas now explain audio-conditioning modes, required inputs, and the limits of reference-based vocal identity.
- README and agent-production documentation now cover recording/reference workflows and voice-consent expectations.
- Regression coverage verifies ACE-Step payload mapping, confined path resolution, required source inputs, task-specific controls, and repaint interval validation.

## Validation

- Delivery-graph validation, TypeScript checks, and the complete 66-test unit/domain suite pass.
- Production renderer and MCP builds pass.
- MCP smoke validates all 29 registered tools, revision safety, workspace confinement, analysis, rendering, and the rebuilt audio-conditioning schema.
- Electron smoke covers startup, instruments, recording/import, arrangement, mixing, save/open/recovery, playback, and WAV export.
- Packaged MCP smoke validates the server bundled inside the Windows application.

## Downloads

- `Resonant-Setup-0.4.2-Windows-x64.exe` — standard Windows installer.
- `Resonant-0.4.2-Windows-x64.exe` — portable Windows build.
- `SHA256SUMS.txt` — checksums for verifying both executables.

The Windows executables are currently unsigned, so Windows SmartScreen may show a warning. Source installation instructions remain available in the README.
