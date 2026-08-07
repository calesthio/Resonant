const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const SEED_VC_REVISION = '51383efd921027683c89e5348211d93ff12ac2a8'
const SOURCE_URL = `https://codeload.github.com/Plachtaa/seed-vc/zip/${SEED_VC_REVISION}`
const UV_URL = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
const PYTORCH_INDEX = 'https://download.pytorch.org/whl/cu124'
const AUDIO_EXTENSIONS = new Set(['.wav', '.flac', '.mp3', '.m4a', '.opus', '.ogg'])

function libraryRoot(app) {
  return process.env.RESONANT_SEED_VC_ROOT || path.join(app.getPath('userData'), 'voice-providers', 'seed-vc')
}

function paths(root) {
  const runtime = path.join(root, 'runtime')
  return {
    root, runtime, outputs: path.join(root, 'outputs'), downloads: path.join(root, 'downloads'), tools: path.join(root, 'tools'),
    uv: path.join(root, 'tools', 'uv.exe'), python: path.join(runtime, '.venv', 'Scripts', 'python.exe'), manifest: path.join(root, 'manifest.json'), managedRequirements: path.join(root, 'managed-requirements.txt'),
  }
}

async function exists(target) { try { await fs.access(target); return true } catch { return false } }
function stripAnsi(value) { return String(value).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -\/]*[@-~])/g, '') }

async function directoryBytes(directory) {
  let total = 0
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      total += entry.isDirectory() ? await directoryBytes(target) : entry.isFile() ? (await fs.stat(target)).size : 0
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return total
}

function run(executable, args, options = {}, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, ...options })
    let stdout = '', stderr = '', pending = ''
    const receive = (chunk, isError = false) => {
      const value = stripAnsi(chunk.toString()); if (isError) stderr += value; else stdout += value; pending += value
      const lines = pending.split(/\r?\n|\r/); pending = lines.pop() || ''
      for (const line of lines) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout?.on('data', (chunk) => receive(chunk)); child.stderr?.on('data', (chunk) => receive(chunk, true))
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `${path.basename(executable)} exited with ${code}`).trim().slice(-4000))))
  })
}

async function download(url, target, progress, label) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${label} download failed (${response.status}).`)
  const total = Number(response.headers.get('content-length')) || 0
  const temporary = `${target}.download-${process.pid}`
  const handle = await fs.open(temporary, 'w'); let received = 0
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk); await handle.write(buffer); received += buffer.length
      progress?.({ phase: 'download', label, received, total })
    }
  } finally { await handle.close() }
  await fs.rename(temporary, target)
}

async function expandArchive(archive, destination) {
  await fs.mkdir(destination, { recursive: true })
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:RESONANT_ARCHIVE -DestinationPath $env:RESONANT_DESTINATION -Force'], { env: { ...process.env, RESONANT_ARCHIVE: archive, RESONANT_DESTINATION: destination } })
}

async function gpuInfo() {
  try {
    const { stdout } = await run('nvidia-smi.exe', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])
    const [name, memory, driver] = stdout.trim().split(/\r?\n/)[0].split(',').map((value) => value.trim())
    const vramMb = Number(memory) || 0
    return { backend: 'cuda', name, vramMb, driver, adequate: vramMb >= 6144, recommended: vramMb >= 8192 }
  } catch {
    return { backend: process.platform === 'darwin' ? 'mps' : 'cpu', name: process.platform === 'darwin' ? 'Apple Silicon / unified memory' : 'No NVIDIA GPU detected', vramMb: null, driver: null, adequate: process.platform === 'darwin', recommended: false }
  }
}

async function readManifest(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

async function aceStepIsRunning() { try { return (await fetch('http://127.0.0.1:8001/health', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }

async function state(root) {
  const location = paths(root), manifest = await readManifest(location.manifest)
  const installed = manifest?.revision === SEED_VC_REVISION && await exists(path.join(location.runtime, 'inference.py')) && await exists(location.python)
  return {
    root, revision: manifest?.revision || SEED_VC_REVISION, installed, bytes: await directoryBytes(root), outputs: await fs.readdir(location.outputs).catch(() => []),
    hardware: await gpuInfo(), profile: { model: 'seed-uvit-whisper-base', sampleRate: 44100, fp16: true, minimumVramGb: 6, recommendedVramGb: 8 },
  }
}

function managedRequirements(source) {
  const excluded = new Set(['torch', 'torchvision', 'torchaudio', 'funasr', 'modelscope', 'gradio', 'resemblyzer', 'jiwer', 'freesimplegui', 'sounddevice', 'python-dotenv'])
  return `${String(source).split(/\r?\n/).filter((line) => {
    const name = line.trim().match(/^([a-z0-9_.-]+)/i)?.[1]?.toLowerCase()
    return !name || !excluded.has(name)
  }).join('\n').trim()}\n`
}

async function install(root, progress) {
  if (process.platform !== 'win32') throw new Error('The managed Seed-VC installer currently supports Windows. macOS users can connect a manually installed runtime in a future release.')
  const location = paths(root)
  await Promise.all([location.root, location.outputs, location.downloads, location.tools].map((directory) => fs.mkdir(directory, { recursive: true })))
  if (!await exists(location.uv)) {
    progress?.({ phase: 'setup', label: 'Downloading the private Python runtime manager', received: 0, total: 0 })
    const archive = path.join(location.downloads, 'uv.zip'); if (!await exists(archive)) await download(UV_URL, archive, progress, 'Runtime manager')
    const extracted = path.join(location.downloads, 'uv-extracted'); await fs.rm(extracted, { recursive: true, force: true }); await expandArchive(archive, extracted)
    const candidate = (await fs.readdir(extracted, { recursive: true })).find((item) => path.basename(item).toLowerCase() === 'uv.exe')
    if (!candidate) throw new Error('The runtime-manager archive did not contain uv.exe.')
    await fs.copyFile(path.join(extracted, candidate), location.uv)
  }
  if (!await exists(path.join(location.runtime, 'inference.py'))) {
    progress?.({ phase: 'setup', label: 'Downloading the pinned Seed-VC source', received: 0, total: 0 })
    const archive = path.join(location.downloads, `seed-vc-${SEED_VC_REVISION.slice(0, 12)}.zip`)
    if (!await exists(archive)) await download(SOURCE_URL, archive, progress, 'Seed-VC source')
    const staging = path.join(location.downloads, `source-${Date.now()}`); await expandArchive(archive, staging)
    const top = (await fs.readdir(staging, { withFileTypes: true })).find((entry) => entry.isDirectory())
    if (!top) throw new Error('The Seed-VC archive did not contain a source directory.')
    await fs.rm(location.runtime, { recursive: true, force: true }); await fs.rename(path.join(staging, top.name), location.runtime); await fs.rm(staging, { recursive: true, force: true })
  }
  if (!await exists(location.python)) {
    progress?.({ phase: 'setup', label: 'Creating an isolated Python 3.10 environment', received: 0, total: 0 })
    await run(location.uv, ['venv', '--python', '3.10', '.venv'], { cwd: location.runtime, env: { ...process.env, UV_CACHE_DIR: path.join(root, 'cache', 'uv') } }, (line) => progress?.({ phase: 'setup', label: line.slice(0, 140), received: 0, total: 0 }))
  }
  const dependencyEnvironment = { ...process.env, UV_CACHE_DIR: path.join(root, 'cache', 'uv'), UV_NO_PROGRESS: '1', NO_COLOR: '1' }
  const quietFlags = ['--no-progress', '--color', 'never']
  progress?.({ phase: 'model', label: 'Installing PyTorch 2.4 with CUDA 12.4 support', received: 0, total: 0 })
  try {
    await run(location.uv, ['pip', 'install', '--python', location.python, 'torch==2.4.0+cu124', 'torchvision==0.19.0+cu124', 'torchaudio==2.4.0+cu124', '--index-url', PYTORCH_INDEX, '--extra-index-url', 'https://pypi.org/simple', '--index-strategy', 'unsafe-best-match', ...quietFlags], { cwd: location.runtime, env: dependencyEnvironment }, (line) => progress?.({ phase: 'model', label: line.slice(0, 140), received: 0, total: 0 }))
    const upstreamRequirements = await fs.readFile(path.join(location.runtime, 'requirements.txt'), 'utf8')
    await fs.writeFile(location.managedRequirements, managedRequirements(upstreamRequirements), 'utf8')
    progress?.({ phase: 'model', label: 'Installing Seed-VC audio and model dependencies', received: 0, total: 0 })
    await run(location.uv, ['pip', 'install', '--python', location.python, '-r', location.managedRequirements, ...quietFlags], { cwd: location.runtime, env: dependencyEnvironment }, (line) => progress?.({ phase: 'model', label: line.slice(0, 140), received: 0, total: 0 }))
    await run(location.python, ['-c', "import torch; assert torch.version.cuda, 'The installed PyTorch build has no CUDA runtime'; print(torch.__version__)"], { cwd: location.runtime, env: dependencyEnvironment })
  } catch (error) {
    throw new Error(`Seed-VC dependency setup failed. Retry Install to resume from the package cache. ${error instanceof Error ? error.message : String(error)}`)
  }
  await fs.writeFile(location.manifest, `${JSON.stringify({ revision: SEED_VC_REVISION, source: SOURCE_URL, installedAt: new Date().toISOString(), license: 'GPL-3.0', pytorch: '2.4.0+cu124', dependencyProfile: 'resonant-singing-inference' }, null, 2)}\n`)
  progress?.({ phase: 'setup', label: 'Cleaning the temporary package cache', received: 0, total: 0 })
  await run(location.uv, ['cache', 'clean'], { cwd: location.runtime, env: dependencyEnvironment }).catch(() => undefined)
  progress?.({ phase: 'ready', label: 'Seed-VC is installed; model weights download on first conversion', received: 1, total: 1 })
  return state(root)
}

function assertAudioPath(value, label) {
  const resolved = path.resolve(String(value || ''))
  if (!AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) throw new Error(`${label} must be WAV, FLAC, MP3, M4A, OPUS, or OGG audio.`)
  return resolved
}

async function convert(root, request, progress) {
  if (request?.voiceRightsConfirmed !== true) throw new Error('Confirm that you own the reference voice or have explicit permission to use it.')
  if (await aceStepIsRunning()) throw new Error('ACE-Step is still using GPU memory. Stop the external ACE-Step service before starting Seed-VC conversion.')
  const location = paths(root)
  if (!await exists(location.python) || !await exists(path.join(location.runtime, 'inference.py'))) throw new Error('Install Seed-VC before converting vocals.')
  const source = assertAudioPath(request.sourcePath, 'Source vocal'), reference = assertAudioPath(request.referencePath, 'Reference voice')
  if (!await exists(source)) throw new Error('The source vocal file no longer exists.')
  if (!await exists(reference)) throw new Error('The reference voice file no longer exists.')
  const steps = Math.max(4, Math.min(100, Math.trunc(Number(request.diffusionSteps) || 30)))
  const semitoneShift = Math.max(-24, Math.min(24, Math.trunc(Number(request.semitoneShift) || 0)))
  const cfg = Math.max(0, Math.min(1, Number(request.inferenceCfgRate) || 0.7))
  const lengthAdjust = Math.max(0.5, Math.min(2, Number(request.lengthAdjust) || 1))
  const jobDirectory = path.join(location.outputs, `conversion-${Date.now()}`); await fs.mkdir(jobDirectory, { recursive: true })
  progress?.({ phase: 'convert', label: 'Loading Seed-VC and converting the vocal', received: 0, total: 100 })
  await run(location.python, ['inference.py', '--source', source, '--target', reference, '--output', jobDirectory, '--diffusion-steps', String(steps), '--length-adjust', String(lengthAdjust), '--inference-cfg-rate', String(cfg), '--f0-condition', 'True', '--auto-f0-adjust', 'False', '--semi-tone-shift', String(semitoneShift), '--fp16', 'True'], {
    cwd: location.runtime, env: { ...process.env, HF_HOME: path.join(root, 'cache', 'huggingface'), HF_HUB_DISABLE_XET: '1', PYTHONUTF8: '1' },
  }, (line) => progress?.({ phase: 'convert', label: line.slice(0, 140), received: 50, total: 100 }))
  const candidates = (await fs.readdir(jobDirectory)).filter((name) => name.toLowerCase().endsWith('.wav'))
  if (!candidates.length) throw new Error('Seed-VC completed without producing a WAV file.')
  const ranked = await Promise.all(candidates.map(async (name) => ({ name, modified: (await fs.stat(path.join(jobDirectory, name))).mtimeMs })))
  ranked.sort((a, b) => b.modified - a.modified)
  const outputPath = path.join(jobDirectory, ranked[0].name), data = await fs.readFile(outputPath)
  const [sourceHash, referenceHash] = await Promise.all([source, reference].map(async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex')))
  const provenance = { provider: 'Seed-VC', revision: SEED_VC_REVISION, source: { name: path.basename(source), sha256: sourceHash }, reference: { name: path.basename(reference), sha256: referenceHash }, voiceRightsConfirmed: true, confirmedAt: new Date().toISOString(), diffusionSteps: steps, semitoneShift, inferenceCfgRate: cfg, lengthAdjust }
  await fs.writeFile(`${outputPath}.provenance.json`, `${JSON.stringify(provenance, null, 2)}\n`)
  progress?.({ phase: 'ready', label: 'The converted singing voice is ready', received: 100, total: 100 })
  return { path: outputPath, name: `${path.basename(source, path.extname(source))} — Seed-VC`, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), provenance }
}

async function remove(root) {
  const resolved = path.resolve(root)
  if (!resolved.toLowerCase().endsWith(path.join('voice-providers', 'seed-vc').toLowerCase()) && !process.env.RESONANT_SEED_VC_ROOT) throw new Error('Refusing to remove an unexpected Seed-VC directory.')
  await fs.rm(resolved, { recursive: true, force: true }); return true
}

module.exports = { SEED_VC_REVISION, SOURCE_URL, libraryRoot, paths, gpuInfo, state, stripAnsi, managedRequirements, install, convert, remove }
