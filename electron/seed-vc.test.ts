import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const seedVc = require('./seed-vc.cjs') as {
  SEED_VC_REVISION: string
  state(root: string): Promise<{ installed: boolean; revision: string; profile: { model: string; minimumVramGb: number } }>
  managedRequirements(source: string): string
  stripAnsi(value: string): string
  convert(root: string, request: Record<string, unknown>): Promise<unknown>
}

describe('Seed-VC optional provider', () => {
  it('reports a pinned, absent installation safely', async () => {
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'resonant-seed-vc-')), 'seed-vc')
    await expect(seedVc.state(root)).resolves.toMatchObject({ installed: false, revision: seedVc.SEED_VC_REVISION, profile: { model: 'seed-uvit-whisper-base', minimumVramGb: 6 } })
  })

  it('requires explicit reference-voice rights before runtime checks', async () => {
    await expect(seedVc.convert('C:\\missing-seed-vc', { sourcePath: 'source.wav', referencePath: 'reference.wav' })).rejects.toThrow(/own the reference voice/i)
  })

  it('removes upstream inline PyTorch installer flags from managed requirements', () => {
    const source = 'torch --pre --index-url https://download.pytorch.org/whl/nightly/cu126\ntorch==2.4.0\ntorchaudio==2.4.0\nfunasr==1.1.5\nmodelscope==1.18.1\ngradio==5.23.0\nnumpy==1.26.4\nlibrosa==0.10.2\n'
    expect(seedVc.managedRequirements(source)).toBe('numpy==1.26.4\nlibrosa==0.10.2\n')
  })

  it('removes terminal control codes from installer progress and failures', () => {
    expect(seedVc.stripAnsi('\u001b[31merror\u001b[0m Expected `--hash`')).toBe('error Expected `--hash`')
  })

  it('does not report a partial runtime as installed before its manifest is committed', async () => {
    const root = path.join(await mkdtemp(path.join(tmpdir(), 'resonant-seed-vc-partial-')), 'seed-vc')
    const python = path.join(root, 'runtime', '.venv', 'Scripts', 'python.exe')
    await mkdir(path.dirname(python), { recursive: true })
    await Promise.all([writeFile(python, ''), writeFile(path.join(root, 'runtime', 'inference.py'), '')])
    await expect(seedVc.state(root)).resolves.toMatchObject({ installed: false })
  })
})
