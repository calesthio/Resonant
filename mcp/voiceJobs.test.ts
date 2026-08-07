import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { abandonDurableVoiceJob, collectDurableVoiceJob, getDurableVoiceJob, markDurableVoiceJobCollected, runDurableVoiceJob, startDurableVoiceJob } from './voiceJobs'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function installedRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'resonant-seed-vc-jobs-'))
  roots.push(root)
  const executable = path.join(root, 'runtime', '.venv', 'Scripts', process.platform === 'win32' ? 'python.exe' : 'python')
  await mkdir(path.dirname(executable), { recursive: true })
  await Promise.all([writeFile(executable, ''), writeFile(path.join(root, 'runtime', 'inference.py'), '')])
  vi.stubEnv('RESONANT_SEED_VC_ROOT', root)
  return root
}

describe('durable Seed-VC jobs', () => {
  it('persists a queued job and reuses an idempotency key', async () => {
    await installedRoot()
    const launched: string[] = []
    const request = { sourcePath: 'source.wav', referencePath: 'reference.wav', voiceRightsConfirmed: true, lengthAdjust: 1.25 }
    const ready = async () => ({}) as never
    const first = await startDurableVoiceJob(request, 'voice-job-retry', (id) => { launched.push(id); return {} as never }, ready)
    const second = await startDurableVoiceJob(request, 'voice-job-retry', (id) => { launched.push(id); return {} as never }, ready)
    expect(second.reused).toBe(true)
    expect(second.job.id).toBe(first.job.id)
    expect(launched).toEqual([first.job.id])
    await expect(getDurableVoiceJob(first.job.id)).resolves.toMatchObject({ status: 'queued', progress: 0 })
  })

  it('rejects changed idempotent requests and prevents collection after abandonment', async () => {
    await installedRoot()
    const launch = () => ({} as never)
    const ready = async () => ({}) as never
    const request = { sourcePath: 'source.wav', referencePath: 'reference.wav', voiceRightsConfirmed: true }
    const started = await startDurableVoiceJob(request, 'stable-voice-key', launch, ready)
    await expect(startDurableVoiceJob({ ...request, lengthAdjust: 1.2 }, 'stable-voice-key', launch, ready)).rejects.toThrow('different request')
    await expect(abandonDurableVoiceJob(started.job.id)).resolves.toMatchObject({ status: 'abandoned', engineInterrupted: false })
    await expect(getDurableVoiceJob(started.job.id)).resolves.toMatchObject({ status: 'abandoned' })
  })

  it('moves a detached conversion through succeeded and collected states', async () => {
    await installedRoot()
    const ready = async () => ({}) as never
    const started = await startDurableVoiceJob({ sourcePath: 'source.wav', referencePath: 'reference.wav', voiceRightsConfirmed: true, lengthAdjust: 0.75 }, undefined, () => ({} as never), ready)
    await runDurableVoiceJob(started.job.id, async () => ({
      wav: new Uint8Array([82, 73, 70, 70]), provider: 'Seed-VC', revision: 'test-revision', model: 'seed-uvit-whisper-base',
      settings: { diffusionSteps: 30, semitoneShift: 0, inferenceCfgRate: 0.7, lengthAdjust: 0.75 }, provenance: { voiceRightsConfirmed: true },
    }))
    await expect(getDurableVoiceJob(started.job.id)).resolves.toMatchObject({ status: 'succeeded', progress: 1, settings: { lengthAdjust: 0.75 } })
    await expect(collectDurableVoiceJob(started.job.id)).resolves.toMatchObject({ provider: 'Seed-VC', wav: new Uint8Array([82, 73, 70, 70]) })
    await markDurableVoiceJobCollected(started.job.id, 'converted.wav')
    await expect(getDurableVoiceJob(started.job.id)).resolves.toMatchObject({ collectedOutput: 'converted.wav' })
  })
})
