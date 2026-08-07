# Resonant 0.5.0

Resonant 0.5.0 turns local AI music generation and personal singing-voice conversion into first-class workstation capabilities.

## Highlights

- **Personal singing voices with Seed-VC:** install and manage the optional local provider from Resonant, select an isolated source vocal and a clean 1–30 second reference, and add the converted performance directly to the Audio track.
- **Consent and provenance by design:** every conversion requires confirmation that the voice is owned or used with explicit permission. Resonant records source/reference hashes and conversion provenance beside the output.
- **Visible provider controls:** the main header now exposes labeled **AI SONG** and **MY VOICE** controls with install, ready, running, and error states instead of hiding providers behind icon-only actions.
- **Managed local setup:** Resonant detects existing managed ACE-Step and Seed-VC installations, offers installation when missing, and coordinates GPU use by stopping ACE-Step before Seed-VC conversion.
- **Agent-accessible voice conversion:** MCP clients can inspect Seed-VC availability and perform consent-gated conversions using workspace-confined WAV paths.

## Seed-VC integration

- The managed Windows installation pins archived Seed-VC revision `51383efd921027683c89e5348211d93ff12ac2a8` and installs it separately under its GPL-3.0 license.
- Windows setup installs explicit PyTorch 2.4 CUDA 12.4 wheels and a minimal singing-inference dependency profile, avoiding malformed upstream requirement flags and unnecessary GUI/evaluation packages. Partial installations remain retryable and are not reported as complete.
- Installer progress strips terminal control codes, preserves a readable failure message, and removes temporary package caches after successful setup.
- The singing/F0 conversion path retains source melody, timing, phrasing, and pitch contour while transferring vocal identity from the reference recording.
- Source, reference, and output files are restricted to the configured workspace for MCP operations.
- An NVIDIA CUDA GPU with 6 GB VRAM is the practical minimum; 8 GB is recommended. Model weights download on first conversion and remain local afterward.

## MCP additions

- `get_voice_conversion_provider_status` reports installation, runtime, hardware, and readiness state.
- `start_voice_conversion`, `get_voice_conversion_status`, `collect_voice_conversion`, and `abandon_voice_conversion` provide a durable job lifecycle that survives request timeouts and MCP reconnects. Stable idempotency keys prevent duplicate GPU work.
- `convert_singing_voice` remains available as a blocking compatibility tool.
- Conversion controls include diffusion quality, pitch shift, guidance strength, and 0.5×–2× performance-length adjustment.
- Capability metadata explains the voice-conversion workflow, hardware expectations, provider license, consent boundary, and isolated-vocal requirement.
- Newly generated Codex MCP configuration allows ten minutes per tool call so full-song local vocal analysis can complete on CPU; long AI generation and voice conversion still use the durable start/poll/collect workflows.

## Validation

- Delivery-graph validation, TypeScript checks, and the complete unit/domain suite pass.
- Production renderer and MCP builds pass.
- MCP smoke validates all registered tools, including Seed-VC provider status and consent-gated conversion contracts.
- Electron smoke covers provider discovery, visible header states, the Seed-VC installation experience, responsive layouts, and the existing workstation workflows.

## Downloads

- `Resonant-Setup-0.5.0-Windows-x64.exe` — standard Windows installer.
- `Resonant-0.5.0-Windows-x64.exe` — portable Windows build.
- `SHA256SUMS.txt` — checksums for verifying both executables.

The Windows executables are currently unsigned, so Windows SmartScreen may show a warning. Source installation instructions remain available in the README.
