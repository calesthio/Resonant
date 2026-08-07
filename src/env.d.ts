export {}

import type { InstrumentDownloadProgress, InstrumentLibraryState, InstrumentSummary, ResolvedInstrument } from './domain/instruments'
import type { AceStepGenerateRequest, AceStepGeneration, AceStepProgress, AceStepState } from './domain/aceStep'
import type { SeedVcConversion, SeedVcConvertRequest, SeedVcProgress, SeedVcState } from './domain/seedVc'

declare global {
  interface Window {
    resonantDesktop?: {
      getMcpSetup(): Promise<McpSetupInfo>
      chooseMcpRoot(): Promise<{ canceled: boolean; setup?: McpSetupInfo }>
      copyText(text: string): Promise<boolean>
      saveProject(content: string, saveAs?: boolean): Promise<{ canceled: boolean; path?: string }>
      resetProjectPath(): Promise<boolean>
      openProject(): Promise<{ canceled: boolean; path?: string; content?: string }>
      autosave(content: string): Promise<boolean>
      readRecovery(): Promise<string | null>
      clearRecovery(): Promise<boolean>
      onExternalProjectChange(callback: (payload: { path: string; content: string }) => void): () => void
      importAudio(): Promise<{ canceled: boolean; name?: string; data?: ArrayBuffer }>
      exportAudio(data: Uint8Array, suggestedName: string): Promise<{ canceled: boolean; path?: string }>
      storeAudioAsset(request: { channels: ArrayBuffer[]; sampleRate: number }): Promise<{ id: string; sha256: string; bytes: number; format: 'wav-pcm16' }>
      resolveAudioAsset(id: string): Promise<ArrayBuffer>
      getInstrumentLibrary(): Promise<InstrumentLibraryState>
      searchInstrumentCatalog(query: string): Promise<InstrumentSummary[]>
      installGeneralUser(): Promise<{ id: string; name: string; bytes: number; instrumentCount: number }>
      installWebAudioFont(preset: InstrumentSummary): Promise<{ id: string; name: string; bytes: number; instrumentCount: number }>
      importInstrument(): Promise<{ canceled: boolean; pack?: { id: string; name: string; bytes: number; instrumentCount: number } }>
      resolveInstrument(id: string): Promise<ResolvedInstrument>
      removeInstrumentPack(id: string): Promise<boolean>
      onInstrumentProgress(callback: (payload: InstrumentDownloadProgress) => void): () => void
      getAceStepState(): Promise<AceStepState>
      installAceStep(): Promise<AceStepState>
      startAceStep(): Promise<AceStepState>
      stopAceStep(): Promise<boolean>
      generateWithAceStep(request: AceStepGenerateRequest): Promise<AceStepGeneration>
      removeAceStep(): Promise<boolean>
      onAceStepProgress(callback: (payload: AceStepProgress) => void): () => void
      getSeedVcState(): Promise<SeedVcState>
      installSeedVc(): Promise<SeedVcState>
      chooseSeedVcAudio(role: 'source' | 'reference'): Promise<{ canceled: boolean; path?: string; name?: string }>
      convertWithSeedVc(request: SeedVcConvertRequest): Promise<SeedVcConversion>
      removeSeedVc(): Promise<boolean>
      onSeedVcProgress(callback: (payload: SeedVcProgress) => void): () => void
    }
  }
}

export interface McpSetupInfo {
  bundled: boolean
  packaged: boolean
  executable: string
  server: string
  workspaceRoot: string
  codex: string
  claude: string
  generic: string
  powershell: string
  launcher: string | null
}
