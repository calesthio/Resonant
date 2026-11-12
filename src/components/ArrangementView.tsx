import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Rows3, ChevronLeft, ChevronRight, Copy, Minus, Plus, Trash2, ZoomIn, ZoomOut } from 'lucide-react'
import { makeId, touch } from '../domain/project'
import { useAppStore } from '../store/AppStore'
import { isEditingText, moveBlocks, resizeBlock } from '../domain/arrangementEditing'
import { formatElapsed, quantizeBeat } from '../domain/time'
import type { ArrangementBlock, Project } from '../domain/types'

interface Drag {
  pointerId: number; x: number; mode: 'move' | 'left' | 'right'; blockId: string
  ids: string[]; project: Project; blocks: ArrangementBlock[]; moved: boolean
}

export function ArrangementView({ beat, onSeek, notify, captureSession }: { beat: number; onSeek(beat: number): void; notify(message: string, tone?: 'info' | 'error' | 'success'): void; captureSession(): void }) {
  const store = useAppStore()
  const [pixelsPerBeat, setPixelsPerBeat] = useState(34)
  const [selection, setSelection] = useState<string[]>([])
  const [preview, setPreview] = useState<ArrangementBlock[] | null>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const zoomAnchor = useRef<{ beat: number; x: number } | null>(null)
  const scrub = useRef<{ pointerId: number; startBeat: number } | null>(null)
  const selectedIds = selection.filter((id) => store.project.arrangement.some((block) => block.id === id))
  const ids = selectedIds.length ? selectedIds : store.selectedBlockId ? [store.selectedBlockId] : []
  const blocks = preview ?? store.project.arrangement
  const arrangementEnd = store.project.arrangement.reduce((end, block) => Math.max(end, block.startBeat + block.lengthBeats), 0)
  const bars = Math.min(4096, Math.max(32, Math.ceil((Math.max(arrangementEnd, store.project.loop.endBeat, beat) + 4) / 4))), width = bars * 4 * pixelsPerBeat
  const selected = store.project.arrangement.find((block) => block.id === store.selectedBlockId)

  const zoom = (next: number, clientX?: number) => {
    const viewport = scrollRef.current
    if (!viewport) return
    const x = clientX === undefined ? viewport.clientWidth / 2 : clientX - viewport.getBoundingClientRect().left
    zoomAnchor.current = { beat: Math.max(0, (viewport.scrollLeft + x - 112) / pixelsPerBeat), x }
    setPixelsPerBeat(Math.max(8, Math.min(240, next)))
  }
  useLayoutEffect(() => {
    if (zoomAnchor.current && scrollRef.current) {
      scrollRef.current.scrollLeft = 112 + zoomAnchor.current.beat * pixelsPerBeat - zoomAnchor.current.x
      zoomAnchor.current = null
    }
  }, [pixelsPerBeat])
  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    const wheel = (event: WheelEvent) => {
      if (event.shiftKey || isEditingText(event.target) || drag.current || scrub.current || !event.deltaY) return
      event.preventDefault()
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
      zoom(pixelsPerBeat * Math.exp(-Math.max(-200, Math.min(200, pixels)) * 0.002), event.clientX)
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  })
  const seekAt = (clientX: number) => {
    const rect = timelineRef.current?.getBoundingClientRect()
    if (rect) onSeek(Math.max(0, Math.min(16384, (clientX - rect.left - 112) / pixelsPerBeat)))
  }
  const startScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || drag.current) return
    event.preventDefault(); event.stopPropagation()
    scrub.current = { pointerId: event.pointerId, startBeat: beat }
    event.currentTarget.setPointerCapture(event.pointerId); seekAt(event.clientX)
  }
  const moveScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (scrub.current?.pointerId === event.pointerId) seekAt(event.clientX)
  }
  const finishScrub = (event: ReactPointerEvent<HTMLElement>, cancel = false) => {
    const active = scrub.current
    if (!active || active.pointerId !== event.pointerId) return
    scrub.current = null
    if (cancel) onSeek(active.startBeat); else seekAt(event.clientX)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const editSelected = (deltaStart = 0, deltaLength = 0) => {
    if (!ids.length) return
    const arrangement = deltaStart ? moveBlocks(store.project.arrangement, ids, deltaStart) : store.project.arrangement.map((block) => ids.includes(block.id) ? resizeBlock(block, 'right', deltaLength, store.project.clips[block.clipId].lengthBeats) : block)
    store.commit(touch({ ...store.project, arrangement }), deltaStart ? 'Move arrangement block' : 'Resize arrangement block')
  }
  const removeSelected = () => {
    if (!ids.length) return
    store.commit(touch({ ...store.project, arrangement: store.project.arrangement.filter((block) => !ids.includes(block.id)) }), 'Remove arrangement blocks'); store.selectBlock(null); setSelection([])
  }
  const duplicateSelected = () => {
    const group = store.project.arrangement.filter((block) => ids.includes(block.id))
    if (!group.length) return
    const span = Math.max(...group.map((b) => b.startBeat + b.lengthBeats)) - Math.min(...group.map((b) => b.startBeat))
    if (group.some((block) => block.startBeat + span > 16384)) { notify('These blocks cannot be duplicated beyond the project timeline limit.', 'error'); return }
    const duplicates = group.map((block) => ({ ...block, id: makeId('block'), startBeat: block.startBeat + span }))
    store.commit(touch({ ...store.project, arrangement: [...store.project.arrangement, ...duplicates] }), 'Duplicate arrangement blocks'); store.selectBlock(duplicates[0].id); setSelection(duplicates.map((b) => b.id))
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditingText(event.target) || document.querySelector('[role="dialog"]')) return
      if (drag.current) {
        if (event.key === 'Escape') { event.preventDefault(); drag.current = null; setPreview(null); suppressClick.current = true }
        return
      }
      const command = event.ctrlKey || event.metaKey
      if (command && event.key.toLowerCase() === 'a') {
        event.preventDefault(); setSelection(store.project.arrangement.map((b) => b.id)); store.selectBlock(store.project.arrangement[0]?.id ?? null)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (ids.length) { event.preventDefault(); removeSelected() }
      } else if (command && event.key.toLowerCase() === 'd') {
        event.preventDefault(); duplicateSelected()
      } else if (event.key === 'Escape') {
        event.preventDefault(); setSelection([]); store.selectBlock(null)
      } else if (ids.length && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault(); const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (command ? 0.25 : 1)
        if (event.shiftKey) editSelected(0, delta); else editSelected(delta, 0)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, block: ArrangementBlock) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-resize]')?.dataset.resize
    const mode = edge === 'left' || edge === 'right' ? edge : 'move'
    const group = mode === 'move' && ids.includes(block.id) ? ids : [block.id]
    setSelection(group); store.selectTrack(block.trackId, block.clipId); store.selectBlock(block.id)
    drag.current = { pointerId: event.pointerId, x: event.clientX, mode, blockId: block.id, ids: group, project: store.project, blocks: store.project.arrangement, moved: false }
    suppressClick.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    if (active.project !== store.project) { drag.current = null; setPreview(null); return }
    if (!active.moved && Math.abs(event.clientX - active.x) < 3) return
    active.moved = true
    const delta = (event.clientX - active.x) / pixelsPerBeat
    active.blocks = active.mode === 'move' ? moveBlocks(active.project.arrangement, active.ids, delta) : active.project.arrangement.map((block) => block.id === active.blockId ? resizeBlock(block, active.mode as 'left' | 'right', delta, active.project.clips[block.clipId].lengthBeats) : block)
    setPreview(active.blocks)
  }
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancel = false) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    if (!cancel) updateDrag(event)
    drag.current = null; setPreview(null); suppressClick.current = active.moved
    if (!cancel && active.moved && active.project === store.project && active.blocks.some((block, i) => JSON.stringify(block) !== JSON.stringify(active.project.arrangement[i]))) {
      store.commit(touch({ ...active.project, arrangement: active.blocks }), active.mode === 'move' ? 'Move arrangement blocks' : 'Resize arrangement block')
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <div className="arrange-view">
    <div className="section-heading arrange-heading"><div><span className="eyebrow">LINEAR COMPOSITION</span><h2>Arrangement</h2></div><div className="arrange-tools">
      <button onClick={captureSession}><Rows3 size={14} /> CAPTURE SESSION</button><span className="tool-divider" />
      <label className="loop-range"><span>LOOP</span><input aria-label="Loop start beat" type="number" min="0" max={store.project.loop.endBeat - 1} value={store.project.loop.startBeat} onChange={(event) => {
        const startBeat = Math.max(0, Math.min(store.project.loop.endBeat - 1, Number(event.target.value))); store.commit(touch({ ...store.project, loop: { ...store.project.loop, startBeat } }), 'Change loop start')
      }} /><i>→</i><input aria-label="Loop end beat" type="number" min={store.project.loop.startBeat + 1} max="16384" value={store.project.loop.endBeat} onChange={(event) => {
        const endBeat = Math.max(store.project.loop.startBeat + 1, Math.min(16384, Number(event.target.value))); store.commit(touch({ ...store.project, loop: { ...store.project.loop, endBeat } }), 'Change loop end')
      }} /></label><span className="tool-divider" />
      <button disabled={!selected} title="Move one beat left" onClick={() => editSelected(-1, 0)}><ChevronLeft size={14} /></button><button disabled={!selected} title="Move one beat right" onClick={() => editSelected(1, 0)}><ChevronRight size={14} /></button>
      <button disabled={!selected} title="Shorten one beat" onClick={() => editSelected(0, -1)}><Minus size={14} /></button><button disabled={!selected} title="Lengthen one beat" onClick={() => editSelected(0, 1)}><Plus size={14} /></button>
      <button disabled={!selected} title="Duplicate block" aria-label="Duplicate selected blocks (Ctrl+D)" onClick={duplicateSelected}><Copy size={14} /></button><button disabled={!selected} title="Delete block" aria-label="Delete selected blocks (Delete)" onClick={removeSelected}><Trash2 size={14} /></button><span className="tool-divider" />
      <button title="Zoom out" onClick={() => zoom(pixelsPerBeat / 1.25)}><ZoomOut size={14} /></button><b>{Math.round(pixelsPerBeat / 34 * 100)}%</b><button title="Zoom in" onClick={() => zoom(pixelsPerBeat * 1.25)}><ZoomIn size={14} /></button>
    </div></div>
    <div ref={scrollRef} className="timeline-scroll" aria-label="Arrangement timeline">
      <div ref={timelineRef} className="timeline" style={{ width: width + 112 }} onPointerDown={(event) => { if (event.target === event.currentTarget) startScrub(event) }} onPointerMove={moveScrub} onPointerUp={(event) => finishScrub(event)} onPointerCancel={(event) => finishScrub(event, true)} onLostPointerCapture={(event) => finishScrub(event, true)}>
        <div className="ruler-label">BARS</div><div className="ruler" aria-label="Seek on timeline ruler" style={{ width }} onPointerDown={startScrub}>{Array.from({ length: bars }, (_, index) => <span key={index} style={{ width: pixelsPerBeat * 4 }}>{index + 1}<i /></span>)}</div>
        {store.project.tracks.map((track, trackIndex) => <div className="arrangement-row" key={track.id}>
          <button className="arrangement-track-label" onClick={() => store.selectTrack(track.id, track.sessionSlots.find(Boolean) ?? null)}><span style={{ background: track.color }} />{String(trackIndex + 1).padStart(2, '0')}<strong>{track.name}</strong></button>
          <div className="arrangement-lane" style={{ width, backgroundSize: `${pixelsPerBeat}px 100%, ${pixelsPerBeat * 4}px 100%` }} onClick={(event) => {
            if (event.target !== event.currentTarget) return
            const clipId = store.selectedTrackId === track.id ? store.selectedClipId : track.sessionSlots.find(Boolean)
            if (!clipId || !store.project.clips[clipId]) { notify(`Choose a ${track.name} clip in Flow first.`, 'error'); return }
            const rect = event.currentTarget.getBoundingClientRect(), startBeat = Math.max(0, Math.min(16384, quantizeBeat((event.clientX - rect.left) / pixelsPerBeat)))
            const block = { id: makeId('block'), trackId: track.id, clipId, startBeat, lengthBeats: 4, offsetBeats: 0 }
            store.commit(touch({ ...store.project, arrangement: [...store.project.arrangement, block] }), 'Place arrangement block'); store.selectBlock(block.id); setSelection([block.id])
          }}>
            {blocks.filter((block) => block.trackId === track.id).map((block) => {
              const clip = store.project.clips[block.clipId]
              return <button key={block.id} aria-pressed={ids.includes(block.id)} aria-label={`${clip?.name ?? 'Missing clip'}, ${block.lengthBeats} beats, starts ${formatElapsed(block.startBeat, store.project.bpm)}`} className={`arrangement-block ${ids.includes(block.id) ? 'selected' : ''}`} style={{ left: block.startBeat * pixelsPerBeat, width: Math.max(8, block.lengthBeats * pixelsPerBeat), '--clip-color': clip?.color ?? track.color } as React.CSSProperties}
                onPointerDown={(event) => startDrag(event, block)} onPointerMove={updateDrag} onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={(event) => finishDrag(event, true)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (suppressClick.current) { suppressClick.current = false; return }
                  const group = event.shiftKey || event.ctrlKey || event.metaKey ? ids.includes(block.id) ? ids.filter((id) => id !== block.id) : [...ids, block.id] : [block.id]
                  setSelection(group); store.selectTrack(track.id, block.clipId); store.selectBlock(group.includes(block.id) ? block.id : group[0] ?? null)
                }}>
                <span className="block-title">{clip?.name ?? 'Missing clip'}</span><span className="block-loop" style={{ backgroundSize: `${(clip?.lengthBeats ?? 4) * pixelsPerBeat}px 100%` }} /><small>{Math.round(block.lengthBeats * 1000) / 1000} beats</small>
                <span className="block-resize left" data-resize="left" title="Drag to resize start (¼-beat snap)" aria-hidden="true" /><span className="block-resize right" data-resize="right" title="Drag to resize end (¼-beat snap)" aria-hidden="true" />
              </button>
            })}
          </div>
        </div>)}
        <div className="timeline-seek-space" aria-label="Seek below arrangement" onPointerDown={startScrub} />
        <div className="arrangement-playhead-hit" aria-hidden="true" style={{ left: 112 + beat * pixelsPerBeat }} onPointerDown={startScrub} />
        <div className="arrangement-playhead" role="slider" aria-label="Song playhead" aria-valuemin={0} aria-valuemax={16384} aria-valuenow={beat} aria-valuetext={formatElapsed(beat, store.project.bpm)} tabIndex={0} style={{ left: 112 + beat * pixelsPerBeat }} onPointerDown={startScrub} onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); onSeek(Math.max(0, Math.min(16384, beat + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .01 : .25)))) }
        }}><span /></div>
      </div>
      {!store.project.arrangement.length && <div className="arrangement-empty"><Rows3 size={24} /><strong>Your song has room to breathe.</strong><span>Capture a live combination, or click any track lane to place the selected clip.</span><button onClick={captureSession}>CAPTURE ACTIVE CLIPS</button></div>}
    </div>
  </div>
}
