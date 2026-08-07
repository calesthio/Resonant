import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const SEED_VC_REVISION = '51383efd921027683c89e5348211d93ff12ac2a8'

export function seedVcRoot() {
  return process.env.RESONANT_SEED_VC_ROOT || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'resonant-workstation', 'voice-providers', 'seed-vc')
}

function locations() {
  const root = seedVcRoot(), runtime = path.join(root, 'runtime')
  return { root, runtime, python: path.join(runtime, '.venv', 'Scripts', process.platform === 'win32' ? 'python.exe' : 'python'), outputs: path.join(root, 'outputs'), manifest: path.join(root, 'manifest.json') }
}

async function exists(target: string) { try { await access(target); return true } catch { return false } }
async function installed(location: ReturnType<typeof locations>) {
  try {
    const manifest = JSON.parse(await readFile(location.manifest, 'utf8')) as { revision?: string }
    return manifest.revision === SEED_VC_REVISION && await exists(location.python) && await exists(path.join(location.runtime, 'inference.py'))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
}

async function bytes(directory: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      total += entry.isDirectory() ? await bytes(target) : entry.isFile() ? (await stat(target)).size : 0
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return total
}

export async function seedVcState() {
  const location = locations()
  return { root: location.root, revision: SEED_VC_REVISION, installed: await installed(location), bytes: await bytes(location.root), profile: { model: 'seed-uvit-whisper-base', sampleRate: 44100, fp16: true, minimumVramGb: 6, recommendedVramGb: 8 } }
}

export interface SingingVoiceRequest {
  sourcePath: string
  referencePath: string
  voiceRightsConfirmed: boolean
  diffusionSteps?: number
  semitoneShift?: number
  inferenceCfgRate?: number
  lengthAdjust?: number
}

export function singingVoiceSettings(request: SingingVoiceRequest) {
  return {
    diffusionSteps: Math.max(4, Math.min(100, Math.trunc(request.diffusionSteps ?? 30))),
    semitoneShift: Math.max(-24, Math.min(24, Math.trunc(request.semitoneShift ?? 0))),
    inferenceCfgRate: Math.max(0, Math.min(1, request.inferenceCfgRate ?? 0.7)),
    lengthAdjust: Math.max(0.5, Math.min(2, request.lengthAdjust ?? 1)),
  }
}

export function inferenceArguments(request: SingingVoiceRequest, outputDirectory: string) {
  const settings = singingVoiceSettings(request)
  return ['inference.py', '--source', request.sourcePath, '--target', request.referencePath, '--output', outputDirectory, '--diffusion-steps', String(settings.diffusionSteps), '--length-adjust', String(settings.lengthAdjust), '--inference-cfg-rate', String(settings.inferenceCfgRate), '--f0-condition', 'True', '--auto-f0-adjust', 'False', '--semi-tone-shift', String(settings.semitoneShift), '--fp16', 'True']
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() }); child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error((stderr || stdout || `Seed-VC exited with ${code}`).trim().slice(-4000))))
  })
}

async function aceStepIsRunning() {
  try { return (await fetch('http://127.0.0.1:8001/health', { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
}

export async function ensureSingingVoiceConversionReady(request: SingingVoiceRequest) {
  if (!request.voiceRightsConfirmed) throw new Error('voiceRightsConfirmed must be true: only use a voice you own or have explicit permission to use.')
  if (await aceStepIsRunning()) throw new Error('ACE-Step is still using GPU memory. Stop it in Resonant before starting Seed-VC conversion.')
  const location = locations()
  if (!await installed(location)) throw new Error('Seed-VC installation is incomplete. Open Seed-VC Studio in the Resonant desktop app and retry Install.')
  return location
}

export async function convertSingingVoice(request: SingingVoiceRequest) {
  const location = await ensureSingingVoiceConversionReady(request)
  const jobDirectory = path.join(location.outputs, `mcp-${Date.now()}-${process.pid}`); await mkdir(jobDirectory, { recursive: true })
  await run(location.python, inferenceArguments(request, jobDirectory), location.runtime, { ...process.env, HF_HOME: path.join(location.root, 'cache', 'huggingface'), HF_HUB_DISABLE_XET: '1', PYTHONUTF8: '1' })
  const candidates = (await readdir(jobDirectory)).filter((name) => name.toLowerCase().endsWith('.wav'))
  if (!candidates.length) throw new Error('Seed-VC completed without producing a WAV file.')
  const ranked = await Promise.all(candidates.map(async (name) => ({ name, modified: (await stat(path.join(jobDirectory, name))).mtimeMs })))
  ranked.sort((a, b) => b.modified - a.modified)
  const output = path.join(jobDirectory, ranked[0].name)
  const settings = singingVoiceSettings(request)
  const [sourceHash, referenceHash] = await Promise.all([request.sourcePath, request.referencePath].map(async (file) => createHash('sha256').update(await readFile(file)).digest('hex')))
  const provenance = { provider: 'Seed-VC', revision: SEED_VC_REVISION, source: { name: path.basename(request.sourcePath), sha256: sourceHash }, reference: { name: path.basename(request.referencePath), sha256: referenceHash }, voiceRightsConfirmed: true, confirmedAt: new Date().toISOString(), settings }
  await writeFile(`${output}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`)
  return { wav: new Uint8Array(await readFile(output)), provider: 'Seed-VC', revision: SEED_VC_REVISION, model: 'seed-uvit-whisper-base', settings, provenance }
}
