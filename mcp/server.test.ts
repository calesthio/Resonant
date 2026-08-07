import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAiMusicAudio } from './server'
import { ResonantWorkspace } from './workspace'

const temporary: string[] = []

afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'resonant-ai-audio-'))
  temporary.push(root)
  await writeFile(path.join(root, 'my voice.wav'), new Uint8Array([82, 73, 70, 70]))
  return { root, workspace: new ResonantWorkspace(root) }
}

describe('MCP AI audio conditioning', () => {
  it('resolves a confined reference WAV to the absolute server path', async () => {
    const { root, workspace } = await fixture()
    await expect(resolveAiMusicAudio(workspace, {
      prompt: 'Intimate acoustic pop', taskType: 'text2music', referenceAudioPath: 'my voice.wav',
    })).resolves.toMatchObject({
      taskType: 'text2music', referenceAudioPath: path.join(root, 'my voice.wav'),
    })
  })

  it('requires source audio for cover and repaint tasks', async () => {
    const { workspace } = await fixture()
    await expect(resolveAiMusicAudio(workspace, { prompt: 'Soul cover', taskType: 'cover' })).rejects.toThrow(/requires sourceAudioPath/i)
    await expect(resolveAiMusicAudio(workspace, { prompt: 'Repair phrase', taskType: 'repaint' })).rejects.toThrow(/requires sourceAudioPath/i)
  })

  it('rejects misplaced source and repaint controls before contacting ACE-Step', async () => {
    const { workspace } = await fixture()
    await expect(resolveAiMusicAudio(workspace, {
      prompt: 'Original pop', taskType: 'text2music', sourceAudioPath: 'my voice.wav',
    })).rejects.toThrow(/only valid for cover or repaint/i)
    await expect(resolveAiMusicAudio(workspace, {
      prompt: 'Soul cover', taskType: 'cover', sourceAudioPath: 'my voice.wav', repaintingStart: 2,
    })).rejects.toThrow(/only valid when taskType is repaint/i)
  })

  it('rejects an inverted repaint interval', async () => {
    const { workspace } = await fixture()
    await expect(resolveAiMusicAudio(workspace, {
      prompt: 'Repair phrase', taskType: 'repaint', sourceAudioPath: 'my voice.wav', repaintingStart: 8, repaintingEnd: 4,
    })).rejects.toThrow(/greater than repaintingStart/i)
  })
})
