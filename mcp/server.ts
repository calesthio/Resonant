import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createBlankProject, createDemoProject, touch } from '../src/domain/project'
import {
  analyzeMixWithInstalledInstruments, DRUM_MAP, duplicateClip, importWav, inspectProject, renderWavWithInstalledInstruments, setArrangement,
  setClipAutomation, setClipNotes, setProjectSettings, setTrackMix,
} from './music'
import { ResonantWorkspace, RevisionConflictError } from './workspace'
import { assignInstrument, getInstalledInstrument, listInstalledInstruments } from './instruments'
import { aceStepState, generateAiMusic, type AiMusicRequest } from './aceStep'
import { abandonDurableAiJob, collectDurableAiJob, getDurableAiJob, markDurableAiJobCollected, startDurableAiJob } from './aiJobs'
import { analyzeSongwriting, buildSongwritingPrompt, emptySongwritingDraft } from '../src/songwriting/core'
import { getSongwritingLanguage, listSongwritingLanguages } from '../src/songwriting/registry'
import type { SongwritingDraft } from '../src/songwriting/types'
import { hydrateProjectAudioAssets, storeEmbeddedClipAsset, storeWavAsset } from './audioAssets'
import { compareVocalLyrics, technicalVocalReadiness, transcribeSinging } from './vocalQa'

const revision = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected a 64-character project revision from inspect_project.')
const projectPath = z.string().min(1).max(500).describe('Relative .resonant path inside RESONANT_PROJECT_ROOT.')
const reference = z.string().min(1).max(200).describe('Stable ID or exact case-insensitive name returned by inspect_project.')
const beat = z.number().finite().min(0).max(16384)
const aiMusicFields = {
  prompt: z.string().trim().min(3).max(2000), lyrics: z.string().max(6000).optional(), instrumental: z.boolean().default(true),
  duration: z.number().finite().min(10).max(180).default(30), bpm: z.number().finite().min(30).max(300).optional(),
  keyScale: z.string().trim().max(40).optional(), seed: z.number().int().min(0).max(2147483647).optional(),
  language: z.string().trim().min(2).max(80).optional().describe('Installed songwriting language ID, locale, name, or alias. Native section tags are translated for ACE-Step without changing sung words.'),
  taskType: z.enum(['text2music', 'cover', 'repaint']).default('text2music').describe('ACE-Step Turbo task. Use text2music with referenceAudioPath for timbre/style guidance, cover with sourceAudioPath for whole-song structural guidance, or repaint with sourceAudioPath for a selected interval.'),
  referenceAudioPath: z.string().min(1).max(500).optional().describe('Relative path to an existing WAV inside RESONANT_PROJECT_ROOT. Guides global timbre and style, including vocal character, but is not guaranteed to clone vocal identity exactly.'),
  sourceAudioPath: z.string().min(1).max(500).optional().describe('Relative path to an existing WAV inside RESONANT_PROJECT_ROOT. Required for cover and repaint; preserves source structure or surrounding context.'),
  instruction: z.string().trim().min(3).max(1000).optional().describe('Optional ACE-Step edit instruction for cover or repaint.'),
  audioCoverStrength: z.number().finite().min(0).max(1).optional().describe('Source-structure influence from 0 to 1. Start around 0.5 to 0.7 for a recognizable but transformed cover.'),
  repaintingStart: z.number().finite().min(0).max(600).optional().describe('Repaint interval start in seconds.'),
  repaintingEnd: z.number().finite().min(-1).max(600).optional().describe('Repaint interval end in seconds; -1 means the end of the source.'),
}

export async function resolveAiMusicAudio(workspace: ResonantWorkspace, request: AiMusicRequest): Promise<AiMusicRequest> {
  const taskType = request.taskType ?? 'text2music'
  if ((taskType === 'cover' || taskType === 'repaint') && !request.sourceAudioPath) throw new Error(`${taskType} generation requires sourceAudioPath.`)
  if (taskType === 'text2music' && request.sourceAudioPath) throw new Error('sourceAudioPath is only valid for cover or repaint generation. Use referenceAudioPath to guide text-to-music timbre or style.')
  if (taskType !== 'repaint' && (request.repaintingStart !== undefined || request.repaintingEnd !== undefined)) throw new Error('Repainting intervals are only valid when taskType is repaint.')
  if (taskType === 'repaint' && request.repaintingEnd !== undefined && request.repaintingEnd !== -1 && request.repaintingEnd <= (request.repaintingStart ?? 0)) throw new Error('repaintingEnd must be greater than repaintingStart, or -1 for the end of the source.')
  return {
    ...request,
    taskType,
    referenceAudioPath: request.referenceAudioPath ? await workspace.wavPath(request.referenceAudioPath, true) : undefined,
    sourceAudioPath: request.sourceAudioPath ? await workspace.wavPath(request.sourceAudioPath, true) : undefined,
  }
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data }
}

function mutationResult(loaded: Awaited<ReturnType<ResonantWorkspace['readProject']>>, changed: string, extra: Record<string, unknown> = {}) {
  return result({ ok: true, changed, path: loaded.relativePath, revision: loaded.revision, modifiedAt: loaded.project.modifiedAt, ...extra })
}

function ensureExpected(actual: string, expected?: string) {
  if (expected !== undefined && actual !== expected) throw new RevisionConflictError(expected, actual)
}

export function createResonantServer(root?: string) {
  const workspace = new ResonantWorkspace(root)
  const server = new McpServer(
    { name: 'resonant-mcp', version: '0.4.2' },
    { instructions: 'Inspect a project before changing it and pass expectedRevision on every mutation. For any lyric or song request, call list_songwriting_languages, match the requested language by ID, name, or alias, and use that pack’s coaching guide before drafting; never silently fall back to English. Then analyze and revise the lyric before audio generation. Build musical material with clip notes, arrange, validate, analyze, and render. All paths must stay inside RESONANT_PROJECT_ROOT. Prefer a new file unless the user explicitly asked to modify an existing project.' },
  )

  server.registerTool('get_capabilities', {
    title: 'Get Resonant capabilities',
    description: 'Call first to learn the supported music model, limits, drum pitches, safe workflow, and available agent operations.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => result({
    rootAccess: 'confined to the configured project root; tools return relative paths',
    projectFormat: { extension: '.resonant', schemaVersion: 1, meter: '4/4', bpm: { min: 30, max: 300 }, audioStorage: 'content-addressed shared WAV assets; legacy embedded PCM remains readable' },
    composition: { stepsPerBeat: 4, defaultClipBeats: 4, defaultClipSteps: 16, midiPitchRange: [0, 127], drumMap: DRUM_MAP },
    tracks: ['drum', 'synth', 'sampler', 'audio'], waveforms: ['sine', 'triangle', 'sawtooth', 'square'],
    instruments: { sharedLibrary: true, formats: ['SF2', 'SF3', 'DLS', 'SFZ', 'WAV', 'WebAudioFont'], mcpDeterministicRender: ['SF2', 'SF3', 'DLS'], workflow: ['list_instruments', 'set_track_instrument', 'compose MIDI notes', 'arrange', 'analyze', 'render'] },
    songwriting: { languagePacks: listSongwritingLanguages().map((pack) => pack.id), discoverWith: 'list_songwriting_languages', guideResource: 'resonant://guide/songwriting', workflow: ['match the requested language by ID, name, or alias', 'use write_song prompt or the selected coaching guide', 'analyze_lyrics', 'revise', 'save_songwriting_draft', 'start_ai_generation'] },
    aiGeneration: { optional: true, local: true, engine: 'ACE-Step 1.5', tasks: ['text2music', 'cover', 'repaint'], audioConditioning: { referenceAudioPath: 'global timbre/style guidance; vocal identity is approximate', sourceAudioPath: 'structural source for cover or context source for repaint', format: 'existing WAV inside the configured project root' }, preferredWorkflow: ['start_ai_generation', 'poll get_ai_generation_status', 'collect_ai_generation', 'import_wav', 'arrange', 'mix', 'render'], synchronousCompatibilityTool: 'generate_ai_music' },
    mix: { volume: [0, 1.5], pan: [-1, 1], delaySend: [0, 1], masterVolume: [0, 1.5], automation: [0, 2] },
    limits: { tracks: 64, clips: 1024, arrangementBlocks: 10000, renderBeats: 512, wavImportBytes: 100_000_000, historySnapshots: 20, historyBytes: 500_000_000 },
    workflow: ['inspect or create', 'write clip notes', 'arrange clips', 'set mix and automation', 'validate', 'analyze', 'render WAV'],
    safety: ['all files remain under root', 'mutations require current revisions', 'pre-change history is automatic', 'audio payloads are never returned'],
  }))

  server.registerTool('list_projects', {
    title: 'List Resonant projects',
    description: 'Find up to 100 .resonant files within three directory levels of the configured root, excluding build and dependency folders.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => result({ projects: await workspace.listProjects() }))

  server.registerTool('get_ai_generator_status', {
    title: 'Get local AI music generator status',
    description: 'Report whether the optional shared ACE-Step 1.5 runtime and models are installed and running.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => result({ generator: await aceStepState() }))

  server.registerTool('generate_ai_music', {
    title: 'Generate original music with ACE-Step',
    description: 'Compatibility tool that blocks until ACE-Step finishes. Prefer start_ai_generation, short status polls, and collect_ai_generation for work that must survive MCP request timeouts or reconnects.',
    inputSchema: { outputPath: z.string().min(1).max(500), ...aiMusicFields, overwrite: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async ({ outputPath, overwrite, ...request }) => {
    const generated = await generateAiMusic(await resolveAiMusicAudio(workspace, request))
    const output = await workspace.writeWav(outputPath, generated.wav, overwrite)
    return result({ ok: true, output, generator: 'ACE-Step 1.5', taskId: generated.taskId, metadata: generated.metadata, seed: generated.seed, models: { dit: generated.ditModel, language: generated.languageModel } })
  })

  server.registerTool('start_ai_generation', {
    title: 'Start durable local AI generation',
    description: 'Submit an ACE-Step job and return immediately. A stable idempotencyKey makes retries and reconnects reuse the original job instead of spending GPU time twice.',
    inputSchema: { ...aiMusicFields, idempotencyKey: z.string().trim().min(8).max(200).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async ({ idempotencyKey, ...request }) => {
    const started = await startDurableAiJob(await resolveAiMusicAudio(workspace, request), idempotencyKey)
    return result({ ok: true, jobId: started.job.id, status: 'queued', createdAt: started.job.createdAt, reused: started.reused, replacedJobId: started.replacedJobId, pollWith: 'get_ai_generation_status' })
  })

  server.registerTool('get_ai_generation_status', {
    title: 'Get AI generation progress',
    description: 'Poll a durable ACE-Step job with a short request that survives MCP reconnects. Collect only after status is succeeded.',
    inputSchema: { jobId: z.string().min(1).max(80) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async ({ jobId }) => result(await getDurableAiJob(jobId)))

  server.registerTool('collect_ai_generation', {
    title: 'Collect completed AI generation',
    description: 'Download a succeeded durable ACE-Step result to a WAV inside the confined project root.',
    inputSchema: { jobId: z.string().min(1).max(80), outputPath: z.string().min(1).max(500), overwrite: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, async ({ jobId, outputPath, overwrite }) => {
    const collected = await collectDurableAiJob(jobId)
    const output = await workspace.writeWav(outputPath, collected.generated.wav, overwrite)
    await markDurableAiJobCollected(jobId, output.path)
    return result({ ok: true, jobId, output, generator: 'ACE-Step 1.5', taskId: collected.generated.taskId, metadata: collected.generated.metadata, seed: collected.generated.seed, models: { dit: collected.generated.ditModel, language: collected.generated.languageModel } })
  })

  server.registerTool('abandon_ai_generation', {
    title: 'Abandon an AI generation result',
    description: 'Prevent collection of a durable job. ACE-Step has no per-task interrupt, so an active GPU kernel may finish; stopping the shared engine would interrupt unrelated work.',
    inputSchema: { jobId: z.string().min(1).max(80) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async ({ jobId }) => result({ ok: true, ...await abandonDurableAiJob(jobId) }))

  server.registerTool('list_songwriting_languages', {
    title: 'List songwriting language packs',
    description: 'List installed language-specific songwriting packs, their native structures, and coaching capabilities.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async () => result({
    usage: 'Match the user request by id, name, locale, or alias. Use the selected coachingGuide before drafting; do not default to English when another requested language is installed.',
    languages: listSongwritingLanguages().map(({ id, name, locale, aliases, description, templates, coachingGuide }) => ({ id, name, locale, aliases: aliases ?? [], description, templates, coachingGuide })),
  }))

  server.registerTool('analyze_lyrics', {
    title: 'Analyze lyrics with a language pack',
    description: 'Evaluate section form, hook presence, approximate singability/prosody, imagery, originality, rhyme patterns, and concrete revision opportunities. Treat scores as coaching signals, not artistic truth.',
    inputSchema: { language: z.string().min(2).max(80).default('en').describe('Installed language ID, locale, name, or alias; for example zh-CN, Mandarin, Chinese, hi, or Hindi.'), title: z.string().max(200).default(''), hook: z.string().max(500).default(''), lyrics: z.string().min(1).max(20000) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async (draft) => result({ analysis: analyzeSongwriting(draft) }))

  server.registerTool('save_songwriting_draft', {
    title: 'Save a songwriting draft in a project',
    description: 'Store the structured song brief, lyrics, and generator direction inside a revision-checked Resonant project. This does not generate audio.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, language: z.string().min(2).max(80).default('en').describe('Installed language ID, locale, name, or alias.'),
      title: z.string().max(200).default(''), idea: z.string().max(4000).default(''), hook: z.string().max(500).default(''),
      pointOfView: z.enum(['first-person', 'second-person', 'third-person', 'collective']).default('first-person'),
      tense: z.enum(['past', 'present', 'future', 'mixed']).default('present'), mood: z.string().max(300).default(''), genre: z.string().max(300).default(''),
      audience: z.string().max(1000).default(''), imagery: z.string().max(3000).default(''), stylePrompt: z.string().max(2000).default(''), lyrics: z.string().max(20000).default(''),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, ...draft }) => {
    const language = getSongwritingLanguage(draft.language).id
    const canonicalDraft = { ...draft, language } as SongwritingDraft
    const loaded = await workspace.mutateProject(input, expectedRevision, 'save songwriting draft', (project) => touch({ ...project, title: draft.title.trim() || project.title, songwriting: canonicalDraft }))
    return mutationResult(loaded, 'songwriting-draft-saved', { analysis: draft.lyrics ? analyzeSongwriting(canonicalDraft) : null })
  })

  server.registerTool('list_instruments', {
    title: 'List installed instruments',
    description: 'List instruments installed once in the shared Resonant library. Use returned IDs with set_track_instrument. The desktop library manager installs and imports packs.',
    inputSchema: { query: z.string().max(100).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ query }) => {
    const library = await listInstalledInstruments()
    const needle = query?.trim().toLowerCase()
    return result({ ...library, instruments: needle ? library.instruments.filter((instrument) => `${instrument.name} ${instrument.family} ${instrument.packName}`.toLowerCase().includes(needle)) : library.instruments })
  })

  server.registerTool('create_project', {
    title: 'Create a Resonant project',
    description: 'Create a new blank or starter Resonant project. Never overwrites an existing path.',
    inputSchema: {
      path: projectPath,
      title: z.string().trim().min(1).max(200),
      bpm: z.number().finite().min(30).max(300).default(120),
      template: z.enum(['blank', 'starter']).default('blank'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ path: input, title, bpm, template }) => {
    const base = template === 'starter' ? createDemoProject() : createBlankProject()
    const project = touch({ ...base, title, bpm })
    const loaded = await workspace.writeProject(input, project, { label: 'create project' })
    return mutationResult(loaded, 'project-created', { project: inspectProject(loaded.project, loaded.relativePath, loaded.revision) })
  })

  server.registerTool('inspect_project', {
    title: 'Inspect a Resonant project',
    description: 'Return project structure, stable track/clip IDs, MIDI notes, arrangement, and mix settings without returning embedded PCM. Call before mutations.',
    inputSchema: { path: projectPath },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input }) => {
    const loaded = await workspace.readProject(input)
    return result({ project: inspectProject(loaded.project, loaded.relativePath, loaded.revision), bytes: loaded.bytes })
  })

  server.registerTool('validate_project', {
    title: 'Validate a Resonant project',
    description: 'Parse and enforce the complete Resonant schema and reference invariants without modifying the file.',
    inputSchema: { path: projectPath },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input }) => {
    const loaded = await workspace.readProject(input)
    return result({ ok: true, path: loaded.relativePath, revision: loaded.revision, bytes: loaded.bytes, title: loaded.project.title, tracks: loaded.project.tracks.length, clips: Object.keys(loaded.project.clips).length, arrangementBlocks: loaded.project.arrangement.length })
  })

  server.registerTool('set_project_settings', {
    title: 'Set project settings',
    description: 'Change title, tempo, master level, or loop region in one revision-checked transaction.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, title: z.string().trim().min(1).max(200).optional(),
      bpm: z.number().finite().min(30).max(300).optional(), masterVolume: z.number().finite().min(0).max(1.5).optional(),
      loopEnabled: z.boolean().optional(), loopStartBeat: beat.optional(), loopEndBeat: beat.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, ...settings }) => {
    const loaded = await workspace.mutateProject(input, expectedRevision, 'set project settings', (project) => setProjectSettings(project, settings))
    return mutationResult(loaded, 'project-settings')
  })

  server.registerTool('set_clip_notes', {
    title: 'Write MIDI clip notes',
    description: 'Replace or merge the notes in one MIDI clip. Steps are zero-based sixteenths; inspect the clip length first.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, clip: reference, mode: z.enum(['replace', 'merge']).default('replace'),
      notes: z.array(z.object({ step: z.number().int().min(0).max(4095), pitch: z.number().int().min(0).max(127), velocity: z.number().min(0).max(1).optional(), durationSteps: z.number().int().min(1).max(256).optional() })).max(10000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ path: input, expectedRevision, clip, notes, mode }) => {
    let changedClip = { id: '', name: '', noteCount: 0 }
    const loaded = await workspace.mutateProject(input, expectedRevision, 'set clip notes', (project) => {
      const changed = setClipNotes(project, clip, notes, mode)
      changedClip = { id: changed.clip.id, name: changed.clip.name, noteCount: changed.clip.notes.length }
      return changed.project
    })
    return mutationResult(loaded, 'clip-notes', { clip: changedClip })
  })

  server.registerTool('duplicate_clip', {
    title: 'Duplicate a clip',
    description: 'Create a variation from an existing MIDI or audio clip and optionally assign it to a track session slot.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, clip: reference, name: z.string().trim().min(1).max(200).optional(),
      track: reference.optional(), slot: z.number().int().min(0).max(31).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ path: input, expectedRevision, clip, name, track, slot }) => {
    let made = { id: '', name: '', type: '' }
    const loaded = await workspace.mutateProject(input, expectedRevision, 'duplicate clip', (project) => {
      const changed = duplicateClip(project, clip, { name, track, slot })
      made = { id: changed.clip.id, name: changed.clip.name, type: changed.clip.type }
      return changed.project
    })
    return mutationResult(loaded, 'clip-duplicated', { clip: made })
  })

  server.registerTool('set_arrangement', {
    title: 'Set the arrangement',
    description: 'Replace or append linear blocks that reference existing clips and tracks. Clip sources remain shared and loop over block length.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, mode: z.enum(['replace', 'append']).default('replace'),
      blocks: z.array(z.object({ track: reference, clip: reference, startBeat: beat, lengthBeats: z.number().finite().min(0.25).max(16384), offsetBeats: z.number().finite().min(0).max(1024).optional() })).max(1000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ path: input, expectedRevision, blocks, mode }) => {
    const loaded = await workspace.mutateProject(input, expectedRevision, 'set arrangement', (project) => setArrangement(project, blocks, mode))
    return mutationResult(loaded, 'arrangement', { arrangementBlocks: loaded.project.arrangement.length })
  })

  server.registerTool('set_track_mix', {
    title: 'Set track mix and instrument',
    description: 'Set level, pan, delay, mute/solo, or built-in synth envelope/filter parameters for one track.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, track: reference,
      volume: z.number().finite().min(0).max(1.5).optional(), pan: z.number().finite().min(-1).max(1).optional(),
      delay: z.number().finite().min(0).max(1).optional(), mute: z.boolean().optional(), solo: z.boolean().optional(),
      waveform: z.enum(['sine', 'triangle', 'sawtooth', 'square']).optional(), attack: z.number().finite().min(0.001).max(10).optional(),
      release: z.number().finite().min(0.005).max(20).optional(), filterHz: z.number().finite().min(20).max(24000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, track, ...patch }) => {
    let changedTrack = { id: '', name: '' }
    const loaded = await workspace.mutateProject(input, expectedRevision, 'set track mix', (project) => {
      const changed = setTrackMix(project, track, patch)
      changedTrack = { id: changed.track.id, name: changed.track.name }
      return changed.project
    })
    return mutationResult(loaded, 'track-mix', { track: changedTrack })
  })

  server.registerTool('set_track_instrument', {
    title: 'Assign an installed instrument',
    description: 'Assign an installed library instrument to a MIDI track, or clear it to return to Resonant’s built-in synthesizer. List instruments first and keep the current project revision.',
    inputSchema: { path: projectPath, expectedRevision: revision, track: reference, instrumentId: z.string().min(1).max(300).nullable() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, track, instrumentId }) => {
    const installed = instrumentId ? await getInstalledInstrument(instrumentId) : null
    let changedTrack = { id: '', name: '', instrument: null as string | null }
    const loaded = await workspace.mutateProject(input, expectedRevision, 'set track instrument', (project) => {
      const changed = assignInstrument(project, track, installed?.summary ?? null)
      changedTrack = { id: changed.track.id, name: changed.track.name, instrument: changed.track.instrument?.name ?? null }
      return changed.project
    })
    return mutationResult(loaded, 'track-instrument', { track: changedTrack })
  })

  server.registerTool('set_clip_automation', {
    title: 'Set clip volume automation',
    description: 'Replace a clip volume automation lane with 1–64 normalized gain values.',
    inputSchema: { path: projectPath, expectedRevision: revision, clip: reference, values: z.array(z.number().finite().min(0).max(2)).min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, clip, values }) => {
    let changedClip = { id: '', name: '' }
    const loaded = await workspace.mutateProject(input, expectedRevision, 'set clip automation', (project) => {
      const changed = setClipAutomation(project, clip, values)
      changedClip = { id: changed.clip.id, name: changed.clip.name }
      return changed.project
    })
    return mutationResult(loaded, 'clip-automation', { clip: changedClip })
  })

  server.registerTool('import_wav', {
    title: 'Import a WAV clip',
    description: 'Import a mono/stereo PCM or 32-bit float WAV into the shared content-addressed audio library and assign its small reference to an audio-track session slot.',
    inputSchema: {
      path: projectPath, expectedRevision: revision, wavPath: z.string().min(1).max(500), name: z.string().trim().min(1).max(200).optional(),
      track: reference.optional(), slot: z.number().int().min(0).max(31).default(0),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ path: input, expectedRevision, wavPath, name, track, slot }) => {
    const sourcePath = await workspace.wavPath(wavPath, true)
    const bytes = new Uint8Array(await readFile(sourcePath))
    const asset = await storeWavAsset(bytes)
    let made = { id: '', name: '', frames: 0 }
    const loaded = await workspace.mutateProject(input, expectedRevision, 'import wav', (project) => {
      const changed = importWav(project, bytes, { name: name ?? path.basename(sourcePath, path.extname(sourcePath)), track, slot, asset })
      made = { id: changed.clip.id, name: changed.clip.name, frames: changed.clip.frames }
      return changed.project
    })
    return mutationResult(loaded, 'wav-imported', { clip: made })
  })

  server.registerTool('externalize_audio_assets', {
    title: 'Move embedded audio to the shared asset library',
    description: 'Revision-checked migration for legacy projects. Stores each embedded clip once by audio hash and replaces large base64 PCM with a small reference. Existing shared clips are unchanged.',
    inputSchema: { path: projectPath, expectedRevision: revision },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision }) => {
    const before = await workspace.readProject(input)
    ensureExpected(before.revision, expectedRevision)
    const replacements = new Map<string, Awaited<ReturnType<typeof storeEmbeddedClipAsset>>>()
    for (const clip of Object.values(before.project.clips)) if (clip.type === 'audio' && clip.pcmBase64) replacements.set(clip.id, await storeEmbeddedClipAsset(clip))
    const loaded = replacements.size ? await workspace.mutateProject(input, expectedRevision, 'externalize audio assets', (project) => {
      const clips = { ...project.clips }
      for (const [id, asset] of replacements) { const clip = clips[id]; if (clip?.type === 'audio') { const changed = { ...clip, asset }; delete changed.pcmBase64; clips[id] = changed } }
      return { ...project, clips }
    }) : before
    const cachedAssets = new Map<string, Awaited<ReturnType<typeof storeEmbeddedClipAsset>>>()
    const history = await workspace.transformHistory(input, async (project) => {
      const clips = { ...project.clips }
      for (const clip of Object.values(clips)) if (clip.type === 'audio' && clip.pcmBase64) {
        const key = createHash('sha256').update(clip.pcmBase64).digest('hex')
        let asset = cachedAssets.get(key)
        if (!asset) { asset = await storeEmbeddedClipAsset(clip); cachedAssets.set(key, asset) }
        const changed = { ...clip, asset }; delete changed.pcmBase64; clips[clip.id] = changed
      }
      return { ...project, clips }
    })
    if (!replacements.size && !history.changedSnapshots) return result({ ok: true, changed: 'no-embedded-audio', path: before.relativePath, revision: before.revision, migratedClips: 0, projectBytes: before.bytes, history })
    return mutationResult(loaded, 'audio-assets-externalized', { migratedClips: replacements.size, projectBytesBefore: before.bytes, projectBytesAfter: loaded.bytes, sharedBytes: [...replacements.values()].reduce((sum, asset) => sum + asset.bytes, 0), deduplicatedAssets: new Set([...replacements.values()].map((asset) => asset.id)).size, history })
  })

  server.registerTool('analyze_vocal_lyrics', {
    title: 'Analyze vocal lyric delivery',
    description: 'Measure lyric density and low-energy boundaries, then optionally compare lyrics with a supplied transcript or local Whisper transcription. Singing transcription is approximate and never replaces listening approval.',
    inputSchema: { wavPath: z.string().min(1).max(500), lyrics: z.string().min(1).max(20000), transcript: z.string().max(30000).optional(), localModel: z.enum(['skip', 'tiny.en', 'base.en']).default('skip') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  }, async ({ wavPath, lyrics, transcript, localModel }) => {
    const sourcePath = await workspace.wavPath(wavPath, true), bytes = new Uint8Array(await readFile(sourcePath))
    const technical = technicalVocalReadiness(bytes, lyrics)
    let observed = transcript, chunks: Array<{ text: string; timestamp?: [number, number] }> = [], model: string | null = null
    if (!observed && localModel !== 'skip') { const transcription = await transcribeSinging(sourcePath, localModel); observed = transcription.text || ''; chunks = transcription.chunks || []; model = `openai/whisper-${localModel}` }
    const alignment = observed ? { status: 'estimated' as const, model: model || 'user-supplied transcript', ...compareVocalLyrics(lyrics, observed), transcript: observed, chunks, confidenceNotice: 'Mixed-song ASR can confuse sustained vowels, backing vocals, repeats, and effects. Treat coverage as a triage signal and listen to every flagged passage.' } : { status: 'not-measured' as const, confidenceNotice: 'Provide a transcript or explicitly select a local Whisper model to estimate lyric coverage. Pronunciation still requires listening approval.' }
    return result({ path: wavPath, technical, alignment, listeningApprovalRequired: ['pronunciation', 'vocal identity', 'emotion', 'melody', 'backing-vocal intelligibility'] })
  })

  server.registerTool('analyze_mix', {
    title: 'Analyze the rendered mix',
    description: 'Render through Resonant DSP and report peak, RMS, crest factor, stereo balance/correlation, DC offset, clipped samples, and actionable warnings.',
    inputSchema: { path: projectPath, expectedRevision: revision.optional(), durationBeats: z.number().finite().min(1).max(512).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, durationBeats }) => {
    const loaded = await workspace.readProject(input)
    ensureExpected(loaded.revision, expectedRevision)
    return result({ path: loaded.relativePath, revision: loaded.revision, analysis: await analyzeMixWithInstalledInstruments(await hydrateProjectAudioAssets(loaded.project), getInstalledInstrument, durationBeats) })
  })

  server.registerTool('render_wav', {
    title: 'Render a stereo WAV',
    description: 'Render the arrangement with Resonant deterministic DSP to a 44.1 kHz, 16-bit stereo WAV inside the project root.',
    inputSchema: {
      path: projectPath, expectedRevision: revision.optional(), outputPath: z.string().min(1).max(500),
      durationBeats: z.number().finite().min(1).max(512).optional(), overwrite: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input, expectedRevision, outputPath, durationBeats, overwrite }) => {
    const loaded = await workspace.readProject(input)
    ensureExpected(loaded.revision, expectedRevision)
    const wav = await renderWavWithInstalledInstruments(await hydrateProjectAudioAssets(loaded.project), getInstalledInstrument, durationBeats)
    const output = await workspace.writeWav(outputPath, wav, overwrite)
    return result({ ok: true, path: loaded.relativePath, revision: loaded.revision, output, format: { sampleRate: 44100, channels: 2, bitDepth: 16 } })
  })

  server.registerTool('list_history', {
    title: 'List agent change history',
    description: 'List up to 20 validated pre-change snapshots created automatically for a project.',
    inputSchema: { path: projectPath },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  }, async ({ path: input }) => result({ path: input, history: await workspace.listHistory(input) }))

  server.registerTool('undo_last_change', {
    title: 'Undo the last agent change',
    description: 'Restore the newest pre-change snapshot after checking that the current revision still matches what the agent inspected.',
    inputSchema: { path: projectPath, expectedRevision: revision },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ path: input, expectedRevision }) => {
    const loaded = await workspace.undoLastChange(input, expectedRevision)
    return mutationResult(loaded, 'agent-change-undone')
  })

  server.registerResource('agent-production-guide', 'resonant://guide/production', {
    title: 'Resonant agent production guide', description: 'Safe composition, arrangement, mixing, validation, and rendering workflow.', mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# Resonant production loop\n\n1. Inspect and keep the returned revision.\n2. Write short coherent clip patterns. Drum pitches: kick 36, snare 38, closed hat 42, open hat 46.\n3. Arrange shared clips over the requested number of beats.\n4. Mix conservatively; preserve headroom.\n5. Validate and analyze. Treat warnings as evaluator feedback and adjust deliberately.\n6. Render to a new WAV path.\n\nNever invent IDs or edit embedded PCM. Re-inspect after any revision conflict.` }] }))

  server.registerResource('songwriting-guide', 'resonant://guide/songwriting', {
    title: 'Resonant songwriting guide', description: 'Language-pack-aware lyric development, revision, analysis, and generator handoff.', mimeType: 'text/markdown',
  }, async (uri) => {
    const languageGuides = listSongwritingLanguages().map((pack) => `## ${pack.name} (${pack.id})\n\n${pack.coachingGuide}`).join('\n\n')
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# Resonant songwriting loop\n\n1. Define one song promise: who wants what, why now, and what changes.\n2. Choose a point of view, tense, image bank, hook, and section structure.\n3. Draft section-tagged lyrics. Verses advance scenes; choruses deliver the central promise; a bridge must reveal, decide, or reframe.\n4. Call analyze_lyrics. Use its measurements as revision signals, never as a substitute for taste. Chorus and explicit-hook repetition is intentional; duplicated verse lines are not.\n5. Revise the weakest meaningful area and analyze again.\n6. Save with save_songwriting_draft. Submit generation with a stable idempotency key, poll get_ai_generation_status, collect the WAV, then run analyze_vocal_lyrics before final listening approval.\n\n${languageGuides}\n\nDo not imitate a living artist, reuse recognizable lyrics, or force a rhyme at the expense of meaning.` }] }
  })

  server.registerPrompt('produce_track', {
    title: 'Produce a Resonant track', description: 'A reusable blank-to-render workflow for an autonomous music-production request.',
    argsSchema: { brief: z.string().min(1).max(2000), projectPath: z.string().min(1).max(500), bars: z.string().optional() },
  }, ({ brief, projectPath: target, bars }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Create a Resonant project at ${target} from this brief: ${brief}\nTarget length: ${bars ?? 'choose an appropriate short form'} bars. Use get_capabilities, keep revisions current, compose clips, arrange, mix, validate, analyze and iterate on warnings, then render a WAV beside the project. Do not overwrite unrelated files.` } }] }))

  server.registerPrompt('write_song', {
    title: 'Write an original song', description: 'Develop a song idea into original, section-tagged, generator-ready lyrics using an installed language pack.',
    argsSchema: { idea: z.string().min(1).max(4000), language: z.string().max(80).optional().describe('Installed language ID, locale, name, or alias. Call list_songwriting_languages when unsure.'), title: z.string().optional(), hook: z.string().optional(), genre: z.string().optional(), mood: z.string().optional(), stylePrompt: z.string().optional() },
  }, ({ idea, language, title, hook, genre, mood, stylePrompt }) => {
    const draft = { ...emptySongwritingDraft(language || 'en'), idea, title: title || '', hook: hook || '', genre: genre || '', mood: mood || '', stylePrompt: stylePrompt || '' }
    return { messages: [{ role: 'user', content: { type: 'text', text: `${buildSongwritingPrompt(draft)}\n\nAfter drafting, call analyze_lyrics. Revise the weakest meaningful craft dimension at least once, then save the accepted draft with save_songwriting_draft if a target project is available.` } }] }
  })

  return server
}

async function main() {
  const rootFlag = process.argv.indexOf('--root')
  const root = rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined
  if (rootFlag >= 0 && !root) throw new Error('--root requires a directory path.')
  const server = createResonantServer(root)
  await server.connect(new StdioServerTransport())
  console.error('Resonant MCP ready on stdio.')
}

const launchedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === launchedPath) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
