export const STEPS_PER_BEAT = 4
export const BEATS_PER_BAR = 4
export const beatToSeconds = (beat: number, bpm: number) => beat * 60 / bpm
export const secondsToBeat = (seconds: number, bpm: number) => seconds * bpm / 60
export const beatToSample = (beat: number, bpm: number, sampleRate: number) => Math.round(beatToSeconds(beat, bpm) * sampleRate)
export const stepToBeat = (step: number) => step / STEPS_PER_BEAT
export const quantizeBeat = (beat: number, division = 0.25) => Math.round(beat / division) * division
export const formatElapsed = (beat: number, bpm: number) => {
  const milliseconds = Math.max(0, Math.floor(beatToSeconds(beat, bpm) * 1000))
  return `${String(Math.floor(milliseconds / 60000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
}
export const formatBeat = (beat: number) => {
  const bar = Math.floor(beat / BEATS_PER_BAR) + 1
  const within = Math.max(0, beat % BEATS_PER_BAR)
  const quarter = Math.floor(within) + 1
  const sixteenth = Math.floor((within % 1) * 4) + 1
  return `${String(bar).padStart(2, '0')}.${quarter}.${sixteenth}`
}
