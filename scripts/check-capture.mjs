/** Source-only assertions: no build artifacts, live device, browser or plugin injection. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = realpathSync(join(root, 'node_modules', '.bin', 'tsc'))
const ts = createRequire(pathToFileURL(tsc))('typescript')
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'dap-capture-check-')))
const atom = type => { const b = Buffer.alloc(8); b.writeUInt32BE(8); b.write(type, 4); return b }
const mp4 = Buffer.concat(['ftyp', 'mdat', 'moov'].map(atom))
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(24)])
png.writeUInt32BE(1280,16);png.writeUInt32BE(2772,20)
let server
try {
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}')
  for (const name of ['state', 'adb', 'flag-secure', 'scrcpy-host', 'pane-service', 'routes']) {
    const source = readFileSync(join(root, 'src', name + '.ts'), 'utf8')
    writeFileSync(join(temp, name + '.js'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText)
  }
  const { PaneStateStore, validateCaptureDirectory } = await import(pathToFileURL(join(temp, 'state.js')).href)
  const { PaneHub } = await import(pathToFileURL(join(temp, 'pane-service.js')).href)
  const { mountPaneRoutes, ROUTE_PREFIX } = await import(pathToFileURL(join(temp, 'routes.js')).href)
  const corrupt = join(temp, 'corrupt'); mkdirSync(corrupt)
  writeFileSync(join(corrupt, 'state.json'), 'null')
  assert.throws(() => PaneStateStore.open(corrupt), /状态文件损坏/)
  const home = join(temp, 'home'), first = join(temp, 'first'), second = join(temp, 'second')
  for (const dir of [home, first, second]) mkdirSync(dir)
  writeFileSync(join(home, 'state.json'), JSON.stringify({ trustedDevices: ['device'], quality: { maxFps: 22 } }))
  const state = PaneStateStore.open(home)
  assert.equal(state.data.quality.maxFps, 22)
  assert.deepEqual(state.data.trustedDevices, ['device'])
  assert.equal(state.data.directory, join(home, 'shots'))
  assert.throws(() => validateCaptureDirectory('relative'), /绝对路径/)
  assert.throws(() => state.setDirectory(join(temp, 'missing')))
  state.setDirectory(first)
  assert.equal(PaneStateStore.open(home).data.directory, first)
  const savedState = join(home, 'state.json')
  renameSync(savedState, savedState + '.backup'); mkdirSync(savedState)
  assert.throws(() => state.setDirectory(second), /状态写入失败/)
  assert.equal(state.data.directory, first)
  rmSync(savedState, { recursive: true }); renameSync(savedState + '.backup', savedState)

  let volume = 6, badReadback = false, failPull = false, corruptVideo = false, emptySecondSegment = false
  const removed = [], messages = []
  const adb = {
    path: 'unused', devices: async () => [{ serial: 'device', state: 'device', isEmulator: true }],
    screencap: async () => png,
    runOk: async args => {
      if (args[2] === 'pull') {
        if (failPull) throw new Error('injected pull failure')
        writeFileSync(args[4], args[3].endsWith('.mp4') ? (emptySecondSegment && args[3].endsWith('_1.mp4') ? Buffer.alloc(0) : corruptVideo ? atom('ftyp') : mp4) : '1730000000.000 100 101 E Test: error\n')
        return 'pulled'
      }
      const set = args.indexOf('--set')
      if (set >= 0) { volume = Number(args[set + 1]); return '' }
      if (args.includes('--get')) return 'volume is ' + (badReadback ? 9 : volume)
      return ''
    },
    run: async args => { if (args.includes('rm')) removed.push(args); return { code: 0, stdout: '', stderr: '' } },
  }
  const hub = new PaneHub(adb, state, { shotsDir: join(home, 'shots'), jarPath: '', log: msg => messages.push(msg), flagSecureCheck: false })
  hub.checkSecure = async () => ({ secure: false })
  const nativeCommands=[]
  hub.spawnCapture = (_serial, command) => {
    nativeCommands.push(command)
    const proc = new EventEmitter()
    proc.kill = () => assert.fail('SIGKILL must not finalize captures')
    let close
    hub.captureProcesses.set(proc, { ready: Promise.resolve('123'), closed: new Promise(yes => { close = yes }), stderr: '', done: false, close })
    return proc
  }
  hub.captureReady = async () => {}
  hub.stopCaptureProcess = async (_serial, proc) => {
    const info = hub.captureProcesses.get(proc)
    if (info.done) return
    info.done = true; info.close(0); proc.emit('close', 0)
  }
  await hub.capturePanel('device', 'mute')
  assert.equal(volume, 0); assert.equal(hub.captureState().muted.device, true)
  await hub.capturePanel('device', 'mute')
  assert.equal(volume, 6); assert.equal(hub.captureState().muted.device, undefined)
  volume = 0
  await hub.capturePanel('device', 'mute'); await hub.capturePanel('device', 'mute')
  assert.equal(volume, 0)
  badReadback = true
  await assert.rejects(hub.capturePanel('device', 'mute'), /回读/)
  assert.equal(hub.captureState().muted.device, undefined)
  badReadback = false

  hub.checkSecure = async () => ({ secure: true, captureVisible: false })
  await assert.rejects(hub.saveScreenshot('device'), /受保护/)
  await assert.rejects(hub.record('device', 'start'), /受保护/)
  hub.checkSecure = async () => ({ secure: true, captureVisible: true })
  await hub.saveScreenshot('device') // A genuinely visible screenshot is allowed.
  hub.checkSecure = async () => ({ secure: false })
  await hub.record('device', 'start')
  assert.match(nativeCommands.at(-1), /screenrecord --size 592x1280 --bit-rate 8000000 --time-limit 180/ )
  await assert.rejects(hub.debugStart('device', 'human'), /已有采集/)
  assert.throws(() => hub.setCaptureDirectory(second), /不能修改/)
  await assert.rejects(hub.setQuality({maxFps:60}), /不能重建/)
  const shot = await hub.saveScreenshot('device')
  assert.equal(dirname(shot), first)
  failPull = true
  await assert.rejects(hub.record('device', 'stop'), /pull failure/)
  assert.equal(hub.captureState().record.status, 'pending-save')
  assert.equal(removed.length, 0)
  hub.setCaptureDirectory(second)
  corruptVideo = true; failPull = false
  await assert.rejects(hub.record('device', 'stop'), /未完成封装/)
  assert.equal(removed.length, 0)
  corruptVideo = false
  const record = await hub.record('device', 'stop')
  assert.equal(dirname(record.file), second)
  assert.equal(hub.captureState().record, null)

  await hub.record('device', 'start')
  const auto = hub.records.get('device'), autoInfo = hub.captureProcesses.get(auto.proc)
  autoInfo.done = true; autoInfo.close(0); auto.proc.emit('close', 0)
  await auto.saving
  assert.equal(hub.captureState().record, null) // Native 180s completion automatically saves.

  const { id } = await hub.debugStart('device', 'human')
  await assert.rejects(hub.record('device', 'start'), /调试/)
  const debug = hub.debugSessions.get(id)
  debug.acts.push({ t: Date.now(), action: 'tap', detail: '1,2' })
  const firstSegment = debug.recordProc, info = hub.captureProcesses.get(firstSegment)
  debug.segments[0].startEpoch = Date.now() - 171000
  info.done = true; info.close(0); firstSegment.emit('close', 0)
  assert.equal(debug.segments.length, 2) // Native finalization rotates immediately with bounded encoder dimensions.
  failPull = true
  const removedBefore = removed.length
  await assert.rejects(hub.debugStop('device'), /pull failure/)
  assert.equal(hub.captureState().debug.status, 'pending-save')
  assert.equal(hub.debugStatus('device').active, false)
  assert.equal(removed.length, removedBefore)
  await assert.rejects(hub.debugAnalyze(id), /先重试保存/)
  hub.setCaptureDirectory(first); failPull = false
  await hub.debugStop('device')
  const output = hub.captureState().outputs.find(o => o.id === id)
  assert.equal(output.files.length, 4)
  assert(output.files.every(file => dirname(file) === first && file.includes(id)))
  assert.equal(JSON.parse(readFileSync(output.files.at(-1), 'utf8')).actions[0].action, 'tap')
  assert.equal(hub.captureState().debug, null)
  const partial=await hub.debugStart('device','human')
  const partialSession=hub.debugSessions.get(partial.id)
  partialSession.captureError='Encoder failed: second segment'
  partialSession.segments.push({remote:'/data/local/tmp/dsh_'+partial.id+'_1.mp4',startEpoch:Date.now()})
  emptySecondSegment=true
  await hub.debugStop('device')
  const partialOutput=hub.captureState().outputs.find(o=>o.id===partial.id)
  assert.equal(partialOutput.files.length,3)
  assert.match(partialOutput.error,/Encoder failed/)
  assert.match(JSON.parse(readFileSync(partialOutput.files.at(-1),'utf8')).segments[1].error,/原件为空/)
  emptySecondSegment=false
  let selected='native-ime',enabled=false,broadcasts=0
  hub.imeStatus=async()=>({installed:true,current:selected})
  adb.shellOk=async (_s,command)=>{if(command.startsWith('ime enable'))enabled=true;else if(command.startsWith('ime set')){assert(enabled);selected='com.android.adbkeyboard/.AdbIME'}else if(command.startsWith('am broadcast'))broadcasts++;return ''}
  await assert.rejects(hub.imeSend('device','中文'),/未激活/)
  assert.equal(broadcasts,0)
  await hub.activateIme('device','native-ime')
  assert.equal(hub.prevIme.get('device'),'native-ime')
  await hub.imeSend('device','中文');assert.equal(broadcasts,1)
  hub.prevIme.clear()
  const bigLog=join(temp,'large.log'), chunk='1793719673.123 Test '+ 'x'.repeat(180)+'\n'
  writeFileSync(bigLog, chunk.repeat(180000)+'1793719845.001 final-tail\n')
  await hub.loadDebugLog(debug,bigLog)
  assert(debug.logRingBytes<=24000000);assert.match(debug.logRing.at(-1),/final-tail/)
  assert.throws(() => hub.captureFile('../../etc/passwd', 0), /未登记/)
  const registered = hub.captureFile(id, 0)
  renameSync(registered.file, registered.file + '.original'); symlinkSync(savedState, registered.file)
  assert.throws(() => hub.captureFile(id, 0), /已被替换/)
  rmSync(registered.file); renameSync(registered.file + '.original', registered.file)

  // A slow/failed action keeps its start time and completion, including across segment boundaries.
  const timingId = 'dbg-87654321-1234-1234-1234-123456789abc'
  const timing = { id: timingId, serial: 'device', mode: 'agent', startedAt: Date.now()-10000, dir: first, segments: [], acts: [], logRemote: '/data/local/tmp/dsh_' + timingId + '-logcat.log' }
  hub.debugSessions.set(timingId, timing); hub.debugBySerial.set('device', timingId)
  const inner = hub.performActInner
  hub.performActInner = async () => { await new Promise(yes => setTimeout(yes, 20)); return 'slow text' }
  const before = Date.now(); await hub.performAct('device', {action:'text',text:'test'})
  assert.ok(timing.acts[0].t >= before && timing.acts[0].endedAt - timing.acts[0].t >= 15)
  hub.performActInner = async () => { throw new Error('injected action failure') }
  await assert.rejects(hub.performAct('device', {action:'text'}), /injected action failure/)
  assert.match(timing.acts[1].detail, /^FAILED:/); assert.ok(timing.acts[1].endedAt >= timing.acts[1].t)
  hub.performActInner = inner; hub.debugBySerial.delete('device'); hub.debugSessions.delete(timingId)
  state.registerOutput(timingId, 'debug', [registered.file])
  // Stopping while text is in flight waits for its final result before writing actions.json.
  const drain = await hub.debugStart('device','human')
  let finishAction
  hub.performActInner = async () => new Promise(yes => { finishAction = yes })
  const acting = hub.performAct('device',{action:'text'},undefined,'panel')
  const stopping = hub.debugStop('device')
  assert.equal(hub.debugSessions.get(drain.id).saved,undefined)
  finishAction('completed text'); await acting; await stopping
  const manifest = hub.captureState().outputs.find(o=>o.id===drain.id).files.at(-1)
  const finalAction = JSON.parse(readFileSync(manifest,'utf8')).actions[0]
  assert.equal(finalAction.detail,'completed text'); assert.ok(finalAction.endedAt >= finalAction.t)
  hub.performActInner = inner
  // EventEmitter close must not throw if the host state disk fails; native capture still stops.
  const diskFailure = await hub.debugStart('device','human')
  const failedSession = hub.debugSessions.get(diskFailure.id), persist = hub.persistDebug
  hub.persistDebug = () => { throw new Error('injected manifest disk failure') }
  const failedInfo = hub.captureProcesses.get(failedSession.recordProc)
  failedInfo.done = true; failedInfo.close(0)
  assert.doesNotThrow(() => failedSession.recordProc.emit('close',0))
  await assert.rejects(failedSession.saving,/manifest disk failure/)
  assert.equal(hub.captureProcesses.get(failedSession.logProc).done,true)
  hub.persistDebug = persist
  await hub.debugStop('device')
  // Debug evidence timing: device-clock calibration, sparse frame timelines and fresh-frame acceptance.
  const { nativeFrameEpochs, debugClockBounds, selectDebugFrame, commitFrame } = await import(pathToFileURL(join(temp, 'pane-service.js')).href)
  const clock = { minOffsetMs: -50, maxOffsetMs: 50 }
  assert.deepEqual(debugClockBounds({ minOffsetMs: -50, maxOffsetMs: -10 }, { minOffsetMs: -30, maxOffsetMs: 20 }), { minOffsetMs: -50, maxOffsetMs: 20 })
  assert.equal(debugClockBounds(undefined, clock), undefined) // No sample, no calibrated claim.
  assert.equal(debugClockBounds({ minOffsetMs: -60, maxOffsetMs: -55 }, clock), undefined) // Empty intersection.
  const epochBase = 1_800_000_000_000, pts = [3, 6, 20, 40, 41, 60] // 3s anchor delay, sparse gaps.
  const meta = Buffer.alloc(32 + pts.length * 8)
  meta.write('#VV1NSC0PET1ME2#', 0, 'ascii')
  meta.writeUInt32LE(2, 16)
  meta.writeBigInt64LE(BigInt(epochBase) * 1_000_000n, 20)
  meta.writeUInt32LE(pts.length, 28)
  pts.forEach((t, i) => meta.writeBigInt64LE(BigInt(Math.round(t * 1000)) * 1_000_000n, 32 + i * 8))
  const epochs = nativeFrameEpochs(meta, pts)
  assert.deepEqual(epochs, pts.map(t => epochBase + t * 1000))
  assert.throws(() => nativeFrameEpochs(meta.subarray(0, meta.length - 8), pts), /数量或长度不匹配/)
  const v1 = Buffer.from(meta); v1.writeUInt32LE(1, 16)
  assert.throws(() => nativeFrameEpochs(v1, pts), /缺少受支持的原生帧时间元数据/)
  assert.throws(() => nativeFrameEpochs(meta, [0, 1, 2, 3, 4, 5]), /原生帧时间与视频时间不一致/)
  // Pre targets select a frame that ended before the action even at worst-case skew; post is guaranteed after.
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 13_000, 'pre'), 1)
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 13_000, 'post'), 2)
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 2_000, 'pre'), -1) // Before the delayed first frame.
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 61_000, 'post'), -1) // After the last presented frame.
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 61_000, 'pre'), 5) // Pre stays valid after the last frame.
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 40_500, 'pre'), 3) // Frames 1s apart, target dead centre.
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 40_500, 'post'), 4)
  assert.equal(selectDebugFrame(epochs, clock, epochBase + 40_500, 'sample'), 4)
  assert.equal(selectDebugFrame([], clock, epochBase, 'pre'), -1)
  // Path handling is delegated to node:path, i.e. the host platform's own semantics (no manual slashes).
  const paths = await import('node:path')
  assert.equal(paths.join('/', 'shot.png'), '/shot.png') // Unix root: one separator, never '//'.
  assert.equal(paths.win32.join('C:\\', 'shot.png'), 'C:\\shot.png') // Drive root stays absolute and single-separated.
  assert.equal(paths.win32.isAbsolute('C:\\'), true)
  // A stale PNG at the deterministic name must never be published as this extraction's frame.
  const stale = join(temp, 'f01-pre.png')
  writeFileSync(stale, png)
  assert.throws(() => commitFrame(join(temp, 'never-written.png'), stale))
  assert.deepEqual(readFileSync(stale), png) // Untouched: no phantom evidence.
  writeFileSync(join(temp, 'empty.png'), Buffer.alloc(0))
  assert.throws(() => commitFrame(join(temp, 'empty.png'), stale), /没有生成新的有效PNG/)
  assert.deepEqual(readFileSync(stale), png)
  const fresh = join(temp, 'fresh-frame.png')
  writeFileSync(fresh, Buffer.concat([png, Buffer.from('new')]))
  commitFrame(fresh, stale)
  assert.equal(readFileSync(stale).length, png.length + 3)
  assert.equal(existsSync(fresh), false)
  // Sampler and persistence share one clock-width ceiling: a valid sample must always be savable.
  const clockHome = join(temp, 'clock-home'); mkdirSync(clockHome)
  const clockState = PaneStateStore.open(clockHome)
  clockState.setDirectory(second)
  const pendingId = 'dbg-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const clockPending = width => ({ id: pendingId, type: 'debug', serial: 'device', dir: second, startedAt: Date.now(), logRemote: '/data/local/tmp/dsh_' + pendingId + '-logcat.log', segments: [], actions: [], clockStart: { minOffsetMs: -width / 2, maxOffsetMs: width / 2 } })
  clockState.upsertPending(clockPending(1000)) // Widest sample the sampler can produce must pass the validator.
  assert.throws(() => clockState.upsertPending(clockPending(1001)), /无效待保存采集清单/)
  // The analyze pipeline itself: guard the exact behaviours a refactor could silently undo.
  const serviceSource = readFileSync(join(root, 'src', 'pane-service.ts'), 'utf8')
  assert.match(serviceSource, /commitFrame\(tmp, file\)/) // Only a committed fresh extraction may become evidence.
  assert.match(serviceSource, /select=eq\(n\\\\,'/) // Escaped comma must reach ffmpeg.
  assert.doesNotMatch(serviceSource, /'-y'/) // Never overwrite a stale deterministic frame.
  assert.match(serviceSource, /existsSync\(tmp\)/) // ffmpeg exit 0 without output is still a failure.
  assert.match(serviceSource, /rmSync\(framesDir/) // Previous analyze output is cleared first.
  assert.match(serviceSource, /该时刻不在已保存录屏段内/) // Out-of-segment targets are reported, not dropped silently.
  let handler
  let pickResult = null, pickCalls = 0, pickPending = null
  const unmountRoutes = mountPaneRoutes({ register: route => { handler = route.handler; return () => {} } }, hub, () => null, async signal => {
    pickCalls++; if(pickPending) return pickPending(signal)
    if(pickResult instanceof Error) throw pickResult
    return pickResult
  })
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  const base = 'http://127.0.0.1:' + server.address().port + ROUTE_PREFIX
  let res = await fetch(base + '/capture/file?id=' + id + '&index=0', { headers: { range: 'bytes=0-7' } })
  assert.equal(res.status, 206); assert.equal((await res.arrayBuffer()).byteLength, 8)
  res = await fetch(base + '/capture/file?id=' + id + '&index=0', { headers: { range: 'bytes=99999-' } })
  assert.equal(res.status, 416)
  res = await fetch(base + '/capture/file?id=' + id + '&index=0', { headers: { origin: 'https://evil.example' } })
  assert.equal(res.status, 403)
  res = await fetch(base + '/capture/file?id=../../etc/passwd&index=0')
  assert.equal(res.status, 404)
  res = await fetch(base + '/capture/directory', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ directory: second }) })
  assert.equal(res.status, 403)

  const choose = headers => fetch(base + '/capture/pick-directory', {method:'POST',headers,body:'{}'})
  res = await choose({origin:'https://evil.example'}); assert.equal(res.status,403); assert.equal(pickCalls,0)
  res = await choose({'sec-fetch-site':'cross-site'}); assert.equal(res.status,403); assert.equal(pickCalls,0)
  const directoryBefore = state.data.directory
  res = await choose(); assert.equal((await res.json()).directory,null); assert.equal(state.data.directory,directoryBefore)
  pickResult = second; res = await choose(); assert.equal((await res.json()).directory,second); assert.equal(state.data.directory,directoryBefore)
  pickResult = new Error('native chooser failed'); res = await choose(); assert.equal(res.status,500)
  let enteredPick, releasePick
  const entering = new Promise(yes => {enteredPick=yes})
  pickPending = signal => new Promise((yes,no) => {releasePick=yes;enteredPick();signal.addEventListener('abort',()=>no(new Error('aborted')),{once:true})})
  const pendingPick = choose(); await entering
  res = await choose(); assert.equal(res.status,409)
  releasePick(null); assert.equal((await (await pendingPick).json()).directory,null)
  const client = readFileSync(join(root,'src/client/index.ts'),'utf8')
  const method = client.slice(client.indexOf('  private async browseDirectory()'),client.indexOf('  private async saveDirectory()'))
  const cls = ts.transpileModule('class Picker {' + method + '} ', {compilerOptions:{target:ts.ScriptTarget.ES2023}}).outputText
  let apiCalls=0, result=null
  const Picker = new Function('api',cls+';return Picker')(async()=>{apiCalls++;if(result instanceof Error)throw result;return {directory:result}})
  const pane = new Picker(); pane.state={modal:'directory',directoryDraft:'/original',directoryPickerOpen:false};pane.setState=patch=>Object.assign(pane.state,patch)
  await pane.browseDirectory();assert.equal(pane.state.directoryDraft,'/original')
  result=second;await pane.browseDirectory();assert.equal(pane.state.directoryDraft,second);assert.equal(pane.state.directoryPickerOpen,false)
  result=new Error('failure');await pane.browseDirectory();assert.equal(pane.state.directoryError,'failure')
  const callsBefore=apiCalls;pane.state.capture={record:{status:'recording'}};await pane.browseDirectory();assert.equal(apiCalls,callsBefore)
  pane.state.capture=null;pane.unmounted=true;result=first;await pane.browseDirectory();assert.equal(pane.state.directoryDraft,second)
  unmountRoutes()

  volume = 5
  await hub.capturePanel('device', 'mute')
  await hub.record('device', 'start'); failPull = true
  await assert.rejects(hub.record('device', 'stop'))
  const pending = hub.captureState().record, deletesBeforeDispose = removed.length
  hub.dispose(); await hub.muteQueue; await new Promise(yes => setImmediate(yes))
  assert.equal(volume, 5)
  assert.deepEqual(hub.captureState().record, pending)
  assert.equal(removed.length, deletesBeforeDispose)
  const reopened = PaneStateStore.open(home)
  assert.equal(reopened.data.pending[0].type, 'record')
  const recovered = new PaneHub(adb, reopened, { shotsDir: join(home, 'shots'), jarPath: '', log: msg => messages.push(msg), flagSecureCheck: false })
  assert.equal(recovered.captureState().record.status, 'pending-save')
  let recoveredStops = []
  recovered.stopRecoveredCapture = async (_serial, remote) => recoveredStops.push(remote)
  failPull = false
  await recovered.record('device', 'stop')
  assert.equal(recoveredStops.length, 1)
  assert.equal(PaneStateStore.open(home).data.pending.length, 0)
  assert.equal(recovered.captureState().record, null)
  // A new hub recovers original volume and a multi-file debug manifest, not any stale PID.
  reopened.setVolumeRestore('device', 7); volume = 0
  const reloadId = 'dbg-12345678-1234-1234-1234-123456789abc'
  reopened.upsertPending({ id: reloadId, type: 'debug', serial: 'device', dir: first, startedAt: Date.now()-1000,
    logRemote: '/data/local/tmp/dsh_' + reloadId + '-logcat.log',
    segments: [{ remote: '/data/local/tmp/dsh_' + reloadId + '_0.mp4', startEpoch: Date.now()-1000 }],
    actions: [{ t: Date.now(), action: 'key', detail: 'home' }] })
  const recoveredDebug = new PaneHub(adb, PaneStateStore.open(home), { shotsDir: join(home, 'shots'), jarPath: '', log: msg => messages.push(msg), flagSecureCheck: false })
  recoveredStops = []
  recoveredDebug.stopRecoveredCapture = async (_serial, remote) => recoveredStops.push(remote)
  assert.equal(recoveredDebug.captureState().muted.device, true)
  await recoveredDebug.capturePanel('device', 'mute')
  assert.equal(volume, 7); assert.deepEqual(PaneStateStore.open(home).data.volumeRestore, {})
  await recoveredDebug.debugStop('device')
  assert.equal(recoveredStops.length, 2)
  assert.equal(PaneStateStore.open(home).data.pending.length, 0)
  assert.equal(recoveredDebug.captureState().outputs.find(o=>o.id===reloadId).files.length, 3)
  // Recovery matches exact command ownership, never a persisted PID or a filename substring.
  const killed = [], remote = '/data/local/tmp/dsh_record-12345678-1234-1234-1234-123456789abc.mp4'
  let running = true
  const exactAdb = { ...adb, runOk: async args => {
    if(args.includes('ps')) return 'PID ARGS\n' + (running ? '123 /system/bin/screenrecord --time-limit 180 ' + remote + '\n' : '') + '999 screenrecord --time-limit 180 ' + remote + '.other\n'
    if(args.includes('kill')) { killed.push(args.at(-1)); running=false }
    return ''
  } }
  const exact = new PaneHub(exactAdb, PaneStateStore.open(home), {shotsDir:join(home,'shots'),jarPath:'',log:()=>{},flagSecureCheck:false})
  await exact.stopRecoveredCapture('device', remote)
  assert.deepEqual(killed, ['123'])
  recoveredDebug.claims.set('device', {sessionId:'agent',lastActivityAt:Date.now()})
  await assert.rejects(recoveredDebug.setQuality({maxFps:60}), /占用|认领|智能体/)
  // An old generation cannot overwrite files/registry after its successor recovers the same job.
  for (const type of ['record', 'debug']) {
    const raceHome = join(temp, 'race-' + type); mkdirSync(raceHome)
    const raceState = PaneStateStore.open(raceHome)
    raceState.setDirectory(first)
    const raceId = (type === 'record' ? 'record-' : 'dbg-') + 'aaaaaaaa-1234-1234-1234-123456789abc'
    raceState.upsertPending({id:raceId,type,serial:'device',dir:first,startedAt:Date.now()-1000,
      ...(type === 'record' ? {remote:'/data/local/tmp/dsh_' + raceId + '.mp4'} : {logRemote:'/data/local/tmp/dsh_' + raceId + '-logcat.log',segments:[{remote:'/data/local/tmp/dsh_' + raceId + '_0.mp4',startEpoch:Date.now()-1000}],actions:[]})})
    let release, entered
    const blocked = new Promise(yes => { release = yes }), pulling = new Promise(yes => { entered = yes })
    const opts = {shotsDir:join(raceHome,'shots'),jarPath:'',log:()=>{},flagSecureCheck:false}
    const oldHub = new PaneHub({...adb,runOk:async args => {if(args[2] === 'pull'){entered();await blocked}return adb.runOk(args)}},raceState,opts)
    oldHub.stopRecoveredCapture = async () => {}
    const stale = type === 'record' ? oldHub.record('device','stop') : oldHub.debugStop('device')
    const rejected = assert.rejects(stale,/重载/)
    await pulling; oldHub.dispose()
    const successor = new PaneHub(adb,PaneStateStore.open(raceHome),opts)
    successor.stopRecoveredCapture = async () => {}
    if(type === 'record') await successor.record('device','stop'); else await successor.debugStop('device')
    const before = PaneStateStore.open(raceHome).data.outputs.find(o=>o.id===raceId)
    release(); await rejected
    const after = PaneStateStore.open(raceHome).data
    assert.equal(after.pending.length,0); assert.deepEqual(after.outputs.find(o=>o.id===raceId),before)
    for(let i=0;i<before.files.length;i++) successor.captureFile(raceId,i) // Registered file identities were not replaced.
    successor.dispose()
  }
  recoveredDebug.dispose(); recovered.dispose(); exact.dispose()
  console.log('PASS: persistent record/debug/volume recovery; state atomic upgrade, fixed dirs, secure guard, mute/restore, MP4 validation, record/debug save retry+rotation, registered/ranged preview, origin guards, dispose retention, device-clock calibrated sparse-frame selection and fresh-frame acceptance')
} finally {
  if (server) await new Promise(yes => server.close(yes))
  rmSync(temp, { recursive: true, force: true })
}
