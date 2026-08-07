export interface SeedVcHardware {
  backend: 'cuda' | 'mps' | 'cpu'
  name: string
  vramMb: number | null
  driver: string | null
  adequate: boolean
  recommended: boolean
}

export interface SeedVcState {
  root: string
  revision: string
  installed: boolean
  bytes: number
  outputs: string[]
  hardware: SeedVcHardware
  profile: { model: string; sampleRate: number; fp16: boolean; minimumVramGb: number; recommendedVramGb: number }
}

export interface SeedVcProgress {
  phase: 'download' | 'setup' | 'model' | 'convert' | 'ready'
  label: string
  received: number
  total: number
}

export interface SeedVcConvertRequest {
  sourcePath: string
  referencePath: string
  voiceRightsConfirmed: boolean
  diffusionSteps: number
  semitoneShift: number
  inferenceCfgRate: number
  lengthAdjust: number
}

export interface SeedVcConversion {
  path: string
  name: string
  data: ArrayBuffer
  provenance: Record<string, unknown>
}

export const EMPTY_SEED_VC_STATE: SeedVcState = {
  root: 'Desktop app required', revision: '', installed: false, bytes: 0, outputs: [],
  hardware: { backend: 'cpu', name: 'Hardware not inspected', vramMb: null, driver: null, adequate: false, recommended: false },
  profile: { model: 'seed-uvit-whisper-base', sampleRate: 44100, fp16: true, minimumVramGb: 6, recommendedVramGb: 8 },
}
