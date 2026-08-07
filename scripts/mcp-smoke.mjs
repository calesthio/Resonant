import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { BasicSoundBank, SoundBankLoader } from 'spessasynth_core'

const root = process.cwd()
const scratch = await mkdtemp(path.join(tmpdir(), 'resonant-mcp-smoke-'))
const evidence = path.join(root, '.agent', 'evidence')
const serverPath = path.join(root, 'mcp-dist', 'server.mjs')
const instrumentRoot = path.join(scratch, 'instrument-library')
const aceRoot = path.join(scratch, 'ace-step-not-installed')
const seedVcRoot = path.join(scratch, 'seed-vc-not-installed')
const audioAssetRoot = path.join(scratch, 'audio-assets')
const smokePack = path.join(instrumentRoot, 'packs', 'smoke-soundfont')
await mkdir(smokePack, { recursive: true })
const smokeSoundFont = BasicSoundBank.getSampleSoundBankFile()
await writeFile(path.join(smokePack, 'smoke.sf2'), new Uint8Array(smokeSoundFont))
const smokePreset = SoundBankLoader.fromArrayBuffer(smokeSoundFont).presets[0]
await writeFile(path.join(smokePack, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, id: 'smoke-soundfont', name: 'Smoke SoundFont', version: '1', format: 'soundfont', bytes: smokeSoundFont.byteLength, installedAt: new Date().toISOString(),
  instruments: [{ id: 'saw', name: smokePreset.name, family: 'Test', format: 'soundfont', file: 'smoke.sf2', program: smokePreset.program, bankMSB: smokePreset.bankMSB, bankLSB: smokePreset.bankLSB, percussion: smokePreset.isDrum }],
}))
process.env.RESONANT_INSTRUMENT_ROOT = instrumentRoot
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--root', scratch], env: { ...process.env, RESONANT_INSTRUMENT_ROOT: instrumentRoot, RESONANT_ACE_ROOT: aceRoot, RESONANT_SEED_VC_ROOT: seedVcRoot, RESONANT_AUDIO_ASSET_ROOT: audioAssetRoot }, stderr: 'pipe' })
const client = new Client({ name: 'resonant-release-smoke', version: '0.4.0' })
const smokeStarted = performance.now()

function parse(call) {
  const block = call.content?.find((candidate) => candidate.type === 'text')
  if (!block || block.type !== 'text') throw new Error('MCP result did not contain JSON text.')
  const data = JSON.parse(block.text)
  if (call.isError) throw new Error(data.error ?? block.text)
  return data
}

async function call(name, args = {}) {
  return parse(await client.callTool({ name, arguments: args }))
}

try {
  await client.connect(transport)
  const connectedMs = performance.now() - smokeStarted
  const tools = await client.listTools()
  const voiceTools = ['get_voice_conversion_provider_status', 'start_voice_conversion', 'get_voice_conversion_status', 'collect_voice_conversion', 'abandon_voice_conversion', 'convert_singing_voice']
  if (voiceTools.some((name) => !tools.tools.some((tool) => tool.name === name))) throw new Error('The durable Seed-VC MCP tool family is incomplete.')
  const startVoiceTool = tools.tools.find((tool) => tool.name === 'start_voice_conversion')
  if (!startVoiceTool?.inputSchema?.properties?.lengthAdjust) throw new Error('Seed-VC length adjustment is missing from the MCP schema.')
  const resources = await client.listResources()
  const prompts = await client.listPrompts()
  const guide = await client.readResource({ uri: 'resonant://guide/production' })
  const songwritingGuide = await client.readResource({ uri: 'resonant://guide/songwriting' })
  const productionPrompt = await client.getPrompt({ name: 'produce_track', arguments: { brief: 'A restrained nocturnal electronic cue', projectPath: 'agent-composition.resonant', bars: '8' } })
  const songwritingPrompt = await client.getPrompt({ name: 'write_song', arguments: { idea: 'Two old friends pack the last box before one moves away', genre: 'intimate alternative pop', hook: 'Leave the porch light on' } })
  const mandarinSongwritingPrompt = await client.getPrompt({ name: 'write_song', arguments: { idea: 'Two strangers miss the last train and finally speak honestly', language: 'Chinese', genre: 'contemporary pop ballad' } })
  const hindiSongwritingPrompt = await client.getPrompt({ name: 'write_song', arguments: { idea: 'Two friends shelter from the first monsoon rain', language: 'Hindi', genre: 'indie folk' } })
  const koreanSongwritingPrompt = await client.getPrompt({ name: 'write_song', arguments: { idea: 'The last trainee leaves the practice room and finally calls home', language: 'K-pop', genre: 'performance pop' } })
  const spanishSongwritingPrompt = await client.getPrompt({ name: 'write_song', arguments: { idea: 'Two old friends meet again on the malecón', language: 'Latino', genre: 'salsa' } })
  const japaneseSongwritingPrompt = await client.getPrompt({ name: 'write_song', arguments: { idea: 'A courier races the sunrise to deliver one forgotten letter', language: 'J-pop', genre: 'anime opening' } })
  const capabilities = await call('get_capabilities')
  if (capabilities.singingVoiceConversion.preferredWorkflow?.[3] !== 'start_voice_conversion' || capabilities.singingVoiceConversion.synchronousCompatibilityTool !== 'convert_singing_voice') throw new Error('Seed-VC durable-job discovery is incomplete.')
  const songwritingLanguages = await call('list_songwriting_languages')
  if (!songwritingLanguages.languages.some((language) => language.id === 'en')) throw new Error('English songwriting language pack is missing.')
  if (!songwritingLanguages.languages.some((language) => language.id === 'hi')) throw new Error('Hindi songwriting language pack is missing.')
  const mandarinLanguage = songwritingLanguages.languages.find((language) => language.id === 'zh-CN')
  if (!mandarinLanguage) throw new Error('Mandarin songwriting language pack is missing.')
  if (!mandarinLanguage.aliases.includes('Chinese') || !mandarinLanguage.aliases.includes('Mandarin')) throw new Error('Mandarin aliases are not discoverable to a context-free agent.')
  if (!mandarinLanguage.coachingGuide.includes('Standard Mandarin') || !mandarinLanguage.templates.some((template) => template.id === 'mandarin-hip-hop')) throw new Error('Mandarin craft guidance is incomplete in MCP discovery.')
  const discoveryChecks = [
    { id: 'ko-KR', alias: 'K-pop', template: 'kpop-performance', guide: 'Korean–English code-switching' },
    { id: 'es-419', alias: 'Latino', template: 'salsa-tropical', guide: 'tú, vos, usted' },
    { id: 'ja-JP', alias: 'J-pop', template: 'anime-opening', guide: 'Aメロ' },
  ]
  for (const expected of discoveryChecks) {
    const language = songwritingLanguages.languages.find((candidate) => candidate.id === expected.id)
    if (!language) throw new Error(`${expected.id} songwriting language pack is missing.`)
    if (!language.aliases.includes(expected.alias)) throw new Error(`${expected.id} aliases are not discoverable to a context-free agent.`)
    if (!language.templates.some((template) => template.id === expected.template) || !language.coachingGuide.includes(expected.guide)) throw new Error(`${expected.id} craft guidance is incomplete in MCP discovery.`)
  }
  const mandarinPromptText = mandarinSongwritingPrompt.messages.find((message) => message.content.type === 'text')?.content.text ?? ''
  const hindiPromptText = hindiSongwritingPrompt.messages.find((message) => message.content.type === 'text')?.content.text ?? ''
  const koreanPromptText = koreanSongwritingPrompt.messages.find((message) => message.content.type === 'text')?.content.text ?? ''
  const spanishPromptText = spanishSongwritingPrompt.messages.find((message) => message.content.type === 'text')?.content.text ?? ''
  const japanesePromptText = japaneseSongwritingPrompt.messages.find((message) => message.content.type === 'text')?.content.text ?? ''
  if (!mandarinPromptText.includes('Mandarin Chinese (Simplified)') || !mandarinPromptText.includes('副歌')) throw new Error('The write_song prompt did not resolve the Chinese alias to Mandarin guidance.')
  if (!hindiPromptText.includes('Hindi / Hindustani') || !hindiPromptText.includes('short mukhda') || !hindiPromptText.includes('Devanagari')) throw new Error('The write_song prompt did not resolve the Hindi alias to Hindi guidance.')
  if (!koreanPromptText.includes('Korean (K-pop)') || !koreanPromptText.includes('포스트코러스')) throw new Error('The write_song prompt did not resolve the K-pop alias to Korean guidance.')
  if (!spanishPromptText.includes('Spanish (Latin American)') || !spanishPromptText.includes('coro–pregón')) throw new Error('The write_song prompt did not resolve the Latino alias to Latin American Spanish guidance.')
  if (!japanesePromptText.includes('Japanese (J-pop)') || !japanesePromptText.includes('ラスサビ')) throw new Error('The write_song prompt did not resolve the J-pop alias to Japanese guidance.')
  const lyricAnalysis = await call('analyze_lyrics', { language: 'en', title: 'Porch Light', hook: 'Leave the porch light on', lyrics: '[Verse 1]\nBlue tape hanging from the kitchen door\nCoffee cooling while we pack the floor\n\n[Chorus]\nLeave the porch light on\nLeave the porch light on\nI will find the old road home\n\n[Bridge]\nMaybe leaving tells us what remains' })
  if (lyricAnalysis.analysis.counts.sections !== 3) throw new Error('Songwriting analysis did not preserve tagged sections.')
  const hindiLyricAnalysis = await call('analyze_lyrics', { language: 'hi', title: 'बारिश बन के आ', hook: 'तू बारिश बन के आ', lyrics: '[अंतरा 1]\nखिड़की पर चाय ठंडी होती रही\n\n[मुखड़ा]\nतू बारिश बन के आ\nतू बारिश बन के आ\n\n[सेतु]\nआज दरवाज़ा खुला रखूँगा' })
  if (hindiLyricAnalysis.analysis.sections.map((section) => section.kind).join(',') !== 'verse,chorus,bridge') throw new Error('Hindi songwriting pack did not recognize native section labels.')
  const mandarinLyricAnalysis = await call('analyze_lyrics', { language: 'Mandarin', title: '等天亮', hook: '等天亮', lyrics: '[主歌 1]\n凌晨两点末班地铁离站\n我把没说的话留在车窗\n\n[副歌]\n等天亮 等天亮\n等天亮 等天亮\n\n[桥段]\n这一次我不再绕开真相' })
  if (mandarinLyricAnalysis.analysis.language !== 'zh-CN' || mandarinLyricAnalysis.analysis.sections.map((section) => section.kind).join(',') !== 'verse,chorus,bridge') throw new Error('Mandarin alias resolution or native section discovery failed.')
  const koreanLyricAnalysis = await call('analyze_lyrics', { language: 'K-pop', title: '여기 있어 줘', hook: '여기 있어 줘', lyrics: '[벌스 1]\n새벽 두 시 편의점 불빛 아래\n\n[프리코러스]\n진동 한 번에 숨을 멈춰\n\n[후렴]\n여기 있어 줘\n여기 있어 줘\n\n[브리지]\n이제 내가 먼저 말할게' })
  if (koreanLyricAnalysis.analysis.language !== 'ko-KR' || koreanLyricAnalysis.analysis.sections.map((section) => section.kind).join(',') !== 'verse,pre-chorus,chorus,bridge') throw new Error('K-pop alias resolution or Korean section discovery failed.')
  const spanishLyricAnalysis = await call('analyze_lyrics', { language: 'Latino', title: 'Un minuto más', hook: 'Quédate un minuto más', lyrics: '[Verso 1]\nDejé las llaves junto al vaso\n\n[Pre-coro]\nDime lo que nunca pude oír\n\n[Coro]\nQuédate un minuto más\nQuédate un minuto más\n\n[Puente]\nLa madrugada ya nos vio cambiar' })
  if (spanishLyricAnalysis.analysis.language !== 'es-419' || spanishLyricAnalysis.analysis.sections.map((section) => section.kind).join(',') !== 'verse,pre-chorus,chorus,bridge') throw new Error('Latino alias resolution or Spanish section discovery failed.')
  const japaneseLyricAnalysis = await call('analyze_lyrics', { language: 'J-pop', title: 'あと一分', hook: 'あと一分だけ', lyrics: '[Aメロ 1]\n終電あとのホームで待ってる\n\n[Bメロ]\nほんとはもう分かってる\n\n[サビ]\nあと一分だけ\nあと一分だけ\n\n[Cメロ]\n私から先に言うよ' })
  if (japaneseLyricAnalysis.analysis.language !== 'ja-JP' || japaneseLyricAnalysis.analysis.sections.map((section) => section.kind).join(',') !== 'verse,pre-chorus,chorus,bridge') throw new Error('J-pop alias resolution or Japanese section discovery failed.')
  const aiGenerator = await call('get_ai_generator_status')
  if (aiGenerator.generator.installed || aiGenerator.generator.running) throw new Error('MCP AI generator status ignored its isolated smoke root.')
  const voiceProvider = await call('get_voice_conversion_provider_status')
  if (voiceProvider.provider.installed || voiceProvider.provider.profile.model !== 'seed-uvit-whisper-base') throw new Error('MCP Seed-VC status ignored its isolated smoke root or model profile.')
  const installedInstruments = await call('list_instruments')
  if (!installedInstruments.instruments.length) throw new Error('MCP did not discover the shared smoke SoundFont.')
  const created = await call('create_project', { path: 'agent-composition.resonant', title: 'Midnight Circuit', bpm: 96, template: 'blank' })
  const firstRevision = created.revision
  let inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  await call('save_songwriting_draft', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, language: 'Chinese', title: '等天亮', idea: 'Two strangers miss the last train and speak honestly', hook: '等天亮', pointOfView: 'collective', tense: 'present', mood: 'restrained and hopeful', genre: 'contemporary Mandarin pop', audience: 'two strangers on an empty platform', imagery: '凌晨, 地铁, 站台, 车窗', stylePrompt: 'contemporary Mandarin pop ballad, close vocal, restrained verse', lyrics: '[主歌]\n凌晨两点末班地铁离站\n\n[副歌]\n等天亮 等天亮\n等天亮 等天亮' })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.songwriting?.language !== 'zh-CN') throw new Error('Saving with the Chinese alias did not persist the canonical Mandarin language ID.')
  await call('save_songwriting_draft', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, language: 'K-pop', title: '여기 있어 줘', idea: 'The last trainee finally calls home', hook: '여기 있어 줘', pointOfView: 'first-person', tense: 'present', mood: 'exhausted and hopeful', genre: 'K-pop', audience: 'someone waiting at home', imagery: '새벽, 연습실, 편의점, 진동', stylePrompt: 'K-pop performance track, intimate verse, wide chorus', lyrics: '[벌스]\n새벽 연습실 문을 닫아\n\n[후렴]\n여기 있어 줘\n여기 있어 줘' })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.songwriting?.language !== 'ko-KR') throw new Error('Saving with the K-pop alias did not persist the canonical Korean language ID.')
  await call('save_songwriting_draft', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, language: 'Latino', title: 'Un minuto más', idea: 'Two old friends meet again by the sea', hook: 'Quédate un minuto más', pointOfView: 'first-person', tense: 'present', mood: 'warm and unresolved', genre: 'Latin pop', audience: 'an old friend', imagery: 'malecón, vaso, llaves, madrugada', stylePrompt: 'Latin pop, intimate verse, communal chorus', lyrics: '[Verso]\nDejé las llaves junto al vaso\n\n[Coro]\nQuédate un minuto más\nQuédate un minuto más' })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.songwriting?.language !== 'es-419') throw new Error('Saving with the Latino alias did not persist the canonical Spanish language ID.')
  await call('save_songwriting_draft', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, language: 'J-pop', title: 'あと一分', idea: 'One last minute on an empty station platform', hook: 'あと一分だけ', pointOfView: 'first-person', tense: 'present', mood: 'restrained and urgent', genre: 'J-pop', audience: 'someone about to leave', imagery: '終電, ホーム, 通知, 袖口', stylePrompt: 'J-pop, rising B-melo, open final chorus', lyrics: '[Aメロ]\n終電あとのホームで待ってる\n\n[サビ]\nあと一分だけ\nあと一分だけ' })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.songwriting?.language !== 'ja-JP') throw new Error('Saving with the J-pop alias did not persist the canonical Japanese language ID.')
  await call('save_songwriting_draft', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, language: 'en', title: 'Midnight Circuit', idea: 'Choose connection over the safety of leaving first', hook: 'Meet me where the street goes quiet', pointOfView: 'collective', tense: 'present', mood: 'restless but hopeful', genre: 'nocturnal electronic pop', audience: 'two people afraid to be direct', imagery: 'wet asphalt, dashboard glow, last train', stylePrompt: 'restrained nocturnal electronic pop, intimate verse, widening chorus', lyrics: '[Verse]\nDashboard blue across your face\n\n[Chorus]\nMeet me where the street goes quiet\nMeet me where the street goes quiet' })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.songwriting?.language !== 'en') throw new Error('Saved songwriting draft was not observable on re-inspection.')
  const clipFor = (trackName) => inspected.tracks.find((track) => track.name === trackName).sessionSlots[0].clipId

  const patterns = [
    ['Pulse', [{ step: 0, pitch: 36, velocity: 1 }, { step: 4, pitch: 36, velocity: 0.72 }, { step: 8, pitch: 36, velocity: 0.9 }, { step: 11, pitch: 36, velocity: 0.58 }]],
    ['Snap', [{ step: 4, pitch: 38, velocity: 0.82 }, { step: 12, pitch: 38, velocity: 0.88 }, { step: 2, pitch: 42, velocity: 0.34 }, { step: 6, pitch: 42, velocity: 0.42 }, { step: 10, pitch: 42, velocity: 0.36 }, { step: 14, pitch: 46, velocity: 0.48 }]],
    ['Lowline', [{ step: 0, pitch: 36, velocity: 0.82, durationSteps: 3 }, { step: 4, pitch: 36, velocity: 0.7, durationSteps: 2 }, { step: 8, pitch: 39, velocity: 0.76, durationSteps: 3 }, { step: 12, pitch: 34, velocity: 0.72, durationSteps: 3 }]],
    ['Prism', [{ step: 0, pitch: 60, velocity: 0.55, durationSteps: 3 }, { step: 3, pitch: 63, velocity: 0.48, durationSteps: 2 }, { step: 6, pitch: 67, velocity: 0.52, durationSteps: 3 }, { step: 10, pitch: 70, velocity: 0.46, durationSteps: 2 }, { step: 13, pitch: 67, velocity: 0.5, durationSteps: 3 }]],
  ]
  for (const [track, notes] of patterns) {
    const changed = await call('set_clip_notes', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, clip: clipFor(track), notes })
    inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
    if (changed.revision !== inspected.revision) throw new Error('Mutation revision was not observable on re-inspection.')
  }

  await call('set_track_instrument', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, track: 'Lowline', instrumentId: installedInstruments.instruments[0].id })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.tracks.find((track) => track.name === 'Lowline').instrument?.name !== smokePreset.name) throw new Error('MCP instrument assignment was not observable.')

  const duplicated = await call('duplicate_clip', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, clip: clipFor('Prism'), name: 'Prism B', track: 'Prism', slot: 1 })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  const prismVariation = duplicated.clip.id
  await call('set_clip_notes', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, clip: prismVariation, notes: [{ step: 0, pitch: 58, velocity: 0.5, durationSteps: 3 }, { step: 3, pitch: 62, velocity: 0.46, durationSteps: 2 }, { step: 7, pitch: 65, velocity: 0.52, durationSteps: 3 }, { step: 11, pitch: 69, velocity: 0.44, durationSteps: 2 }, { step: 14, pitch: 65, velocity: 0.48, durationSteps: 2 }] })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project

  const blocks = patterns.filter(([track]) => track !== 'Prism').map(([track]) => ({ track, clip: clipFor(track), startBeat: 0, lengthBeats: 32 }))
  blocks.push({ track: 'Prism', clip: clipFor('Prism'), startBeat: 0, lengthBeats: 16 }, { track: 'Prism', clip: prismVariation, startBeat: 16, lengthBeats: 16 })
  let changed = await call('set_arrangement', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, blocks })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  changed = await call('set_track_mix', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, track: 'Lowline', volume: 0.62, pan: -0.12, waveform: 'square', filterHz: 1200, release: 0.34 })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  changed = await call('set_track_mix', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, track: 'Prism', volume: 0.48, pan: 0.18, delay: 0.36, waveform: 'triangle', attack: 0.03, release: 0.55 })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  changed = await call('set_project_settings', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, masterVolume: 0.78, loopEnabled: true, loopStartBeat: 0, loopEndBeat: 32 })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  changed = await call('set_clip_automation', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, clip: clipFor('Prism'), values: [0.55, 0.62, 0.7, 0.78, 0.86, 0.94, 1, 0.92, 0.84, 0.76, 0.68, 0.74, 0.82, 0.9, 0.96, 0.88] })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (changed.revision !== inspected.revision) throw new Error('Final mutation revision mismatch.')

  const analysis = await call('analyze_mix', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, durationBeats: 32 })
  const renderA = await call('render_wav', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, outputPath: 'agent-composition.wav', durationBeats: 32 })
  const renderB = await call('render_wav', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, outputPath: 'agent-composition-repeat.wav', durationBeats: 32 })
  if (renderA.output.sha256 !== renderB.output.sha256) throw new Error('Repeated MCP renders were not deterministic.')
  const imported = await call('import_wav', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, wavPath: 'agent-composition.wav', name: 'Reference print', track: 'Audio', slot: 0 })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (!inspected.clips.find((clip) => clip.id === imported.clip.id)?.asset?.id) throw new Error('MCP WAV import did not use the shared content-addressed audio library.')
  const externalized = await call('externalize_audio_assets', { path: 'agent-composition.resonant', expectedRevision: inspected.revision })
  if (externalized.migratedClips !== 0) throw new Error('Already-shared MCP audio was unexpectedly migrated again.')
  const vocalQa = await call('analyze_vocal_lyrics', { wavPath: 'agent-composition.wav', lyrics: '[Chorus]\nMeet me where the street goes quiet', transcript: 'Meet me where the street goes quiet', localModel: 'skip' })
  if (vocalQa.alignment.estimatedCoverage !== 1) throw new Error('Supplied-transcript vocal QA did not report complete lyric coverage.')
  const importedClipCount = inspected.clips.length
  const undone = await call('undo_last_change', { path: 'agent-composition.resonant', expectedRevision: inspected.revision })
  inspected = (await call('inspect_project', { path: 'agent-composition.resonant' })).project
  if (inspected.clips.length !== importedClipCount - 1 || undone.revision !== inspected.revision) throw new Error('MCP undo did not restore the pre-import project.')
  const validation = await call('validate_project', { path: 'agent-composition.resonant' })
  const listed = await call('list_projects')

  const rejected = []
  const expectError = async (key, name, args) => {
    const response = await client.callTool({ name, arguments: args })
    if (!response.isError) throw new Error(`Expected ${name} to reject ${key}.`)
    rejected.push(key)
  }
  await expectError('staleRevision', 'set_project_settings', { path: 'agent-composition.resonant', expectedRevision: firstRevision, bpm: 110 })
  await expectError('pathTraversal', 'render_wav', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, outputPath: '../escape.wav' })
  await expectError('invalidPitch', 'set_clip_notes', { path: 'agent-composition.resonant', expectedRevision: inspected.revision, clip: clipFor('Pulse'), notes: [{ step: 0, pitch: 200 }] })
  await expectError('voiceProviderNotInstalled', 'start_voice_conversion', { sourceAudioPath: 'agent-composition.wav', referenceAudioPath: 'agent-composition.wav', voiceRightsConfirmed: true, lengthAdjust: 1.25, idempotencyKey: 'smoke-voice-job' })
  const history = await call('list_history', { path: 'agent-composition.resonant' })

  await mkdir(evidence, { recursive: true })
  await copyFile(path.join(scratch, 'agent-composition.resonant'), path.join(evidence, 'agent-composition.resonant'))
  await copyFile(path.join(scratch, 'agent-composition.wav'), path.join(evidence, 'agent-composition.wav'))
  const report = {
    tools: tools.tools.map((tool) => tool.name), toolCount: tools.tools.length,
    resources: resources.resources.map((resource) => resource.uri), resourceReadable: guide.contents.length > 0 && songwritingGuide.contents.length > 0,
    prompts: prompts.prompts.map((prompt) => prompt.name), promptReadable: productionPrompt.messages.length > 0 && songwritingPrompt.messages.length > 0,
    rootConfined: capabilities.rootAccess.includes('confined'), project: { title: inspected.title, bpm: inspected.bpm, revision: inspected.revision, tracks: inspected.tracks.length, clips: inspected.clips.length, arrangementBlocks: inspected.arrangement.length },
    validation, analysis: analysis.analysis, render: renderA.output, deterministicRepeatHash: renderB.output.sha256,
    importedThenUndone: { clipId: imported.clip.id, restoredClipCount: inspected.clips.length }, listedProjects: listed.projects.length,
    installedInstruments: installedInstruments.instruments.length, instrumentRender: inspected.tracks.find((track) => track.name === 'Lowline').instrument, aiGenerator: aiGenerator.generator,
    songwriting: { languages: songwritingLanguages.languages.map((language) => language.id), analysis: lyricAnalysis.analysis.scores, hindiAnalysis: hindiLyricAnalysis.analysis.scores, mandarinAnalysis: mandarinLyricAnalysis.analysis.scores, koreanAnalysis: koreanLyricAnalysis.analysis.scores, spanishAnalysis: spanishLyricAnalysis.analysis.scores, japaneseAnalysis: japaneseLyricAnalysis.analysis.scores, aliasPrompts: { chinese: mandarinPromptText.includes('Mandarin Chinese (Simplified)'), hindi: hindiPromptText.includes('Hindi / Hindustani'), kpop: koreanPromptText.includes('Korean (K-pop)'), latino: spanishPromptText.includes('Spanish (Latin American)'), jpop: japanesePromptText.includes('Japanese (J-pop)') }, saved: inspected.songwriting?.language === 'en' },
    audioAssets: { importedAsset: imported.clip.id, externalized }, vocalQa: { coverage: vocalQa.alignment.estimatedCoverage, technical: vocalQa.technical },
    historySnapshots: history.history.length, rejected, timing: { connectedMs: Math.round(connectedMs), completedMs: Math.round(performance.now() - smokeStarted) },
  }
  await writeFile(path.join(evidence, 'mcp-smoke.json'), JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify({ ok: true, toolCount: report.toolCount, project: report.project, analysis: report.analysis, render: report.render, rejected }))
} finally {
  await client.close().catch(() => undefined)
  await rm(scratch, { recursive: true, force: true })
}
