import { quantizeBeat } from './time'
import type { ArrangementBlock } from './types'

export const TIMELINE_LIMIT = 16384
export const MIN_BLOCK_LENGTH = 0.25

export function moveBlocks(blocks: ArrangementBlock[], ids: readonly string[], delta: number) {
  const selected = blocks.filter((block) => ids.includes(block.id))
  if (!selected.length) return blocks
  const shift = Math.max(-Math.min(...selected.map((b) => b.startBeat)), Math.min(TIMELINE_LIMIT - Math.max(...selected.map((b) => b.startBeat)), quantizeBeat(delta)))
  return blocks.map((block) => ids.includes(block.id) ? { ...block, startBeat: block.startBeat + shift } : block)
}

// Resizing changes an arrangement instance, never the shared clip source or tempo.
export function resizeBlock(block: ArrangementBlock, edge: 'left' | 'right', delta: number, clipLength: number): ArrangementBlock {
  if (edge === 'right') return { ...block, lengthBeats: Math.max(MIN_BLOCK_LENGTH, Math.min(TIMELINE_LIMIT, block.lengthBeats + quantizeBeat(delta))) }
  const shift = Math.max(-block.startBeat, block.lengthBeats - TIMELINE_LIMIT, Math.min(block.lengthBeats - MIN_BLOCK_LENGTH, quantizeBeat(delta)))
  const offset = ((block.offsetBeats + shift) % clipLength + clipLength) % clipLength
  return { ...block, startBeat: block.startBeat + shift, lengthBeats: block.lengthBeats - shift, offsetBeats: offset }
}

export function isEditingText(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))
}
