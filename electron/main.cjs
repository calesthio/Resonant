const { app, BrowserWindow, clipboard, dialog, ipcMain, session } = require('electron')
const fs = require('node:fs/promises')
const { watch } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const instrumentLibrary = require('./instrument-library.cjs')
const aceStep = require('./ace-step.cjs')
const seedVc = require('./seed-vc.cjs')
const audioAssets = require('./audio-assets.cjs')

let mainWindow
let currentProjectPath = null
let currentProjectContent = null
let projectWatcher = null
let watcherTimer = null
let ignoreExternalUntil = 0
const smokeMode = process.env.RESONANT_SMOKE === '1'
const productionIndexUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href

function isAllowedAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return url.origin === 'http://127.0.0.1:5173' || url.href === productionIndexUrl
  } catch { return false }
}

function isTrusted(event) {
  const url = event.senderFrame?.url || ''
  return isAllowedAppUrl(url)
}

async function atomicWrite(filePath, data) {
  const temp = `${filePath}.saving-${process.pid}`
  await fs.writeFile(temp, data)
  await fs.rename(temp, filePath)
}

function recoveryPath() { return path.join(app.getPath('userData'), 'recovery.resonant') }
function instrumentRoot() { return instrumentLibrary.libraryRoot(app) }
function aceRoot() { return aceStep.libraryRoot(app) }
function seedVcRoot() { return seedVc.libraryRoot(app) }
function audioAssetRoot() { return audioAssets.libraryRoot(app) }

function mcpServerPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar', 'mcp-dist', 'server.mjs') : path.join(__dirname, '..', 'mcp-dist', 'server.mjs')
}

async function mcpSetup(root) {
  const workspaceRoot = root || (currentProjectPath ? path.dirname(currentProjectPath) : path.join(app.getPath('documents'), 'OpenMontage', 'projects'))
  await fs.mkdir(workspaceRoot, { recursive: true })
  const executable = process.execPath
  const server = mcpServerPath()
  const args = [server, '--root', workspaceRoot]
  const environment = { ELECTRON_RUN_AS_NODE: '1' }
  const codex = `[mcp_servers.resonant]\ncommand = ${JSON.stringify(executable)}\nargs = ${JSON.stringify(args)}\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n`
  const claude = `${JSON.stringify({ mcpServers: { resonant: { type: 'stdio', command: executable, args, env: environment } } }, null, 2)}\n`
  const powershell = `$env:ELECTRON_RUN_AS_NODE = '1'\n& ${JSON.stringify(executable)} ${JSON.stringify(server)} --root ${JSON.stringify(workspaceRoot)}\n`
  let bundled = true
  try { await fs.access(server) } catch { bundled = false }
  return { bundled, packaged: app.isPackaged, executable, server, workspaceRoot, codex, claude, generic: claude, powershell, launcher: app.isPackaged ? path.join(path.dirname(executable), 'Resonant-MCP.cmd') : null }
}

function stopProjectWatcher() {
  if (watcherTimer) clearTimeout(watcherTimer)
  watcherTimer = null
  projectWatcher?.close()
  projectWatcher = null
}

function watchProject(filePath) {
  stopProjectWatcher()
  const directory = path.dirname(filePath)
  const filename = path.basename(filePath).toLowerCase()
  projectWatcher = watch(directory, { persistent: false }, (_event, changed) => {
    if (changed && changed.toString().toLowerCase() !== filename) return
    if (Date.now() < ignoreExternalUntil) return
    if (watcherTimer) clearTimeout(watcherTimer)
    watcherTimer = setTimeout(async () => {
      if (currentProjectPath !== filePath || !mainWindow || mainWindow.isDestroyed()) return
      try {
        const content = await fs.readFile(filePath, 'utf8')
        if (content === currentProjectContent || content.length > 250_000_000) return
        currentProjectContent = content
        mainWindow.webContents.send('project:external-change', { path: filePath, content })
      } catch (error) { if (error.code !== 'ENOENT') console.error(`Project watch failed: ${error.message}`) }
    }, 250)
  })
  projectWatcher.on('error', (error) => console.error(`Project watcher stopped: ${error.message}`))
}

function registerIpc() {
  ipcMain.handle('mcp:setup', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted MCP setup request.')
    return mcpSetup()
  })
  ipcMain.handle('mcp:choose-root', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted MCP setup request.')
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose Resonant music workspace', defaultPath: currentProjectPath ? path.dirname(currentProjectPath) : path.join(app.getPath('documents'), 'OpenMontage', 'projects'), properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, setup: await mcpSetup(result.filePaths[0]) }
  })
  ipcMain.handle('clipboard:write', (event, text) => {
    if (!isTrusted(event) || typeof text !== 'string' || text.length > 100_000) throw new Error('Invalid clipboard request.')
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle('project:reset-path', (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted project request.')
    currentProjectPath = null
    currentProjectContent = null
    stopProjectWatcher()
    if (mainWindow) mainWindow.setTitle('Resonant')
    return true
  })
  ipcMain.handle('project:save', async (event, { content, saveAs }) => {
    if (!isTrusted(event) || typeof content !== 'string' || content.length > 250_000_000) throw new Error('Invalid save request.')
    let target = saveAs ? null : currentProjectPath
    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow, { title: 'Save Resonant project', defaultPath: 'Untitled piece.resonant', filters: [{ name: 'Resonant projects', extensions: ['resonant'] }] })
      if (result.canceled || !result.filePath) return { canceled: true }
      target = result.filePath.endsWith('.resonant') ? result.filePath : `${result.filePath}.resonant`
    }
    ignoreExternalUntil = Date.now() + 1200
    await atomicWrite(target, content)
    currentProjectPath = target
    currentProjectContent = content
    watchProject(target)
    mainWindow.setTitle(`${path.basename(target, '.resonant')} — Resonant`)
    return { canceled: false, path: target }
  })

  ipcMain.handle('project:open', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted open request.')
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Open Resonant project', properties: ['openFile'], filters: [{ name: 'Resonant projects', extensions: ['resonant'] }] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const target = result.filePaths[0]
    const content = await fs.readFile(target, 'utf8')
    if (content.length > 250_000_000) throw new Error('This project is too large to open safely.')
    currentProjectPath = target
    currentProjectContent = content
    watchProject(target)
    mainWindow.setTitle(`${path.basename(target, '.resonant')} — Resonant`)
    return { canceled: false, path: target, content }
  })

  ipcMain.handle('project:autosave', async (event, content) => {
    if (!isTrusted(event) || typeof content !== 'string' || content.length > 250_000_000) throw new Error('Invalid autosave.')
    await atomicWrite(recoveryPath(), content)
    return true
  })
  ipcMain.handle('project:recovery', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted recovery request.')
    try { return await fs.readFile(recoveryPath(), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  })
  ipcMain.handle('project:clear-recovery', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted recovery request.')
    try { await fs.unlink(recoveryPath()) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return true
  })
  ipcMain.handle('audio:import', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted import request.')
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import audio', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'webm'] }] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const target = result.filePaths[0]
    const stat = await fs.stat(target)
    if (stat.size > 100_000_000) throw new Error('Audio import is limited to 100 MB in this release.')
    const data = await fs.readFile(target)
    return { canceled: false, name: path.basename(target, path.extname(target)), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
  })
  ipcMain.handle('audio:export', async (event, { data, suggestedName }) => {
    if (!isTrusted(event) || !(data instanceof Uint8Array)) throw new Error('Invalid export request.')
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Export stereo WAV', defaultPath: `${suggestedName || 'Resonant export'}.wav`, filters: [{ name: 'Wave audio', extensions: ['wav'] }] })
    if (result.canceled || !result.filePath) return { canceled: true }
    const target = result.filePath.endsWith('.wav') ? result.filePath : `${result.filePath}.wav`
    await atomicWrite(target, Buffer.from(data))
    return { canceled: false, path: target }
  })
  ipcMain.handle('audio-asset:store', async (event, request) => {
    if (!isTrusted(event) || !request || !Array.isArray(request.channels) || request.channels.length < 1 || request.channels.length > 2) throw new Error('Invalid shared audio request.')
    return audioAssets.store(audioAssetRoot(), request)
  })
  ipcMain.handle('audio-asset:resolve', async (event, id) => {
    if (!isTrusted(event) || typeof id !== 'string') throw new Error('Invalid shared audio request.')
    return audioAssets.resolve(audioAssetRoot(), id)
  })
  ipcMain.handle('instrument:state', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted instrument request.')
    return instrumentLibrary.state(instrumentRoot())
  })
  ipcMain.handle('instrument:catalog', async (event, query) => {
    if (!isTrusted(event) || typeof query !== 'string' || query.length > 100) throw new Error('Invalid catalog request.')
    return instrumentLibrary.webAudioCatalog(query)
  })
  ipcMain.handle('instrument:install-generaluser', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted instrument request.')
    return instrumentLibrary.installGeneralUser(instrumentRoot(), (progress) => mainWindow?.webContents.send('instrument:progress', progress))
  })
  ipcMain.handle('instrument:install-webaudiofont', async (event, preset) => {
    if (!isTrusted(event) || !preset || typeof preset.id !== 'string' || typeof preset.name !== 'string') throw new Error('Invalid WebAudioFont request.')
    return instrumentLibrary.installWebAudioFont(instrumentRoot(), preset, (progress) => mainWindow?.webContents.send('instrument:progress', progress))
  })
  ipcMain.handle('instrument:import', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted instrument request.')
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Import instrument', properties: ['openFile'], filters: [{ name: 'Instruments', extensions: ['sf2', 'sf3', 'dls', 'sfz', 'wav', 'ogg', 'mp3', 'flac', 'm4a'] }] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, pack: await instrumentLibrary.importFile(instrumentRoot(), result.filePaths[0]) }
  })
  ipcMain.handle('instrument:resolve', async (event, id) => {
    if (!isTrusted(event) || typeof id !== 'string' || id.length > 300) throw new Error('Invalid instrument request.')
    return instrumentLibrary.resolveInstrument(instrumentRoot(), id)
  })
  ipcMain.handle('instrument:remove', async (event, id) => {
    if (!isTrusted(event) || typeof id !== 'string' || id.length > 120) throw new Error('Invalid instrument request.')
    return instrumentLibrary.removePack(instrumentRoot(), id)
  })
  ipcMain.handle('ace:state', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted ACE-Step request.')
    return aceStep.state(aceRoot())
  })
  ipcMain.handle('ace:install', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted ACE-Step request.')
    return aceStep.install(aceRoot(), (progress) => mainWindow?.webContents.send('ace:progress', progress))
  })
  ipcMain.handle('ace:start', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted ACE-Step request.')
    return aceStep.start(aceRoot(), (progress) => mainWindow?.webContents.send('ace:progress', progress))
  })
  ipcMain.handle('ace:stop', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted ACE-Step request.')
    return aceStep.stop()
  })
  ipcMain.handle('ace:generate', async (event, request) => {
    if (!isTrusted(event) || !request || typeof request.prompt !== 'string' || request.prompt.length > 2000 || String(request.lyrics || '').length > 6000) throw new Error('Invalid ACE-Step generation request.')
    return aceStep.generate(aceRoot(), request, (progress) => mainWindow?.webContents.send('ace:progress', progress))
  })
  ipcMain.handle('ace:remove', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted ACE-Step request.')
    return aceStep.remove(aceRoot())
  })
  ipcMain.handle('seed-vc:state', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted Seed-VC request.')
    return seedVc.state(seedVcRoot())
  })
  ipcMain.handle('seed-vc:install', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted Seed-VC request.')
    return seedVc.install(seedVcRoot(), (progress) => mainWindow?.webContents.send('seed-vc:progress', progress))
  })
  ipcMain.handle('seed-vc:choose-audio', async (event, role) => {
    if (!isTrusted(event) || !['source', 'reference'].includes(role)) throw new Error('Invalid Seed-VC audio request.')
    const result = await dialog.showOpenDialog(mainWindow, { title: role === 'source' ? 'Choose an isolated source vocal' : 'Choose a consented reference voice', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'flac', 'mp3', 'm4a', 'opus', 'ogg'] }] })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, path: result.filePaths[0], name: path.basename(result.filePaths[0]) }
  })
  ipcMain.handle('seed-vc:convert', async (event, request) => {
    if (!isTrusted(event) || !request || typeof request.sourcePath !== 'string' || typeof request.referencePath !== 'string') throw new Error('Invalid Seed-VC conversion request.')
    await aceStep.stop()
    let sourcePath = request.sourcePath
    if (sourcePath.startsWith('asset:')) {
      const id = sourcePath.slice(6)
      if (!/^[a-f0-9]{64}$/i.test(id)) throw new Error('Invalid source audio asset.')
      sourcePath = path.join(audioAssetRoot(), `${id}.wav`)
    }
    return seedVc.convert(seedVcRoot(), { ...request, sourcePath }, (progress) => mainWindow?.webContents.send('seed-vc:progress', progress))
  })
  ipcMain.handle('seed-vc:remove', async (event) => {
    if (!isTrusted(event)) throw new Error('Untrusted Seed-VC request.')
    return seedVc.remove(seedVcRoot())
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1024, minHeight: 680, backgroundColor: '#0d0f14', title: 'Resonant', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  mainWindow.setMenuBarVisibility(false)
  if (!smokeMode) mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url)) event.preventDefault()
  })
  if (process.env.VITE_DEV_SERVER_URL) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  const allowedMedia = (_webContents, permission) => permission === 'media'
  session.defaultSession.setPermissionCheckHandler(allowedMedia)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(allowedMedia(webContents, permission)))
  registerIpc()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { stopProjectWatcher(); void aceStep.stop() })
