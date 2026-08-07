const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('resonantDesktop', {
  getMcpSetup: () => ipcRenderer.invoke('mcp:setup'),
  chooseMcpRoot: () => ipcRenderer.invoke('mcp:choose-root'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveProject: (content, saveAs = false) => ipcRenderer.invoke('project:save', { content, saveAs }),
  resetProjectPath: () => ipcRenderer.invoke('project:reset-path'),
  openProject: () => ipcRenderer.invoke('project:open'),
  autosave: (content) => ipcRenderer.invoke('project:autosave', content),
  readRecovery: () => ipcRenderer.invoke('project:recovery'),
  clearRecovery: () => ipcRenderer.invoke('project:clear-recovery'),
  onExternalProjectChange: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('project:external-change', listener)
    return () => ipcRenderer.removeListener('project:external-change', listener)
  },
  importAudio: () => ipcRenderer.invoke('audio:import'),
  exportAudio: (data, suggestedName) => ipcRenderer.invoke('audio:export', { data, suggestedName }),
  storeAudioAsset: (request) => ipcRenderer.invoke('audio-asset:store', request),
  resolveAudioAsset: (id) => ipcRenderer.invoke('audio-asset:resolve', id),
  getInstrumentLibrary: () => ipcRenderer.invoke('instrument:state'),
  searchInstrumentCatalog: (query) => ipcRenderer.invoke('instrument:catalog', query),
  installGeneralUser: () => ipcRenderer.invoke('instrument:install-generaluser'),
  installWebAudioFont: (preset) => ipcRenderer.invoke('instrument:install-webaudiofont', preset),
  importInstrument: () => ipcRenderer.invoke('instrument:import'),
  resolveInstrument: (id) => ipcRenderer.invoke('instrument:resolve', id),
  removeInstrumentPack: (id) => ipcRenderer.invoke('instrument:remove', id),
  onInstrumentProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('instrument:progress', listener)
    return () => ipcRenderer.removeListener('instrument:progress', listener)
  },
  getAceStepState: () => ipcRenderer.invoke('ace:state'),
  installAceStep: () => ipcRenderer.invoke('ace:install'),
  startAceStep: () => ipcRenderer.invoke('ace:start'),
  stopAceStep: () => ipcRenderer.invoke('ace:stop'),
  generateWithAceStep: (request) => ipcRenderer.invoke('ace:generate', request),
  removeAceStep: () => ipcRenderer.invoke('ace:remove'),
  onAceStepProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('ace:progress', listener)
    return () => ipcRenderer.removeListener('ace:progress', listener)
  },
  getSeedVcState: () => ipcRenderer.invoke('seed-vc:state'),
  installSeedVc: () => ipcRenderer.invoke('seed-vc:install'),
  chooseSeedVcAudio: (role) => ipcRenderer.invoke('seed-vc:choose-audio', role),
  convertWithSeedVc: (request) => ipcRenderer.invoke('seed-vc:convert', request),
  removeSeedVc: () => ipcRenderer.invoke('seed-vc:remove'),
  onSeedVcProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('seed-vc:progress', listener)
    return () => ipcRenderer.removeListener('seed-vc:progress', listener)
  },
})
