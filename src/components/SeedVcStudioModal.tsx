import { AudioLines, Cpu, Download, FileAudio, HardDrive, ShieldCheck, Trash2, WandSparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatBytes } from '../domain/instruments'
import type { SeedVcConversion, SeedVcProgress, SeedVcState } from '../domain/seedVc'

interface Props {
  state: SeedVcState
  close(): void
  refresh(): Promise<void>
  onConverted(conversion: SeedVcConversion): Promise<void>
  notify(message: string, tone?: 'info' | 'error' | 'success'): void
  selectedAudio?: { name: string; assetId: string }
}

export function SeedVcStudioModal({ state, close, refresh, onConverted, notify, selectedAudio }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<SeedVcProgress | null>(null)
  const [source, setSource] = useState<{ path: string; name: string } | null>(null)
  const [reference, setReference] = useState<{ path: string; name: string } | null>(null)
  const [consent, setConsent] = useState(false)
  const [steps, setSteps] = useState(30)
  const [shift, setShift] = useState(0)
  const [lengthAdjust, setLengthAdjust] = useState(1)
  const [operationError, setOperationError] = useState<string | null>(null)

  useEffect(() => window.resonantDesktop?.onSeedVcProgress(setProgress), [])

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label); setProgress(null); setOperationError(null)
    try { await action(); await refresh(); notify(`${label} completed.`, 'success') }
    catch (error) { const message = error instanceof Error ? error.message : `${label} failed.`; setProgress(null); setOperationError(message); await refresh().catch(() => undefined); notify(message, 'error') }
    finally { setBusy(null) }
  }

  const choose = async (role: 'source' | 'reference') => {
    const selected = await window.resonantDesktop!.chooseSeedVcAudio(role)
    if (selected.canceled || !selected.path) return
    const value = { path: selected.path, name: selected.name || selected.path }
    if (role === 'source') setSource(value); else setReference(value)
  }

  const convert = async () => {
    if (!source || !reference) { notify('Choose both the isolated source vocal and a reference voice recording.', 'error'); return }
    if (!consent) { notify('Confirm your rights to the reference voice before converting.', 'error'); return }
    setBusy('Seed-VC conversion'); setProgress(null)
    try {
      const conversion = await window.resonantDesktop!.convertWithSeedVc({ sourcePath: source.path, referencePath: reference.path, voiceRightsConfirmed: true, diffusionSteps: steps, semitoneShift: shift, inferenceCfgRate: 0.7, lengthAdjust })
      await onConverted(conversion); await refresh(); notify(`${conversion.name} was added to the Audio track.`, 'success')
    } catch (error) { notify(error instanceof Error ? error.message : 'Seed-VC conversion failed.', 'error') }
    finally { setBusy(null) }
  }

  const percent = progress?.total ? Math.round(progress.received / progress.total * 100) : null
  const hardwareLabel = state.hardware.vramMb ? `${(state.hardware.vramMb / 1024).toFixed(0)} GB VRAM` : state.hardware.backend.toUpperCase()

  return <div className="modal-backdrop ace-backdrop" role="dialog" aria-modal="true" aria-labelledby="seed-vc-title">
    <section className="ace-studio-modal seed-vc-modal">
      <header>
        <div><span className="eyebrow">LOCAL SINGING VOICE CONVERSION</span><h2 id="seed-vc-title"><AudioLines size={22} /> Seed-VC Studio</h2><p>Transfer a generated vocal performance into a voice you own or have permission to use.</p></div>
        <button className="modal-close" aria-label="Close Seed-VC Studio" onClick={close}><X size={19} /></button>
      </header>
      <div className="ace-status-strip">
        <span className={state.installed ? 'ready' : ''}><Download size={14} /><strong>{state.installed ? 'INSTALLED' : 'OPTIONAL'}</strong></span>
        <span className={state.hardware.adequate ? 'ready' : ''}><Cpu size={14} /><strong>{hardwareLabel}</strong></span>
        <span><HardDrive size={14} /><strong>{formatBytes(state.bytes)}</strong></span>
        <code title={state.root}>{state.root}</code>
      </div>

      {!state.installed ? <div className="ace-install-panel">
        <div className="ace-orbit"><AudioLines size={26} /></div>
        <div><span className="eyebrow">OPTIONAL LOCAL PROVIDER</span><h3>Sing generated songs in your own voice.</h3><p>Installs a pinned Seed-VC runtime under Resonant’s application data. The singing model downloads on first use and stays local afterward.</p>
          <div className="ace-requirements"><span>6 GB VRAM minimum</span><span>8 GB recommended</span><span>1–30 sec reference</span><span>GPL-3.0 provider</span></div>
          {!state.hardware.adequate && <p className="seed-vc-warning">No supported 6 GB NVIDIA GPU was detected. Installation is allowed, but conversion may be slow or fail.</p>}
          {operationError && <p className="seed-vc-install-error" role="alert">{operationError}</p>}
        </div>
        <button disabled={!!busy} className="ace-primary" onClick={() => void run('Seed-VC installation', () => window.resonantDesktop!.installSeedVc())}><Download size={17} /> {busy ? 'INSTALLING…' : 'INSTALL SEED-VC'}</button>
      </div> : <div className="seed-vc-workspace">
        <div className="seed-vc-file-grid">
          <div className="seed-vc-source-choice"><button type="button" onClick={() => void choose('source')} disabled={!!busy}><FileAudio size={22} /><span><strong>Source vocal</strong><small>{source?.name || 'Choose an isolated sung performance'}</small></span></button>{selectedAudio && <button type="button" className="seed-vc-selected" onClick={() => setSource({ path: `asset:${selectedAudio.assetId}`, name: selectedAudio.name })}>USE SELECTED CLIP: {selectedAudio.name}</button>}</div>
          <button type="button" onClick={() => void choose('reference')} disabled={!!busy}><AudioLines size={22} /><span><strong>Reference voice</strong><small>{reference?.name || 'Choose a clean 1–30 second recording'}</small></span></button>
        </div>
        <div className="seed-vc-controls">
          <label>QUALITY<select value={steps} onChange={(event) => setSteps(Number(event.target.value))}><option value={20}>Fast · 20 steps</option><option value={30}>Balanced · 30 steps</option><option value={50}>High · 50 steps</option></select></label>
          <label>PITCH SHIFT<input type="number" min={-24} max={24} value={shift} onChange={(event) => setShift(Number(event.target.value))} /><small>Semitones; normally leave at 0</small></label>
          <label>LENGTH<select value={lengthAdjust} onChange={(event) => setLengthAdjust(Number(event.target.value))}><option value={0.75}>Faster · 0.75×</option><option value={1}>Original · 1×</option><option value={1.25}>Slower · 1.25×</option></select><small>Changes the converted performance duration</small></label>
        </div>
        <label className="ace-check seed-vc-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><ShieldCheck size={19} /><span><strong>I own this voice or have explicit permission to use it</strong><small>Resonant records this confirmation with the conversion provenance. Do not impersonate people without consent.</small></span></label>
        <button className="ace-generate" disabled={!!busy || !source || !reference || !consent} onClick={() => void convert()}><WandSparkles size={18} /> {busy ? 'CONVERTING LOCALLY…' : 'CONVERT & ADD TO AUDIO TRACK'}</button>
        <p className="seed-vc-note">Starting a conversion stops ACE-Step first to release GPU memory. Use an isolated vocal stem; a full mix will transfer instruments and artifacts too.</p>
      </div>}

      {progress && <div className="ace-progress"><span>{progress.label}</span><progress max={progress.total || 1} value={progress.received} /><output>{percent === null ? progress.phase.toUpperCase() : `${percent}%`}</output></div>}
      <footer><span>{state.installed ? `${state.outputs.length} conversion workspace${state.outputs.length === 1 ? '' : 's'} · ${state.profile.model}` : 'Nothing is downloaded until you choose Install'}</span><div>{state.installed && <button className="danger" disabled={!!busy} onClick={() => { if (window.confirm('Remove Seed-VC, its model cache, and converted previews? Resonant project clips remain intact.')) void run('Seed-VC removal', () => window.resonantDesktop!.removeSeedVc()) }}><Trash2 size={13} /> REMOVE</button>}<button onClick={close}>DONE</button></div></footer>
    </section>
  </div>
}
