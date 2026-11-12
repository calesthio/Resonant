import { describe, expect, it } from 'vitest'
import { moveBlocks, resizeBlock } from './arrangementEditing'
import { formatElapsed } from './time'
import { createDemoProject, validateProject } from './project'
import type { ArrangementBlock } from './types'

const block: ArrangementBlock = { id: 'a', trackId: 'track', clipId: 'clip', startBeat: 2, lengthBeats: 4, offsetBeats: 1 }
describe('arrangement gestures', () => {
  it('moves a group on the grid without changing spacing or unselected material', () => {
    const blocks = [block, { ...block, id: 'b', startBeat: 5 }, { ...block, id: 'c', startBeat: 8 }]
    const moved = moveBlocks(blocks, ['a', 'b'], -7)
    expect(moved.map((b) => b.startBeat)).toEqual([0, 3, 8])
    expect(moved[2]).toBe(blocks[2])
    expect(moveBlocks(blocks, ['a'], .36)[0].startBeat).toBe(2.25)
    expect(blocks[0].startBeat).toBe(2)
  })
  it('keeps group positions within the timeline limit', () => {
    const blocks = [block, { ...block, id: 'b', startBeat: 5 }]
    expect(moveBlocks(blocks, ['a', 'b'], 20000).map((b) => b.startBeat)).toEqual([16381, 16384])
  })
  it('trims the left edge while keeping the end and audible source position fixed', () => {
    const trimmed = resizeBlock(block, 'left', 1.12, 4)
    expect(trimmed).toMatchObject({ startBeat: 3, lengthBeats: 3, offsetBeats: 2 })
    expect(trimmed.startBeat + trimmed.lengthBeats).toBe(block.startBeat + block.lengthBeats)
    expect(resizeBlock(block, 'left', -3, 4)).toMatchObject({ startBeat: 0, lengthBeats: 6, offsetBeats: 3 })
  })
  it('clamps resize lengths and wraps source offsets when extending a loop', () => {
    expect(resizeBlock(block, 'right', -100, 4).lengthBeats).toBe(.25)
    expect(resizeBlock(block, 'right', 20000, 4).lengthBeats).toBe(16384)
    expect(resizeBlock({ ...block, lengthBeats: 16384 }, 'left', -1, 4).lengthBeats).toBe(16384)
    expect(resizeBlock(block, 'left', 100, 4)).toMatchObject({ startBeat: 5.75, lengthBeats: .25, offsetBeats: .75 })
    const p = createDemoProject(), b = p.arrangement[0]
    p.arrangement[0] = resizeBlock(b, 'left', -12, p.clips[b.clipId].lengthBeats)
    expect(() => validateProject(p)).not.toThrow()
  })
  it('formats elapsed time at tempo and minute boundaries', () => {
    expect(formatElapsed(0, 120)).toBe('00:00.000')
    expect(formatElapsed(8.25, 120)).toBe('00:04.125')
    expect(formatElapsed(128, 120)).toBe('01:04.000')
  })
})
