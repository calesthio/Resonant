import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, Bot, CircleHelp, Disc3, Download, FolderOpen, Gauge, Keyboard, Library, Menu, Pause, PenLine, Play, Plus, Radio, Redo2, Save, SkipBack, Sparkles, Undo2, X } from 'lucide-react'
import { liveEngine } from './audio/LiveEngine'
import { floatsToBase64, summarizeWaveform } from './domain/pcm'
import { createBlankProject, createDemoProject, makeId, parseProject, serializeProject, touch } from './domain/project'
import { encodeWav, renderProject } from './domain/render'
import { renderProjectWithInstruments } from './domain/instrumentRender'
import type { InstrumentLibraryState } from './domain/instruments'
import { EMPTY_ACE_STEP_STATE, type AceStepGeneration, type AceStepState } from './domain/aceStep'
import { EMPTY_SEED_VC_STATE, type SeedVcConversion, type SeedVcState } from './domain/seedVc'
import { formatBeat, formatElapsed } from './domain/time'
import { isEditingText } from './domain/arrangementEditing'
import type { AudioClip, EngineState, Project, Track, Workspace } from './domain/types'
import { useAppStore } from './store/AppStore'
import { ArrangementView } from './components/ArrangementView'
import { FlowView } from './components/FlowView'
import { Inspector } from './components/Inspector'
import { MixerView } from './components/MixerView'
import { TrackRail } from './components/TrackRail'
import { InstrumentLibraryModal } from './components/InstrumentLibraryModal'
import { AceStepStudioModal } from './components/AceStepStudioModal'
import { SeedVcStudioModal } from './components/SeedVcStudioModal'
import { SongwriterStudioModal } from './components/SongwriterStudioModal'
import { McpSetupModal } from './components/McpSetupModal'
import { emptySongwritingDraft } from './songwriting/core'
import { listSongwritingLanguages } from './songwriting/registry'
import type { SongwritingDraft } from './songwriting/types'

type Toast = { id: number; tone: 'info' | 'error' | 'success'; message: string }
const MAX_EMBEDDED_PCM_BYTES = 100_000_000
const EMPTY_LIBRARY: InstrumentLibraryState = { root: 'Desktop app required', packs: [], instruments: [], bytes: 0 }

function pickBrowserAudio(): Promise<{ canceled: boolean; name?: string; data?: ArrayBuffer }> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) { resolve({ canceled: true }); return }
      if (file.size > 100_000_000) { resolve({ canceled: false, name: file.name, data: undefined }); return }
      resolve({ canceled: false, name: file.name.replace(/\.[^.]+$/, ''), data: await file.arrayBuffer() })
    }, { once: true })
    input.addEventListener('cancel', () => resolve({ canceled: true }), { once: true })
    input.click()
  })
}

export default function App() {
  const store = useAppStore()
  const [engine, setEngine] = useState<EngineState>({ playing: false, recording: false, beat: 0, mode: 'session', activeClips: {} })
  const [metronome, setMetronome] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [welcome, setWelcome] = useState(true)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [library, setLibrary] = useState<InstrumentLibraryState>(EMPTY_LIBRARY)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [aceStep, setAceStep] = useState<AceStepState>(EMPTY_ACE_STEP_STATE)
  const [aceStudioOpen, setAceStudioOpen] = useState(false)
  const [seedVc, setSeedVc] = useState<SeedVcState>(EMPTY_SEED_VC_STATE)
  const [seedVcStudioOpen, setSeedVcStudioOpen] = useState(false)
  const [songwriterOpen, setSongwriterOpen] = useState(false)
  const [mcpSetupOpen, setMcpSetupOpen] = useState(false)
  const recorder = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; track: Track } | null>(null)
  const toastId = useRef(0)

  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current
    setToasts((items) => [...items.slice(-2), { id, tone, message }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3800)
  }, [])

  const activeClips = engine.activeClips
  const selectedTrack = store.project.tracks.find((track) => track.id === store.selectedTrackId) ?? store.project.tracks[0]
  const selectedClip = store.selectedClipId ? store.project.clips[store.selectedClipId] : undefined

  const initializeActive = useCallback((project: Project) => {
    const active: Record<string, string | null> = {}
    project.tracks.forEach((track) => { active[track.id] = track.sessionSlots[0] })
    setEngine((state) => ({ ...state, activeClips: active, beat: 0, playing: false }))
  }, [])

  useEffect(() => { initializeActive(store.project) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.resonantDesktop?.readRecovery().then(setRecovery).catch(() => undefined) }, [])
  const refreshLibrary = useCallback(async () => { if (window.resonantDesktop) setLibrary(await window.resonantDesktop.getInstrumentLibrary()) }, [])
  useEffect(() => { void refreshLibrary().catch(() => notify('Instrument library could not be indexed.', 'error')) }, [notify, refreshLibrary])
  const refreshAceStep = useCallback(async () => { if (window.resonantDesktop) setAceStep(await window.resonantDesktop.getAceStepState()) }, [])
  useEffect(() => { void refreshAceStep().catch(() => notify('ACE-Step status could not be read.', 'error')) }, [notify, refreshAceStep])
  const refreshSeedVc = useCallback(async () => { if (window.resonantDesktop) setSeedVc(await window.resonantDesktop.getSeedVcState()) }, [])
  useEffect(() => { void refreshSeedVc().catch(() => notify('Seed-VC status could not be read.', 'error')) }, [notify, refreshSeedVc])
  useEffect(() => {
    if (!store.dirty) return
    const timeout = window.setTimeout(() => window.resonantDesktop?.autosave(serializeProject(store.project)).catch(() => notify('Autosave could not be written.', 'error')), 1800)
    return () => window.clearTimeout(timeout)
  }, [store.project, store.dirty, notify])
  useEffect(() => { if (engine.playing) { liveEngine.updateProject(store.project); liveEngine.setActiveClips(engine.activeClips) } }, [store.project, engine.activeClips, engine.playing])
  useEffect(() => {
    if (!engine.playing) return
    let frame = 0
    const update = () => { setEngine((state) => state.playing ? { ...state, beat: liveEngine.getCurrentBeat() } : state); frame = requestAnimationFrame(update) }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [engine.playing])

  const stop = useCallback(() => {
    liveEngine.stop()
    setEngine((state) => ({ ...state, playing: false, beat: 0 }))
  }, [])

  const seek = useCallback((beat: number) => {
    if (engine.recording) { notify('Stop recording before moving the playhead.', 'info'); return }
    liveEngine.stop()
    setEngine((state) => ({ ...state, playing: false, mode: 'arrangement', beat: Math.max(0, Math.min(16384, beat)) }))
  }, [engine.recording, notify])

  const togglePlay = useCallback(async () => {
    if (engine.playing) { liveEngine.stop(); setEngine((state) => ({ ...state, playing: false })); return }
    try {
      await liveEngine.play(store.project, { mode: engine.mode, activeClips: engine.activeClips, startBeat: engine.beat, metronome })
      setEngine((state) => ({ ...state, playing: true }))
    } catch (error) { notify(error instanceof Error ? error.message : 'Audio output could not start.', 'error') }
  }, [engine, metronome, notify, store.project])

  const loadProject = useCallback((project: Project, path: string | null = null) => {
    stop(); store.load(project); initializeActive(project); setFilePath(path); setWelcome(false)
  }, [initializeActive, stop, store])

  useEffect(() => window.resonantDesktop?.onExternalProjectChange(({ path, content }) => {
    if (filePath && path !== filePath) return
    if (store.dirty && !window.confirm('This project changed outside Resonant. Reload it and discard unsaved in-app edits?')) {
      notify('External agent changes are waiting. Reopen the project when ready.', 'info')
      return
    }
    try { loadProject(parseProject(content), path); notify('External agent changes loaded.', 'success') }
    catch (error) { notify(error instanceof Error ? error.message : 'The externally changed project is invalid.', 'error') }
  }), [filePath, loadProject, notify, store.dirty])

  const newProject = useCallback(async (demo = false) => {
    if (engine.recording) { notify('Stop recording before starting another project.', 'error'); return }
    if (store.dirty && !window.confirm('Discard unsaved changes and start another project?')) return
    try {
      await window.resonantDesktop?.resetProjectPath()
      loadProject(demo ? createDemoProject() : createBlankProject()); notify(demo ? 'Starter groove loaded.' : 'Blank project ready.', 'success')
    } catch (error) { notify(error instanceof Error ? error.message : 'A new project could not be created.', 'error') }
  }, [engine.recording, loadProject, notify, store.dirty])
  const save = useCallback(async (saveAs = false) => {
    try {
      if (!window.resonantDesktop) { localStorage.setItem('resonant-project', serializeProject(store.project)); store.markSaved(); notify('Saved in this browser session.', 'success'); return }
      const result = await window.resonantDesktop.saveProject(serializeProject(store.project), saveAs)
      if (!result.canceled) { store.markSaved(); setFilePath(result.path ?? null); await window.resonantDesktop.clearRecovery(); setRecovery(null); notify('Project saved.', 'success') }
    } catch (error) { notify(error instanceof Error ? error.message : 'Save failed.', 'error') }
  }, [notify, store])
  const open = useCallback(async () => {
    try {
      if (engine.recording) { notify('Stop recording before opening another project.', 'error'); return }
      if (store.dirty && !window.confirm('Discard unsaved changes and open another project?')) return
      if (!window.resonantDesktop) { const text = localStorage.getItem('resonant-project'); if (text) loadProject(parseProject(text)); else notify('No browser project has been saved.', 'error'); return }
      const result = await window.resonantDesktop.openProject()
      if (!result.canceled && result.content) { loadProject(parseProject(result.content), result.path ?? null); notify('Project opened.', 'success') }
    } catch (error) { notify(error instanceof Error ? error.message : 'Open failed.', 'error') }
  }, [engine.recording, loadProject, notify, store.dirty])

  const captureSession = useCallback(() => {
    const start = store.project.arrangement.reduce((end, block) => Math.max(end, block.startBeat + block.lengthBeats), 0)
    const blocks = store.project.tracks.flatMap((track) => {
      const clipId = activeClips[track.id]
      return clipId ? [{ id: makeId('block'), trackId: track.id, clipId, startBeat: start, lengthBeats: 16, offsetBeats: 0 }] : []
    })
    if (!blocks.length) { notify('Launch at least one clip before capturing.', 'error'); return }
    store.commit(touch({ ...store.project, arrangement: [...store.project.arrangement, ...blocks] }), 'Capture session')
    liveEngine.stop()
    store.setWorkspace('arrange'); setEngine((state) => ({ ...state, playing: false, mode: 'arrangement', beat: start })); notify('Session captured as 4 bars.', 'success')
  }, [activeClips, notify, store])

  const exportWav = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      let project = store.project
      if (!project.arrangement.length) {
        const blocks = project.tracks.flatMap((track) => activeClips[track.id] ? [{ id: makeId('export'), trackId: track.id, clipId: activeClips[track.id]!, startBeat: 0, lengthBeats: 16, offsetBeats: 0 }] : [])
        if (!blocks.length) throw new Error('There is no launched or arranged material to export.')
        project = { ...project, arrangement: blocks }
      }
      if (window.resonantDesktop && Object.values(project.clips).some((clip) => clip.type === 'audio' && clip.asset)) project = await liveEngine.hydrateAudioAssets(project)
      const started = performance.now()
      const rendered = project.tracks.some((track) => track.instrument)
        ? await renderProjectWithInstruments(project, (id) => liveEngine.getPreparedInstrument(id), await liveEngine.prepare())
        : renderProject(project)
      const wav = encodeWav(rendered)
      if (window.resonantDesktop) {
        const result = await window.resonantDesktop.exportAudio(wav, project.title)
        if (!result.canceled) notify(`WAV exported in ${((performance.now() - started) / 1000).toFixed(1)} s.`, 'success')
      } else {
        const url = URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${project.title}.wav`; anchor.click(); URL.revokeObjectURL(url)
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'Export failed.', 'error') }
    finally { setExporting(false) }
  }, [activeClips, exporting, notify, store.project])

  const placeAudioClip = useCallback(async (track: Track, name: string, audioData: ArrayBuffer) => {
    const context = await liveEngine.prepare(), decoded = await context.decodeAudioData(audioData.slice(0))
    const channels = Array.from({ length: Math.min(2, decoded.numberOfChannels) }, (_, index) => decoded.getChannelData(index).slice())
    const pcmBytes = decoded.length * channels.length * 4
    const encodedLength = Math.ceil(pcmBytes / 3) * 4
    const existingAudioLength = Object.values(store.project.clips).reduce((total, clip) => total + (clip.type === 'audio' ? clip.pcmBase64?.length ?? 0 : 0), 0)
    if (!channels.length || !decoded.length) throw new Error('The selected audio file is empty.')
    if (!window.resonantDesktop && (pcmBytes > MAX_EMBEDDED_PCM_BYTES || existingAudioLength + encodedLength > 240_000_000)) throw new Error('The decoded audio is too large to embed safely. Import a shorter file.')
    const asset = window.resonantDesktop ? await window.resonantDesktop.storeAudioAsset({ channels: channels.map((channel) => channel.buffer.slice(channel.byteOffset, channel.byteOffset + channel.byteLength)), sampleRate: decoded.sampleRate }) : undefined
    const clip: AudioClip = {
      id: makeId('clip'), type: 'audio', name, color: track.color, lengthBeats: Math.max(0.25, decoded.duration * store.project.bpm / 60),
      sampleRate: decoded.sampleRate, channels: channels.length as 1 | 2, frames: decoded.length, ...(asset ? { asset } : { pcmBase64: floatsToBase64(channels) }), trimStart: 0, trimEnd: 0, gain: 1, volumeAutomation: Array(16).fill(1),
      waveformPeaks: summarizeWaveform(channels),
    }
    const slot = track.sessionSlots.findIndex((item) => !item)
    const slots = [...track.sessionSlots]; slots[slot < 0 ? 0 : slot] = clip.id
    const tracks = store.project.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, sessionSlots: slots } : candidate)
    store.commit(touch({ ...store.project, tracks, clips: { ...store.project.clips, [clip.id]: clip } }), 'Add audio clip')
    store.selectTrack(track.id, clip.id); setEngine((state) => ({ ...state, activeClips: { ...state.activeClips, [track.id]: clip.id } })); notify(`${name} is ready in Flow.`, 'success')
  }, [notify, store])

  const importAudio = useCallback(async () => {
    const track = selectedTrack?.kind === 'audio' ? selectedTrack : store.project.tracks.find((candidate) => candidate.kind === 'audio')
    if (!track) { notify('Add an audio track before importing.', 'error'); return }
    try {
      const result = window.resonantDesktop ? await window.resonantDesktop.importAudio() : await pickBrowserAudio()
      if (!result.canceled && !result.data) throw new Error('Audio import is limited to 100 MB in this release.')
      if (!result.canceled && result.data) await placeAudioClip(track, result.name ?? 'Imported audio', result.data)
    } catch (error) { notify(error instanceof Error ? error.message : 'Audio import failed.', 'error') }
  }, [notify, placeAudioClip, selectedTrack, store.project.tracks])

  const placeAceStepGeneration = useCallback(async (generation: AceStepGeneration) => {
    const track = store.project.tracks.find((candidate) => candidate.kind === 'audio')
    if (!track) throw new Error('Add an audio track before generating with ACE-Step.')
    await placeAudioClip(track, generation.name, generation.data)
  }, [placeAudioClip, store.project.tracks])

  const placeSeedVcConversion = useCallback(async (conversion: SeedVcConversion) => {
    const track = store.project.tracks.find((candidate) => candidate.kind === 'audio')
    if (!track) throw new Error('Add an audio track before converting with Seed-VC.')
    await placeAudioClip(track, conversion.name, conversion.data)
  }, [placeAudioClip, store.project.tracks])

  const saveSongwritingDraft = useCallback((draft: SongwritingDraft) => {
    store.commit(touch({ ...store.project, title: draft.title.trim() || store.project.title, songwriting: structuredClone(draft) }), 'Update songwriting draft')
  }, [store])

  const sendDraftToAceStep = useCallback(() => {
    setSongwriterOpen(false)
    setAceStudioOpen(true)
  }, [])

  const toggleRecord = useCallback(async () => {
    if (recorder.current) { recorder.current.recorder.stop(); setEngine((state) => ({ ...state, recording: false })); return }
    const armed = store.project.tracks.find((track) => track.kind === 'audio' && track.armed)
    if (!armed) { notify('Arm the Audio track in the inspector before recording.', 'error'); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      const chunks: Blob[] = [], mediaRecorder = new MediaRecorder(stream)
      recorder.current = { recorder: mediaRecorder, stream, chunks, track: armed }
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      mediaRecorder.onstop = async () => {
        const captured = recorder.current; recorder.current = null
        if (!captured) return
        captured.stream.getTracks().forEach((mediaTrack) => mediaTrack.stop())
        try { await placeAudioClip(captured.track, `Recording ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, await new Blob(captured.chunks, { type: mediaRecorder.mimeType }).arrayBuffer()) }
        catch (error) { notify(error instanceof Error ? error.message : 'The recording could not be decoded.', 'error') }
      }
      mediaRecorder.start(250); setEngine((state) => ({ ...state, recording: true })); notify('Recording from the default input…')
    } catch { notify('Microphone access is unavailable. Check Windows privacy and input settings.', 'error') }
  }, [notify, placeAudioClip, store.project.tracks])

  const switchWorkspace = useCallback((workspace: Workspace) => {
    store.setWorkspace(workspace)
    const mode = workspace === 'arrange' ? 'arrangement' : engine.mode
    if (engine.playing && mode !== engine.mode) { stop(); setEngine((state) => ({ ...state, mode, beat: 0 })) } else setEngine((state) => ({ ...state, mode }))
  }, [engine.mode, engine.playing, stop, store])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditingText(event.target) || document.querySelector('[role="dialog"]')) return
      if (event.code === 'Space') { event.preventDefault(); void togglePlay() }
      if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void save(event.shiftKey) }
      if (event.ctrlKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void open() }
      if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); store.undo() }
      if ((event.ctrlKey && event.key.toLowerCase() === 'y') || (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'z')) { event.preventDefault(); store.redo() }
      if (event.key === '1') switchWorkspace('flow'); if (event.key === '2') switchWorkspace('arrange'); if (event.key === '3') switchWorkspace('mix')
      if (event.key.toLowerCase() === 'r' && !event.ctrlKey) void toggleRecord()
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown)
  }, [open, save, store, switchWorkspace, togglePlay, toggleRecord])

  const latency = liveEngine.getLatency()
  const workspaceContent = useMemo(() => {
    if (store.workspace === 'flow') return <FlowView engine={engine} setEngine={setEngine} notify={notify} importAudio={importAudio} captureSession={captureSession} />
    if (store.workspace === 'arrange') return <ArrangementView beat={engine.beat} onSeek={seek} notify={notify} captureSession={captureSession} />
    return <MixerView />
  }, [captureSession, engine, importAudio, notify, seek, store.workspace])

  return <div className={`app ${engine.recording ? 'is-recording' : ''}`}>
    <header className="topbar">
      <div className="brand" aria-label="Resonant home"><span className="brand-mark"><Radio size={17} /></span><span>RESONANT</span><small>WORKSTATION</small></div>
      <div className="file-actions">
        <button className="icon-button" title="New project" aria-label="New project" onClick={() => void newProject(false)}><Menu size={16} /></button>
        <button className="icon-button" title="Open · Ctrl+O" aria-label="Open project" onClick={() => void open()}><FolderOpen size={16} /></button>
        <button className="icon-button" title="Save · Ctrl+S" aria-label="Save project" onClick={() => void save()}><Save size={16} /></button>
        <span className="divider" />
        <button className="icon-button" disabled={!store.past.length} title={`Undo${store.past.at(-1)?.label ? ` ${store.past.at(-1)?.label}` : ''} · Ctrl+Z`} aria-label="Undo" onClick={store.undo}><Undo2 size={16} /></button>
        <button className="icon-button" disabled={!store.future.length} title="Redo · Ctrl+Y" aria-label="Redo" onClick={store.redo}><Redo2 size={16} /></button>
      </div>
      <div className="transport" role="group" aria-label="Transport">
        <button className="icon-button" title="Return to start" aria-label="Return to start" onClick={stop}><SkipBack size={17} /></button>
        <button className={`transport-play ${engine.playing ? 'active' : ''}`} title="Play/Pause · Space" aria-label={engine.playing ? 'Pause' : 'Play'} onClick={() => void togglePlay()}>{engine.playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
        <button className={`record-button ${engine.recording ? 'active' : ''}`} title="Record · R" aria-label={engine.recording ? 'Stop recording' : 'Record'} onClick={() => void toggleRecord()}><span /></button>
        <div className="transport-position"><div className="position" aria-label={`Position ${formatBeat(engine.beat)}`}>{formatBeat(engine.beat)}</div><div className="elapsed-time" aria-label={`Elapsed time ${formatElapsed(engine.beat, store.project.bpm)}`}>{formatElapsed(engine.beat, store.project.bpm)}</div></div>
        <label className="tempo"><span>TEMPO</span><input aria-label="Tempo" type="number" min="30" max="300" value={store.project.bpm} onChange={(event) => store.commit(touch({ ...store.project, bpm: Math.max(30, Math.min(300, Number(event.target.value))) }), 'Change tempo')} /></label>
        <button className={`text-button ${metronome ? 'active' : ''}`} aria-pressed={metronome} onClick={() => setMetronome((value) => !value)}>CLICK</button>
        <button className={`text-button ${store.project.loop.enabled ? 'active' : ''}`} aria-pressed={store.project.loop.enabled} onClick={() => store.commit(touch({ ...store.project, loop: { ...store.project.loop, enabled: !store.project.loop.enabled } }), 'Toggle loop')}>LOOP</button>
      </div>
      <div className="top-status"><span className="save-state">{store.dirty ? 'UNSAVED' : filePath ? 'SAVED' : 'READY'}</span><span title="Measured Web Audio output latency"><Gauge size={14} /> {latency === null ? 'audio idle' : `${latency} ms`}</span><button className="icon-button songwriter-status" title="Songwriter Studio" aria-label="Open Songwriter Studio" onClick={() => setSongwriterOpen(true)}><PenLine size={16} /></button><div className="ai-tool-cluster" role="group" aria-label="Local AI tools"><button className={`ai-tool-button ai-music-tool ${aceStep.running ? 'running' : aceStep.installed ? 'ready' : 'install'}`} title="Open ACE-Step Studio" aria-label={`AI Song generator · ${aceStep.running ? 'running' : aceStep.installed ? 'installed and ready' : 'installation available'}`} onClick={() => setAceStudioOpen(true)}><Sparkles size={16} /><span><strong>AI SONG</strong><small>{aceStep.running ? 'RUNNING' : aceStep.installed ? 'READY' : 'INSTALL'}</small></span></button><button className={`ai-tool-button voice-tool ${seedVc.installed ? 'ready' : 'install'}`} title="Open Seed-VC Studio" aria-label={`My Voice converter · ${seedVc.installed ? 'installed and ready' : 'installation available'}`} onClick={() => setSeedVcStudioOpen(true)}><AudioLines size={16} /><span><strong>MY VOICE</strong><small>{seedVc.installed ? 'READY' : 'INSTALL'}</small></span></button></div><button className="icon-button" title="Instrument library" aria-label="Open instrument library" onClick={() => setLibraryOpen(true)}><Library size={16} /></button><button className="icon-button" title="Quick start" aria-label="Open quick start" onClick={() => setWelcome(true)}><CircleHelp size={16} /></button></div>
    </header>

    <nav className="workspace-tabs" aria-label="Workspaces">
      {([['flow', 'FLOW', 'Clips + patterns'], ['arrange', 'ARRANGE', 'Linear song'], ['mix', 'MIX', 'Sound + motion']] as const).map(([id, label, hint], index) => <button key={id} className={store.workspace === id ? 'active' : ''} onClick={() => switchWorkspace(id)}><span>{index + 1}</span>{label}<small>{hint}</small></button>)}
      <div className="mode-switch"><button className={engine.mode === 'session' ? 'active' : ''} onClick={() => { if (engine.playing) stop(); setEngine((state) => ({ ...state, mode: 'session', beat: 0 })) }}>SESSION</button><button className={engine.mode === 'arrangement' ? 'active' : ''} onClick={() => { if (engine.playing) stop(); setEngine((state) => ({ ...state, mode: 'arrangement', beat: 0 })) }}>SONG</button></div>
      <button className="export-button" disabled={exporting} onClick={() => void exportWav()}><Download size={15} /> {exporting ? 'RENDERING…' : 'EXPORT WAV'}</button>
    </nav>

    <main className="workbench">
      <TrackRail activeClips={activeClips} />
      <section className="workspace" aria-label={`${store.workspace} workspace`}>{workspaceContent}</section>
      <Inspector selectedTrack={selectedTrack} selectedClip={selectedClip} importAudio={importAudio} library={library} openLibrary={() => setLibraryOpen(true)} />
    </main>
    <footer className="statusbar"><span><span className={`status-dot ${engine.playing ? 'live' : ''}`} /> {engine.playing ? `${engine.mode === 'session' ? 'Session' : 'Song'} playing` : 'Transport stopped'}</span><span>{Object.values(activeClips).filter(Boolean).length} clips active · {store.project.arrangement.length} arrangement blocks</span><span><Keyboard size={13} /> Space play · R record · 1–3 workspaces</span></footer>

    {recovery && <div className="recovery-banner"><div><strong>Recovery available</strong><span>An autosaved session was found from an earlier run.</span></div><button onClick={() => { try { loadProject(parseProject(recovery)); setRecovery(null); notify('Autosave recovered.', 'success') } catch (error) { notify(error instanceof Error ? error.message : 'Recovery is damaged.', 'error') } }}>RESTORE</button><button onClick={() => { void window.resonantDesktop?.clearRecovery(); setRecovery(null) }}>DISMISS</button></div>}
    {welcome && <div className="modal-backdrop" role="presentation"><section className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <button className="modal-close" onClick={() => setWelcome(false)} aria-label="Close quick start"><X size={18} /></button><div className="welcome-icon"><Disc3 size={25} /></div><p className="eyebrow">ORIGINAL MUSIC, ONE CONTINUOUS FLOW</p><h1 id="welcome-title">Make an idea move.</h1><p>Program a clip, launch combinations, capture the moment into a song, then shape the mix and export it—without rebuilding your material.</p>
      <div className="welcome-actions"><button className="primary-card" onClick={() => void newProject(true)}><Sparkles size={20} /><span><strong>Open starter groove</strong><small>Hear and reshape a four-track sketch</small></span></button><button className="secondary-card" onClick={() => void newProject(false)}><span className="plus"><Plus size={15} /></span><span><strong>Begin empty</strong><small>Five tracks and a clean session</small></span></button></div>
      {window.resonantDesktop && <button className="welcome-library" onClick={() => { setWelcome(false); setLibraryOpen(true) }}><Library size={16} /><span><strong>Install real instruments</strong><small>Violin, guitar, flute, tabla, pianos, drums and thousands more</small></span></button>}
      {window.resonantDesktop && <button className="welcome-library welcome-ai" onClick={() => { setWelcome(false); setAceStudioOpen(true) }}><Sparkles size={16} /><span><strong>{aceStep.installed ? 'Open ACE-Step Studio' : 'Optional: install local AI music'}</strong><small>Generate original songs and samples locally, then arrange and mix them here</small></span></button>}
      {window.resonantDesktop && <button className="welcome-library welcome-ai" onClick={() => { setWelcome(false); setSeedVcStudioOpen(true) }}><AudioLines size={16} /><span><strong>{seedVc.installed ? 'Open Seed-VC Studio' : 'Optional: install personal singing voices'}</strong><small>Convert an isolated vocal into a consented reference voice locally</small></span></button>}
      <button className="welcome-library welcome-songwriter" onClick={() => { setWelcome(false); setSongwriterOpen(true) }}><PenLine size={16} /><span><strong>Develop lyrics in Songwriter Studio</strong><small>Build hooks, story, structure and singable English before generation</small></span></button>
      {window.resonantDesktop && <button className="welcome-library welcome-mcp" onClick={() => { setWelcome(false); setMcpSetupOpen(true) }}><Bot size={16} /><span><strong>Connect Codex, Claude, or another AI assistant</strong><small>Copy a ready-to-use local MCP configuration—no separate Node.js install</small></span></button>}
      <div className="quick-steps"><span><b>1</b> Choose a clip</span><span><b>2</b> Draw notes</span><span><b>3</b> Press Space</span><span><b>4</b> Capture to Arrange</span></div>
    </section></div>}
    {libraryOpen && window.resonantDesktop && <InstrumentLibraryModal library={library} close={() => setLibraryOpen(false)} refresh={refreshLibrary} notify={notify} />}
    {songwriterOpen && <SongwriterStudioModal draft={store.project.songwriting ?? emptySongwritingDraft()} languages={listSongwritingLanguages()} close={() => setSongwriterOpen(false)} save={saveSongwritingDraft} sendToGenerator={sendDraftToAceStep} notify={notify} />}
    {aceStudioOpen && window.resonantDesktop && <AceStepStudioModal state={aceStep} close={() => setAceStudioOpen(false)} refresh={refreshAceStep} onGenerated={placeAceStepGeneration} notify={notify} draft={store.project.songwriting} />}
    {seedVcStudioOpen && window.resonantDesktop && <SeedVcStudioModal state={seedVc} close={() => setSeedVcStudioOpen(false)} refresh={refreshSeedVc} onConverted={placeSeedVcConversion} notify={notify} selectedAudio={selectedClip?.type === 'audio' && selectedClip.asset ? { name: selectedClip.name, assetId: selectedClip.asset.id } : undefined} />}
    {mcpSetupOpen && window.resonantDesktop && <McpSetupModal close={() => setMcpSetupOpen(false)} notify={notify} />}
    <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.tone}`}>{toast.message}</div>)}</div>
  </div>
}
