import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { convertSingingVoice, ensureSingingVoiceConversionReady, seedVcRoot, type SingingVoiceRequest } from './seedVc'

interface VoiceResult {
  provider: string
  revision: string
  model: string
  settings: Record<string, number>
  provenance: Record<string, unknown>
}

interface DurableVoiceJob {
  schemaVersion: 1
  id: string
  requestHash: string
  idempotencyHash?: string
  createdAt: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  request: SingingVoiceRequest
  resultPath?: string
  result?: VoiceResult
  error?: string
  startedAt?: string
  finishedAt?: string
  abandonedAt?: string
  collectedAt?: string
  collectedOutput?: string
}

function directory() { return path.join(seedVcRoot(), 'mcp-jobs') }
function jobPath(id: string) { return path.join(directory(), `${id}.json`) }
function resultPath(id: string) { return path.join(directory(), `${id}.wav`) }
function keyPath(hash: string) { return path.join(directory(), `key-${hash}.json`) }
function hash(value: string) { return createHash('sha256').update(value).digest('hex') }

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, file)
}

async function requireJob(id: string) {
  if (!/^voice-[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid voice-conversion job ID.')
  const job = await readJson<DurableVoiceJob>(jobPath(id))
  if (!job) throw new Error(`Voice-conversion job not found: ${id}.`)
  return job
}

async function activeJob() {
  let names: string[] = []
  try { names = await readdir(directory()) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  for (const name of names) {
    if (!/^voice-[a-f0-9-]{36}\.json$/i.test(name)) continue
    const job = await readJson<DurableVoiceJob>(path.join(directory(), name))
    if (job && (job.status === 'queued' || job.status === 'running') && !job.finishedAt) return job
  }
  return null
}

export function launchVoiceWorker(id: string) {
  const entry = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [entry, '--seed-vc-worker', id], { detached: true, windowsHide: true, stdio: 'ignore', env: process.env })
  child.unref()
  return child
}

export async function startDurableVoiceJob(request: SingingVoiceRequest, idempotencyKey?: string, launch = launchVoiceWorker, ensureReady = ensureSingingVoiceConversionReady) {
  const requestHash = hash(JSON.stringify(request))
  const idempotencyHash = idempotencyKey ? hash(idempotencyKey) : undefined
  let replacedJobId: string | undefined
  if (idempotencyHash) {
    const existingId = await readJson<{ jobId: string; requestHash: string }>(keyPath(idempotencyHash))
    if (existingId) {
      if (existingId.requestHash !== requestHash) throw new Error('This voice-conversion idempotency key was already used with a different request.')
      const existing = await readJson<DurableVoiceJob>(jobPath(existingId.jobId))
      if (existing && !existing.abandonedAt) return { job: existing, reused: true }
      replacedJobId = existing?.id
    }
  }
  await ensureReady(request)
  const active = await activeJob()
  if (active) throw new Error(`Seed-VC job ${active.id} is already ${active.status}. Poll or abandon it before starting another conversion.`)
  const job: DurableVoiceJob = { schemaVersion: 1, id: `voice-${randomUUID()}`, requestHash, idempotencyHash, createdAt: new Date().toISOString(), status: 'queued', request }
  await atomicJson(jobPath(job.id), job)
  if (idempotencyHash) await atomicJson(keyPath(idempotencyHash), { jobId: job.id, requestHash })
  launch(job.id)
  return { job, reused: false, replacedJobId }
}

export async function runDurableVoiceJob(id: string, convert = convertSingingVoice) {
  const job = await requireJob(id)
  if (job.abandonedAt) {
    if (!job.finishedAt) await atomicJson(jobPath(id), { ...job, status: 'failed', finishedAt: new Date().toISOString() })
    return
  }
  if (job.status === 'succeeded' || job.status === 'failed') return
  await atomicJson(jobPath(id), { ...job, status: 'running', startedAt: job.startedAt || new Date().toISOString() })
  try {
    const converted = await convert(job.request)
    const output = resultPath(id)
    await writeFile(output, converted.wav)
    const current = await requireJob(id)
    const result: VoiceResult = { provider: converted.provider, revision: converted.revision, model: converted.model, settings: converted.settings, provenance: converted.provenance }
    await atomicJson(jobPath(id), { ...current, status: 'succeeded', resultPath: output, result, finishedAt: new Date().toISOString() })
  } catch (error) {
    const current = await requireJob(id)
    await atomicJson(jobPath(id), { ...current, status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() })
  }
}

export async function getDurableVoiceJob(id: string) {
  const job = await requireJob(id)
  if (job.abandonedAt) return { jobId: id, status: 'abandoned' as const, progress: 0, stage: 'abandoned', message: 'Resonant will not collect this result. The isolated Seed-VC worker may still finish its current GPU operation.', createdAt: job.createdAt, abandonedAt: job.abandonedAt }
  if (job.status === 'failed') return { jobId: id, status: 'failed' as const, progress: 0, stage: 'failed', message: job.error || 'Seed-VC conversion failed.', createdAt: job.createdAt, finishedAt: job.finishedAt }
  if (job.status === 'succeeded') return { jobId: id, status: 'succeeded' as const, progress: 1, stage: 'complete', message: 'Seed-VC conversion is ready to collect.', createdAt: job.createdAt, finishedAt: job.finishedAt, collectedAt: job.collectedAt, collectedOutput: job.collectedOutput, settings: job.result?.settings }
  return { jobId: id, status: job.status, progress: job.status === 'running' ? 0.5 : 0, stage: job.status, message: job.status === 'running' ? 'Seed-VC is converting the vocal.' : 'Seed-VC conversion is queued.', createdAt: job.createdAt, startedAt: job.startedAt }
}

export async function collectDurableVoiceJob(id: string) {
  const job = await requireJob(id)
  if (job.abandonedAt) throw new Error('This voice-conversion job was abandoned and cannot be collected.')
  if (job.status === 'failed') throw new Error(job.error || 'Seed-VC conversion failed.')
  if (job.status !== 'succeeded' || !job.resultPath || !job.result) throw new Error(`Voice-conversion job ${id} is ${job.status}; collect it after status is succeeded.`)
  return { job, wav: new Uint8Array(await readFile(job.resultPath)), ...job.result }
}

export async function markDurableVoiceJobCollected(id: string, output: string) {
  const job = await requireJob(id)
  const changed = { ...job, collectedAt: new Date().toISOString(), collectedOutput: output }
  await atomicJson(jobPath(id), changed)
  return changed
}

export async function abandonDurableVoiceJob(id: string) {
  const job = await requireJob(id)
  if (job.collectedAt) throw new Error('A collected voice-conversion job cannot be abandoned.')
  const changed = { ...job, abandonedAt: job.abandonedAt || new Date().toISOString() }
  await atomicJson(jobPath(id), changed)
  return { jobId: id, status: 'abandoned' as const, abandonedAt: changed.abandonedAt, engineInterrupted: false, message: 'The result will not be collected. The isolated Seed-VC worker may finish its current GPU operation.' }
}
