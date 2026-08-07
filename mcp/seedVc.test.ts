import { describe, expect, it } from 'vitest'
import { inferenceArguments } from './seedVc'

describe('Seed-VC MCP boundary', () => {
  it('builds singing conversion arguments with F0 conditioning and bounded settings', () => {
    expect(inferenceArguments({ sourcePath: 'source.wav', referencePath: 'mine.wav', voiceRightsConfirmed: true, diffusionSteps: 200, semitoneShift: -40, inferenceCfgRate: 3, lengthAdjust: 4 }, 'out')).toEqual([
      'inference.py', '--source', 'source.wav', '--target', 'mine.wav', '--output', 'out', '--diffusion-steps', '100', '--length-adjust', '2', '--inference-cfg-rate', '1', '--f0-condition', 'True', '--auto-f0-adjust', 'False', '--semi-tone-shift', '-24', '--fp16', 'True',
    ])
  })
})
