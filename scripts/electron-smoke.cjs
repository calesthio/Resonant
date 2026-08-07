const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const evidence = path.join(root, '.agent', 'evidence')
const sourceAudio = process.env.RESONANT_SMOKE_AUDIO || path.join(evidence, 'agent-composition.wav')
const importedClipName = path.basename(sourceAudio, path.extname(sourceAudio))
const importedClipNameLiteral = JSON.stringify(importedClipName)
const savedProject = path.join(evidence, 'electron-smoke.resonant')
const exportedWav = path.join(evidence, 'electron-smoke.wav')
const reportPath = path.join(evidence, 'electron-smoke.json')
const screenshots = {
  instrumentLibrary: path.join(evidence, 'electron-instrument-library.png'),
  aceStepStudio: path.join(evidence, 'electron-ace-step-studio.png'),
  seedVcStudio: path.join(evidence, 'electron-seed-vc-studio.png'),
  songwriterStudio: path.join(evidence, 'electron-songwriter-studio.png'),
  mcpSetup: path.join(evidence, 'electron-mcp-setup.png'),
  flowAudio: path.join(evidence, 'electron-flow-audio.png'),
  arrangeMinimum: path.join(evidence, 'electron-arrange-minimum.png'),
  mixer: path.join(evidence, 'electron-mixer.png'),
}
const privatePathMarkersLiteral = JSON.stringify([os.homedir(), os.homedir().replaceAll('\\', '/'), 'C:\\Users\\', 'C:/Users/'])
const failures = []
let currentStage = 'startup'
const instrumentNetworkSmoke = process.env.RESONANT_SMOKE_INSTRUMENTS === '1'
const instrumentSmokeRoot = instrumentNetworkSmoke ? path.join(os.tmpdir(), `resonant-electron-instruments-${process.pid}`) : null
const aceSmokeRoot = path.join(os.tmpdir(), `resonant-electron-ace-${process.pid}`)
const seedVcSmokeRoot = path.join(os.tmpdir(), `resonant-electron-seed-vc-${process.pid}`)
const audioAssetSmokeRoot = path.join(os.tmpdir(), `resonant-electron-audio-assets-${process.pid}`)

process.env.RESONANT_SMOKE = '1'
if (instrumentSmokeRoot) process.env.RESONANT_INSTRUMENT_ROOT = instrumentSmokeRoot
process.env.RESONANT_ACE_ROOT = aceSmokeRoot
process.env.RESONANT_SEED_VC_ROOT = seedVcSmokeRoot
process.env.RESONANT_AUDIO_ASSET_ROOT = audioAssetSmokeRoot
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
process.on('uncaughtException', (error) => failures.push(`uncaught: ${error.stack || error.message}`))
process.on('unhandledRejection', (error) => failures.push(`unhandled: ${error instanceof Error ? error.stack || error.message : String(error)}`))

dialog.showOpenDialog = async (_window, options) => {
  if (options?.title === 'Import audio') return { canceled: false, filePaths: [sourceAudio] }
  if (options?.title === 'Open Resonant project') return { canceled: false, filePaths: [savedProject] }
  throw new Error(`Unexpected open dialog: ${options?.title || 'untitled'}`)
}
dialog.showSaveDialog = async (_window, options) => {
  if (options?.title === 'Save Resonant project') return { canceled: false, filePath: savedProject }
  if (options?.title === 'Export stereo WAV') return { canceled: false, filePath: exportedWav }
  throw new Error(`Unexpected save dialog: ${options?.title || 'untitled'}`)
}

require('../electron/main.cjs')

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function withTimeout(promise, label, milliseconds = 8000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

async function waitForWindow() {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed() && !window.webContents.isLoading()) return window
    await delay(50)
  }
  throw new Error('The Resonant window did not finish loading.')
}

async function evaluate(window, source, label, timeout = 8000) {
  currentStage = label
  try {
    return await withTimeout(window.webContents.executeJavaScript(source, true), label, timeout)
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    throw new Error(`${label} failed: ${detail}`)
  }
}

async function waitFor(window, expression, label, timeout = 10000, probeTimeout = 2000) {
  currentStage = label
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(window, `Boolean(${expression})`, label, probeTimeout)) return
    await delay(75)
  }
  throw new Error(`${label} did not become true.`)
}

async function capture(window, destination) {
  currentStage = `capture ${path.basename(destination)}`
  window.showInactive(); window.webContents.invalidate(); await delay(180)
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await fs.writeFile(destination, (await window.capturePage()).toPNG()); window.hide(); return } catch (error) { lastError = error; await delay(250) }
  }
  window.hide()
  throw lastError
}

async function run() {
  await fs.mkdir(evidence, { recursive: true })
  await fs.access(sourceAudio)
  const window = await waitForWindow()
  window.webContents.on('render-process-gone', (_event, details) => failures.push(`renderer gone: ${details.reason}`))
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') failures.push(`console: ${details.message}`)
  })
  await waitFor(window, `[...document.querySelectorAll('.ai-tool-button')].map((button) => button.textContent).join(' ').includes('AI SONG') && [...document.querySelectorAll('.ai-tool-button')].map((button) => button.textContent).join(' ').includes('MY VOICE') && [...document.querySelectorAll('.ai-tool-button')].every((button) => button.textContent.includes('INSTALL'))`, 'persistent AI tool discovery and install status')
  window.setSize(1080, 760)
  await delay(400)
  const narrowAiTools = await evaluate(window, `({ width: innerWidth, tools: [...document.querySelectorAll('.ai-tool-button')].map((button) => ({ text: button.textContent, left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })) })`, 'inspect narrow AI tool layout')
  if (narrowAiTools.tools.length !== 2 || narrowAiTools.tools.some((button) => button.left < 0 || button.right > narrowAiTools.width) || !narrowAiTools.tools.map((button) => button.text).join(' ').includes('AI SONG') || !narrowAiTools.tools.map((button) => button.text).join(' ').includes('MY VOICE')) throw new Error(`AI tool labels overflowed at narrow desktop width: ${JSON.stringify(narrowAiTools)}`)
  window.setSize(1480, 940)

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Install real instruments'));
    if (!button) throw new Error('First-run instrument library button missing'); button.click(); return true;
  })()`, 'open first-run instrument library')
  await waitFor(window, `document.querySelector('.instrument-library-modal')?.textContent.includes('GeneralUser GS') && document.querySelector('.instrument-library-modal')?.textContent.includes('WEBAUDIOFONT')`, 'instrument library modal')
  if (instrumentNetworkSmoke) {
    await evaluate(window, `(() => {
      const button = [...document.querySelectorAll('.instrument-library-modal button')].find((item) => item.textContent.trim() === 'SEARCH');
      if (!button) throw new Error('WebAudioFont search button missing'); button.click(); return true;
    })()`, 'search WebAudioFont catalog')
    await waitFor(window, `[...document.querySelectorAll('.catalog-list article')].some((item) => item.textContent.includes('Slow Violin'))`, 'WebAudioFont violin result', 20000)
    await evaluate(window, `(() => {
      const row = [...document.querySelectorAll('.catalog-list article')].find((item) => item.textContent.includes('Slow Violin'));
      const button = row?.querySelector('button'); if (!button) throw new Error('Slow Violin install button missing'); button.click(); return true;
    })()`, 'install WebAudioFont violin')
    await waitFor(window, `document.body.textContent.includes('installation completed.') && [...document.querySelectorAll('.installed-list article')].some((item) => item.textContent.includes('Slow Violin'))`, 'installed WebAudioFont violin', 30000)
  }
  await capture(window, screenshots.instrumentLibrary)
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.instrument-library-modal button')].find((item) => item.textContent.trim() === 'DONE');
    if (!button) throw new Error('Instrument library Done button missing'); button.click(); return true;
  })()`, 'close instrument library')
  await waitFor(window, `!document.querySelector('.instrument-library-modal')`, 'closed instrument library')
  await evaluate(window, `document.querySelector('button[aria-label="Open quick start"]').click(); true`, 'reopen quick start')
  await waitFor(window, `document.body.textContent.includes('Open starter groove')`, 'quick start reopened')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Optional: install local AI music'));
    if (!button) throw new Error('First-run ACE-Step button missing'); button.click(); return true;
  })()`, 'open first-run ACE-Step Studio')
  await waitFor(window, `document.querySelector('.ace-studio-modal')?.textContent.includes('INSTALL ACE-STEP 1.5') && document.querySelector('.ace-studio-modal')?.textContent.includes('Nothing is downloaded')`, 'ACE-Step optional install modal')
  await evaluate(window, `(() => {
    const root = document.querySelector('.ace-status-strip code');
    if (!root) throw new Error('ACE-Step storage path missing');
    root.textContent = 'C:/ResonantData/ai-generators/ace-step-1.5';
    root.title = root.textContent;
    const visible = root.closest('.ace-studio-modal')?.textContent || '';
    if (${privatePathMarkersLiteral}.some((marker) => visible.includes(marker))) throw new Error('Private home path remained in ACE-Step screenshot');
    return true;
  })()`, 'sanitize ACE-Step screenshot paths')
  await capture(window, screenshots.aceStepStudio)
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.ace-studio-modal button')].find((item) => item.textContent.trim() === 'DONE');
    if (!button) throw new Error('ACE-Step Studio Done button missing'); button.click(); return true;
  })()`, 'close ACE-Step Studio')
  await waitFor(window, `!document.querySelector('.ace-studio-modal')`, 'closed ACE-Step Studio')
  await evaluate(window, `document.querySelector('button[aria-label="Open quick start"]').click(); true`, 'reopen quick start after ACE-Step Studio')
  await waitFor(window, `document.body.textContent.includes('Open starter groove')`, 'quick start reopened after ACE-Step Studio')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Optional: install personal singing voices'));
    if (!button) throw new Error('First-run Seed-VC button missing'); button.click(); return true;
  })()`, 'open first-run Seed-VC Studio')
  await waitFor(window, `document.querySelector('.seed-vc-modal')?.textContent.includes('INSTALL SEED-VC') && document.querySelector('.seed-vc-modal')?.textContent.includes('I own this voice') === false`, 'Seed-VC optional install modal')
  await evaluate(window, `(() => {
    const root = document.querySelector('.seed-vc-modal .ace-status-strip code');
    if (!root) throw new Error('Seed-VC storage path missing');
    root.textContent = 'C:/ResonantData/voice-providers/seed-vc'; root.title = root.textContent;
    const visible = root.closest('.seed-vc-modal')?.textContent || '';
    if (${privatePathMarkersLiteral}.some((marker) => visible.includes(marker))) throw new Error('Private home path remained in Seed-VC screenshot');
    return true;
  })()`, 'sanitize Seed-VC screenshot paths')
  await capture(window, screenshots.seedVcStudio)
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.seed-vc-modal button')].find((item) => item.textContent.trim() === 'DONE');
    if (!button) throw new Error('Seed-VC Studio Done button missing'); button.click(); return true;
  })()`, 'close Seed-VC Studio')
  await waitFor(window, `!document.querySelector('.seed-vc-modal')`, 'closed Seed-VC Studio')
  await evaluate(window, `document.querySelector('button[aria-label="Open quick start"]').click(); true`, 'reopen quick start after Seed-VC Studio')
  await waitFor(window, `document.body.textContent.includes('Open starter groove')`, 'quick start reopened after Seed-VC Studio')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Develop lyrics in Songwriter Studio'));
    if (!button) throw new Error('First-run Songwriter Studio button missing'); button.click(); return true;
  })()`, 'open Songwriter Studio')
  await waitFor(window, `(() => { const select = document.querySelector('.songwriter-language select'); const values = [...(select?.options || [])].map((option) => option.value); return document.querySelector('.songwriter-modal')?.textContent.includes('STRUCTURE BLUEPRINTS') && ['en', 'hi', 'zh-CN', 'ko-KR', 'es-419', 'ja-JP'].every((id) => values.includes(id)); })()`, 'Songwriter Studio language-pack discovery')
  await evaluate(window, `(() => {
    const select = document.querySelector('.songwriter-language select');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setValue.call(select, 'zh-CN'); select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`, 'select Mandarin songwriting pack')
  await waitFor(window, `document.querySelector('.songwriter-modal')?.textContent.includes('Mandarin Chinese (Simplified)') && document.querySelector('.songwriter-structures')?.textContent.includes('当代华语流行')`, 'Mandarin songwriting structures')
  await evaluate(window, `(() => {
    const select = document.querySelector('.songwriter-language select');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setValue.call(select, 'ko-KR'); select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`, 'select Korean songwriting pack')
  await waitFor(window, `document.querySelector('.songwriter-modal')?.textContent.includes('Korean (K-pop)') && document.querySelector('.songwriter-structures')?.textContent.includes('퍼포먼스 K-pop')`, 'Korean songwriting structures')
  await evaluate(window, `(() => {
    const select = document.querySelector('.songwriter-language select');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setValue.call(select, 'es-419'); select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`, 'select Spanish songwriting pack')
  await waitFor(window, `document.querySelector('.songwriter-modal')?.textContent.includes('Spanish (Latin American)') && document.querySelector('.songwriter-structures')?.textContent.includes('Pop latino')`, 'Spanish songwriting structures')
  await evaluate(window, `(() => {
    const select = document.querySelector('.songwriter-language select');
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setValue.call(select, 'ja-JP'); select.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`, 'select Japanese songwriting pack')
  await waitFor(window, `document.querySelector('.songwriter-modal')?.textContent.includes('Japanese (J-pop)') && document.querySelector('.songwriter-structures')?.textContent.includes('王道J-pop')`, 'Japanese songwriting structures')
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.songwriter-tabs button')].find((item) => item.textContent.includes('LYRICS'));
    if (!button) throw new Error('Lyrics view button missing'); button.click(); return true;
  })()`, 'open lyrics craft view')
  await waitFor(window, `document.querySelector('textarea[aria-label="Song lyrics"]')?.placeholder.includes('[Aメロ 1]') && [...document.querySelectorAll('.section-tools button')].some((button) => button.textContent.includes('サビ')) && document.querySelector('.songwriter-coach')?.textContent.includes('CRAFT SIGNAL')`, 'Japanese lyrics craft view')
  await evaluate(window, `(() => {
    const textarea = document.querySelector('textarea[aria-label="Song lyrics"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, '[Aメロ 1]\\n終電あとのホームで待ってる\\n濡れた袖に通知がひとつ光る\\n\\n[サビ]\\nあと一分だけ\\nあと一分だけ\\n\\n[Cメロ]\\n私から先にさよならを言う');
    textarea.dispatchEvent(new Event('input', { bubbles: true })); return true;
  })()`, 'enter smoke lyrics')
  await waitFor(window, `document.querySelector('.lyrics-stats')?.textContent.includes('3 SECTIONS')`, 'analyzed smoke lyrics')
  await capture(window, screenshots.songwriterStudio)
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.songwriter-modal button')].find((item) => item.textContent.trim() === 'DONE');
    if (!button) throw new Error('Songwriter Studio Done button missing'); button.click(); return true;
  })()`, 'close Songwriter Studio')
  await waitFor(window, `!document.querySelector('.songwriter-modal')`, 'closed Songwriter Studio')
  await evaluate(window, `document.querySelector('button[aria-label="Open quick start"]').click(); true`, 'reopen quick start after Songwriter Studio')
  await waitFor(window, `document.body.textContent.includes('Open starter groove')`, 'quick start reopened after Songwriter Studio')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Connect Codex, Claude'));
    if (!button) throw new Error('First-run MCP setup button missing'); button.click(); return true;
  })()`, 'open MCP setup')
  await waitFor(window, `document.querySelector('.mcp-setup-modal')?.textContent.includes('MCP RUNTIME READY') && document.querySelector('.mcp-setup-modal pre')?.textContent.includes('ELECTRON_RUN_AS_NODE')`, 'MCP setup configuration')
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.mcp-setup-modal button')].find((item) => item.textContent.includes('COPY CONFIGURATION'));
    if (!button) throw new Error('MCP copy button missing'); button.click(); return true;
  })()`, 'copy MCP configuration')
  await waitFor(window, `document.body.textContent.includes('codex configuration copied.')`, 'copied MCP configuration')
  await evaluate(window, `(() => {
    const workspace = document.querySelector('.mcp-root code');
    const configuration = document.querySelector('.mcp-setup-modal pre code');
    if (!workspace || !configuration) throw new Error('MCP screenshot fields missing');
    workspace.textContent = 'C:/Music/ResonantProjects';
    configuration.textContent = '[mcp_servers.resonant]\\ncommand = "C:/Resonant/electron.exe"\\nargs = ["C:/Resonant/mcp-dist/server.mjs", "--root", "C:/Music/ResonantProjects"]\\nenv = { ELECTRON_RUN_AS_NODE = "1" }\\nstartup_timeout_sec = 20\\ntool_timeout_sec = 600';
    const visible = workspace.closest('.mcp-setup-modal')?.textContent || '';
    if (${privatePathMarkersLiteral}.some((marker) => visible.includes(marker))) throw new Error('Private home path remained in MCP screenshot');
    return true;
  })()`, 'sanitize MCP screenshot paths')
  await capture(window, screenshots.mcpSetup)
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.mcp-setup-modal button')].find((item) => item.textContent.trim() === 'DONE');
    if (!button) throw new Error('MCP setup Done button missing'); button.click(); return true;
  })()`, 'close MCP setup')
  await waitFor(window, `!document.querySelector('.mcp-setup-modal')`, 'closed MCP setup')
  await evaluate(window, `document.querySelector('button[aria-label="Open quick start"]').click(); true`, 'reopen quick start after MCP setup')
  await waitFor(window, `document.body.textContent.includes('Open starter groove')`, 'quick start reopened after MCP setup')

  await evaluate(window, `window.confirm = () => true; (() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Open starter groove'));
    if (!button) throw new Error('Starter groove button missing'); button.click(); return true;
  })()`, 'open starter groove')
  await waitFor(window, `document.body.textContent.includes('Starter groove loaded.')`, 'starter groove toast')
  if (instrumentNetworkSmoke) {
    await evaluate(window, `(() => {
      const track = [...document.querySelectorAll('.track-row')].find((item) => item.textContent.includes('Prism'));
      if (!track) throw new Error('Prism track missing'); track.click(); return true;
    })()`, 'select Prism for installed violin')
    await waitFor(window, `document.querySelector('.track-row.selected')?.textContent.includes('Prism')`, 'selected Prism for installed violin')
    await evaluate(window, `(() => {
      const select = [...document.querySelectorAll('.inspector select')].find((item) => [...item.options].some((option) => option.textContent.includes('Slow Violin')));
      const option = select && [...select.options].find((item) => item.textContent.includes('Slow Violin'));
      if (!select || !option) throw new Error('Installed violin is absent from Inspector');
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setValue.call(select, option.value); select.dispatchEvent(new Event('change', { bubbles: true })); return true;
    })()`, 'assign installed violin')
    await waitFor(window, `document.querySelector('.inspector select')?.value.includes('webaudiofont-')`, 'violin track assignment')
    await evaluate(window, `document.querySelector('.note-label')?.click(); true`, 'audition installed violin', 20000)
    await delay(1000)
    await evaluate(window, `(() => {
      const track = [...document.querySelectorAll('.track-row')].find((item) => item.textContent.includes('Pulse'));
      if (!track) throw new Error('Pulse track missing after violin audition'); track.click(); return true;
    })()`, 'restore Pulse selection after violin audition')
    await waitFor(window, `document.querySelector('.track-row.selected')?.textContent.includes('Pulse')`, 'restored Pulse selection')
  }

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('DUPLICATE'));
    if (!button) throw new Error('Duplicate clip button missing'); button.click(); return true;
  })()`, 'duplicate MIDI clip')
  await waitFor(window, `document.body.textContent.includes('Pulse A copy')`, 'MIDI clip duplicate')
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'CLEAR');
    if (!button) throw new Error('Clear clip button missing'); button.click(); return true;
  })()`, 'clear MIDI clip')
  await waitFor(window, `document.querySelector('.property-grid')?.textContent.includes('EVENTS0')`, 'cleared MIDI clip')
  await evaluate(window, `document.querySelector('button[aria-label="Undo"]').click(); true`, 'undo MIDI clear')
  await waitFor(window, `document.querySelector('.property-grid')?.textContent.includes('EVENTS4')`, 'undo restored MIDI notes')
  await evaluate(window, `document.querySelector('button[aria-label="Redo"]').click(); true`, 'redo MIDI clear')
  await waitFor(window, `document.querySelector('.property-grid')?.textContent.includes('EVENTS0')`, 'redo cleared MIDI notes')
  await evaluate(window, `document.querySelector('button[aria-label="Undo"]').click(); true`, 'restore MIDI notes for the mix')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.track-row')].find((item) => item.textContent.includes('Audio'));
    if (!button) throw new Error('Audio track button missing'); button.click(); return true;
  })()`, 'select Audio track')
  await waitFor(window, `document.querySelector('.inspector')?.textContent.includes('IMPORT AUDIO FILE')`, 'Audio inspector')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('IMPORT AUDIO FILE'));
    if (!button) throw new Error('Import audio button missing'); button.click(); return true;
  })()`, 'import OpenMontage WAV')
  await waitFor(window, `document.body.textContent.includes(${importedClipNameLiteral} + ' is ready in Flow.') || document.querySelector('.audio-editor')`, 'decoded audio clip', 15000)

  await evaluate(window, `(() => {
    const arm = [...document.querySelectorAll('.inspector button')].find((item) => item.textContent.trim() === 'ARM');
    if (!arm) throw new Error('Audio arm button missing'); arm.click(); return true;
  })()`, 'arm fake-input recording')
  await waitFor(window, `document.querySelector('.inspector')?.textContent.includes('ARMED')`, 'armed audio track')
  await evaluate(window, `document.querySelector('button[aria-label="Record"]').click(); true`, 'start fake-input recording')
  await waitFor(window, `document.querySelector('.app.is-recording')`, 'recording state')
  await delay(600)
  await evaluate(window, `document.querySelector('button[aria-label="Stop recording"]').click(); true`, 'stop fake-input recording')
  await waitFor(window, `[...document.querySelectorAll('.clip-cell')].some((item) => item.textContent.includes('Recording') && item.textContent.includes('audio'))`, 'recorded audio clip', 15000)
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.clip-cell')].find((item) => item.textContent.includes(${importedClipNameLiteral}));
    if (!button) throw new Error('Imported OpenMontage clip missing'); button.click(); return true;
  })()`, 'relaunch imported OpenMontage clip')
  await waitFor(window, `document.querySelector('.track-row.selected')?.textContent.includes(${importedClipNameLiteral}) && [...document.querySelectorAll('.clip-cell.active')].some((item) => item.textContent.includes(${importedClipNameLiteral}))`, 'active OpenMontage clip')
  await capture(window, screenshots.flowAudio)

  await evaluate(window, `(() => {
    const button = document.querySelector('button[aria-label="Play"]'); if (!button) throw new Error('Play button missing'); button.click(); return true;
  })()`, 'start session transport')
  await waitFor(window, `document.querySelector('button[aria-label="Pause"]')`, 'session playback')
  await delay(350)
  await evaluate(window, `document.querySelector('button[aria-label="Pause"]').click(); true`, 'pause session transport')

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.workspace-tabs > button')].find((item) => item.textContent.includes('ARRANGE'));
    if (!button) throw new Error('Arrange button missing'); button.click(); return true;
  })()`, 'open Arrange')
  await waitFor(window, `document.querySelectorAll('.arrangement-block').length >= 4`, 'starter arrangement')
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('CAPTURE SESSION'));
    if (!button) throw new Error('Capture Session button missing'); button.click(); return true;
  })()`, 'capture session')
  await waitFor(window, `document.querySelectorAll('.arrangement-block').length >= 9`, 'captured arrangement')
  await evaluate(window, `(() => {
    const block = document.querySelector('.arrangement-block'); if (!block) throw new Error('Arrangement block missing'); block.click(); return true;
  })()`, 'select arrangement block')
  await waitFor(window, `!document.querySelector('button[title="Duplicate block"]')?.disabled`, 'arrangement block selection')
  await evaluate(window, `document.querySelector('button[title="Duplicate block"]').click(); true`, 'duplicate arrangement block')
  await waitFor(window, `document.querySelectorAll('.arrangement-block').length >= 10`, 'duplicated arrangement block')
  await evaluate(window, `document.querySelector('button[title="Move one beat right"]').click(); document.querySelector('button[title="Shorten one beat"]').click(); true`, 'move and resize arrangement block')
  await evaluate(window, `document.querySelector('button[title="Delete block"]').click(); true`, 'delete arrangement block')
  await waitFor(window, `document.querySelectorAll('.arrangement-block').length === 9`, 'deleted arrangement block')
  window.setSize(1024, 680); await delay(150)
  await capture(window, screenshots.arrangeMinimum)
  window.setSize(1480, 940); await delay(150)

  await evaluate(window, `(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const tempo = document.querySelector('input[aria-label="Tempo"]'); setValue.call(tempo, '300'); tempo.dispatchEvent(new Event('input', { bubbles: true }));
    const loopEnd = document.querySelector('input[aria-label="Loop end beat"]'); setValue.call(loopEnd, '1'); loopEnd.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, 'configure accelerated loop test')
  await waitFor(window, `document.querySelector('input[aria-label="Tempo"]')?.value === '300' && document.querySelector('input[aria-label="Loop end beat"]')?.value === '1'`, 'accelerated loop settings')
  await evaluate(window, `(() => {
    const song = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'SONG'); song.click(); return true;
  })()`, 'select Song mode')
  await waitFor(window, `[...document.querySelectorAll('button')].some((item) => item.textContent.trim() === 'SONG' && item.classList.contains('active'))`, 'Song mode state')
  await evaluate(window, `document.querySelector('button[aria-label="Play"]').click(); true`, 'start accelerated loop test')
  await delay(1500)
  await evaluate(window, `document.querySelector('button[aria-label="Pause"]').click(); document.body.textContent.includes('Transport stopped') || true`, 'renderer responsiveness after loop boundary', 3000)

  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.workspace-tabs > button')].find((item) => item.textContent.includes('MIX'));
    if (!button) throw new Error('Mix button missing'); button.click(); return true;
  })()`, 'open Mix')
  await waitFor(window, `document.querySelectorAll('.channel-strip').length === 6`, 'mixer channels')
  await capture(window, screenshots.mixer)
  await evaluate(window, `(() => {
    const mute = document.querySelector('.channel-strip button'); if (!mute) throw new Error('Mixer mute missing'); mute.click(); return mute.getAttribute('aria-pressed') === 'true';
  })()`, 'toggle mixer mute')
  await waitFor(window, `document.querySelector('.channel-strip')?.querySelector('button[aria-pressed="true"]')`, 'mixer mute state')
  await evaluate(window, `document.querySelector('button[aria-label="Undo"]').click(); true`, 'undo mixer mute')
  await waitFor(window, `!document.querySelector('.channel-strip')?.querySelector('button[aria-pressed="true"]')`, 'undo mixer mute state')
  await evaluate(window, `document.querySelector('button[aria-label="Redo"]').click(); true`, 'redo mixer mute')
  await waitFor(window, `document.querySelector('.channel-strip')?.querySelector('button[aria-pressed="true"]')`, 'redo mixer mute state')

  await delay(2000)
  const recoveryWritten = await evaluate(window, `(async () => Boolean(await window.resonantDesktop.readRecovery()))()`, 'read autosave recovery')
  if (!recoveryWritten) throw new Error('Autosave recovery was not written for the dirty project.')

  await evaluate(window, `document.querySelector('button[aria-label="Save project"]').click(); true`, 'save project')
  await waitFor(window, `document.body.textContent.includes('Project saved.')`, 'project save')
  const recoveryCleared = await evaluate(window, `(async () => (await window.resonantDesktop.readRecovery()) === null)()`, 'verify cleared recovery')
  if (!recoveryCleared) throw new Error('Saving did not clear autosave recovery.')
  await evaluate(window, `document.querySelector('button[aria-label="New project"]').click(); true`, 'create blank project after save')
  await waitFor(window, `document.body.textContent.includes('Blank project ready.') && document.querySelectorAll('.arrangement-block').length === 0`, 'blank project reset')
  await evaluate(window, `document.querySelector('button[aria-label="Open project"]').click(); true`, 'reopen saved project')
  await waitFor(window, `document.body.textContent.includes('Project opened.')`, 'saved project reopened')
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.workspace-tabs > button')].find((item) => item.textContent.includes('ARRANGE'));
    if (!button) throw new Error('Arrange button missing after reopen'); button.click(); return true;
  })()`, 'inspect reopened arrangement')
  await waitFor(window, `document.querySelectorAll('.arrangement-block').length === 9`, 'reopened arrangement contents')
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('EXPORT WAV'));
    if (!button) throw new Error('Export button missing'); button.click(); return true;
  })()`, 'export WAV', instrumentNetworkSmoke ? 30000 : 8000)
  await waitFor(window, `document.body.textContent.includes('WAV exported in')`, 'WAV export', 30000, 20000)

  await fs.access(savedProject); await fs.access(exportedWav)
  const [projectInfo, wavInfo, savedProjectText] = await Promise.all([fs.stat(savedProject), fs.stat(exportedWav), fs.readFile(savedProject, 'utf8')])
  const savedProjectJson = JSON.parse(savedProjectText)
  const savedAudioClip = Object.values(savedProjectJson.clips || {}).find((clip) => clip?.type === 'audio')
  if (!savedAudioClip?.asset?.sha256 || savedAudioClip.pcmBase64) {
    throw new Error('Saved desktop project did not use a shared, content-addressed audio asset.')
  }
  const summary = await evaluate(window, `({
    tracks: document.querySelectorAll('.track-row').length,
    mixerChannels: document.querySelectorAll('.channel-strip').length,
    status: document.querySelector('.statusbar')?.textContent || '',
  })`, 'collect UI summary')
  if (failures.length) throw new Error(failures.join('\n'))
  const report = { ok: true, sourceAudio, savedProject, exportedWav, screenshots, projectBytes: projectInfo.size, wavBytes: wavInfo.size, audioAsset: savedAudioClip.asset, summary }
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  if (instrumentSmokeRoot) await fs.rm(instrumentSmokeRoot, { recursive: true, force: true })
  await fs.rm(aceSmokeRoot, { recursive: true, force: true })
  await fs.rm(seedVcSmokeRoot, { recursive: true, force: true })
  await fs.rm(audioAssetSmokeRoot, { recursive: true, force: true })
  process.stdout.write(JSON.stringify(report))
}

app.whenReady().then(() => run()).then(() => app.quit()).catch(async (error) => {
  const report = { ok: false, sourceAudio, stage: currentStage, error: error.stack || error.message, failures }
  await fs.mkdir(evidence, { recursive: true }).catch(() => undefined)
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2)).catch(() => undefined)
  await fs.rm(audioAssetSmokeRoot, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(seedVcSmokeRoot, { recursive: true, force: true }).catch(() => undefined)
  process.stderr.write(`${JSON.stringify(report)}\n`)
  app.exit(1)
})
