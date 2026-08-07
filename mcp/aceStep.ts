import { spawn, type ChildProcess } from 'node:child_process'
import { access, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { prepareLyricsForGenerator } from '../src/songwriting/core'

const API_ORIGIN = 'http://127.0.0.1:8001'
let service: ChildProcess | null = null

export function aceStepRoot() {
  return process.env.RESONANT_ACE_ROOT || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'resonant-workstation', 'ai-generators', 'ace-step-1.5')
}

function locations() {
  const base = aceStepRoot()
  const runtime = path.join(base, 'runtime')
  return { root: base, runtime, models: path.join(base, 'models'), uv: path.join(base, 'tools', 'uv.exe'), api: path.join(runtime, '.venv', 'Scripts', process.platform === 'win32' ? 'acestep-api.exe' : 'acestep-api') }
}

async function exists(target: string) {
  try { await access(target); return true } catch { return false }
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

async function hasModelWeights(directory: string) {
  try { return (await readdir(directory)).some((name) => /^(model|pytorch_model|diffusion_pytorch_model).*(\.safetensors|\.bin|\.index\.json)$/i.test(name)) } catch { return false }
}

async function healthy() {
  try { return (await fetch(`${API_ORIGIN}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false }
}

export function launchAceStepService(executable: string, cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(executable, [], { cwd, env, windowsHide: true, stdio: 'ignore', detached: true })
  child.unref()
  return child
}

export async function aceStepState() {
  const location = locations()
  const installed = await exists(path.join(location.runtime, 'pyproject.toml')) && await exists(location.api)
  const modelsReady = (await Promise.all(['vae', 'Qwen3-Embedding-0.6B', 'acestep-v15-turbo', 'acestep-5Hz-lm-0.6B'].map((name) => hasModelWeights(path.join(location.models, name))))).every(Boolean)
  return { root: location.root, installed, modelsReady, running: installed && await healthy(), bytes: await bytes(location.root), profile: { dit: 'acestep-v15-turbo', languageModel: 'acestep-5Hz-lm-0.6B', backend: 'pt', cpuOffload: true, batchSize: 1 } }
}

function environment() {
  const location = locations()
  return {
    ...process.env,
    ACESTEP_PROJECT_ROOT: location.runtime,
    ACESTEP_CHECKPOINTS_DIR: location.models,
    ACESTEP_INIT_LLM: 'true', ACESTEP_CONFIG_PATH: 'acestep-v15-turbo', ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-0.6B', ACESTEP_LM_BACKEND: 'pt',
    ACESTEP_OFFLOAD_TO_CPU: 'true', ACESTEP_LM_OFFLOAD_TO_CPU: 'true', ACESTEP_API_HOST: '127.0.0.1', ACESTEP_API_PORT: '8001', ACESTEP_QUEUE_WORKERS: '1',
    ACESTEP_TMPDIR: path.join(location.root, 'cache', 'tmp'), HF_HOME: path.join(location.root, 'cache', 'huggingface'),
    HF_HUB_DISABLE_XET: '1', HF_HUB_DOWNLOAD_TIMEOUT: '120',
    TRITON_CACHE_DIR: path.join(location.root, 'cache', 'triton'), TORCHINDUCTOR_CACHE_DIR: path.join(location.root, 'cache', 'torchinductor'), UV_CACHE_DIR: path.join(location.root, 'cache', 'uv'),
  }
}

async function ensureService() {
  const location = locations()
  if (!await exists(location.api) || !await exists(path.join(location.runtime, 'pyproject.toml'))) throw new Error('ACE-Step 1.5 is not installed. Open ACE-Step Studio in the Resonant desktop app and run the optional installation first.')
  if (await healthy()) return
  if (!service || service.exitCode !== null) {
    service = launchAceStepService(location.api, location.runtime, environment())
    service.once('exit', () => { service = null })
  }
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    if (await healthy()) return
    if (!service || service.exitCode !== null) throw new Error('ACE-Step stopped while loading its models.')
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error('ACE-Step did not become ready within ten minutes.')
}

async function api(route: string, options: RequestInit = {}, timeout = 30_000) {
  const response = await fetch(`${API_ORIGIN}${route}`, { ...options, signal: AbortSignal.timeout(timeout) })
  const payload = await response.json() as { data?: unknown; code?: number; error?: string; detail?: string }
  if (!response.ok || payload.code && payload.code !== 200) throw new Error(payload.error || payload.detail || `ACE-Step request failed (${response.status}).`)
  return payload.data ?? payload
}

export interface AiMusicRequest {
  prompt: string
  lyrics?: string
  instrumental?: boolean
  duration?: number
  bpm?: number
  keyScale?: string
  seed?: number
  language?: string
  taskType?: 'text2music' | 'cover' | 'repaint'
  referenceAudioPath?: string
  sourceAudioPath?: string
  instruction?: string
  audioCoverStrength?: number
  repaintingStart?: number
  repaintingEnd?: number
}

export function generationPayload(request: AiMusicRequest) {
  const duration = Math.max(10, Math.min(180, request.duration ?? 30))
  return {
    prompt: request.prompt, lyrics: request.instrumental === false ? prepareLyricsForGenerator(request.lyrics || '', request.language) : '[Instrumental]', thinking: true,
    model: 'acestep-v15-turbo', lm_model_path: 'acestep-5Hz-lm-0.6B', lm_backend: 'pt', audio_duration: duration,
    bpm: request.bpm, key_scale: request.keyScale || '', time_signature: '4', inference_steps: 8, batch_size: 1, audio_format: 'wav',
    use_random_seed: request.seed === undefined, seed: request.seed ?? -1, use_tiled_decode: true,
    task_type: request.taskType ?? 'text2music', reference_audio_path: request.referenceAudioPath, src_audio_path: request.sourceAudioPath,
    instruction: request.instruction, audio_cover_strength: request.audioCoverStrength,
    repainting_start: request.repaintingStart, repainting_end: request.repaintingEnd,
  }
}

export async function startAiMusic(request: AiMusicRequest) {
  await ensureService()
  const task = await api('/release_task', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(generationPayload(request)),
  }, 10 * 60_000) as { task_id?: string } | null
  if (!task?.task_id) throw new Error(`ACE-Step did not return a task ID${task == null ? ' (empty response)' : ''}.`)
  return { taskId: task.task_id, submittedAt: new Date().toISOString() }
}

interface QueriedItem { status: number; result?: string; error?: string; progress_text?: string }
interface GeneratedItem { file?: string; metas?: Record<string, unknown>; seed_value?: string; dit_model?: string; lm_model?: string; progress?: number; stage?: string; error?: string }

export async function queryAiMusic(taskId: string) {
  await ensureService()
  const queried = await api('/query_result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id_list: [taskId] }) }) as QueriedItem[]
  const item = queried[0]
  if (!item) return { taskId, status: 'unknown' as const, progress: 0, stage: 'unknown', message: 'ACE-Step no longer knows this task.' }
  const generated = JSON.parse(item.result || '[]') as GeneratedItem[]
  const first = generated[0]
  if (item.status === 2) return { taskId, status: 'failed' as const, progress: first?.progress ?? 0, stage: first?.stage ?? 'failed', message: first?.error || item.error || item.progress_text || 'ACE-Step generation failed.' }
  if (item.status === 1) return { taskId, status: 'succeeded' as const, progress: 1, stage: 'complete', message: item.progress_text || 'Generation complete.', result: first }
  return { taskId, status: first?.stage === 'queued' ? 'queued' as const : 'running' as const, progress: Math.max(0, Math.min(1, Number(first?.progress) || 0)), stage: first?.stage || 'running', message: item.progress_text || first?.stage || 'Generating.' }
}

export async function collectAiMusic(taskId: string) {
  const queried = await queryAiMusic(taskId)
  if (queried.status === 'failed') throw new Error(queried.message)
  if (queried.status !== 'succeeded' || !queried.result?.file) throw new Error(`ACE-Step task ${taskId} is ${queried.status}; collect it after status is succeeded.`)
  const first = queried.result
  const file = first.file!
  const response = await fetch(file.startsWith('http') ? file : `${API_ORIGIN}${file}`)
  if (!response.ok) throw new Error(`ACE-Step audio download failed (${response.status}).`)
  return { wav: new Uint8Array(await response.arrayBuffer()), taskId, metadata: first.metas || {}, seed: first.seed_value || null, ditModel: first.dit_model, languageModel: first.lm_model }
}

export async function generateAiMusic(request: AiMusicRequest) {
  const task = await startAiMusic(request)
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const state = await queryAiMusic(task.taskId)
    if (state.status === 'failed') throw new Error(state.message)
    if (state.status === 'succeeded') return collectAiMusic(task.taskId)
  }
  throw new Error('ACE-Step generation timed out.')
}
