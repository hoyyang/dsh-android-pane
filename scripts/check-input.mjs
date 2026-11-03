import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readFile } from 'node:fs/promises'

// No device, server, filesystem fixture, or real timer is needed for these checks.
const savedSpawn = childProcess.spawn
let spawnCalls = 0
childProcess.spawn = () => { spawnCalls++; throw new Error('Unexpected real process spawn') }
syncBuiltinESMExports()
const savedGlobals = new Map()
const replace = (key, value) => {
  savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}
const quiet = process.env.DAP_QUIET
process.env.DAP_QUIET = '1'
const timeouts = new Set(), intervals = new Set(), rafs = new Map()
replace('setTimeout', (fn, ms) => { const t = { fn, ms }; timeouts.add(t); return t })
replace('clearTimeout', t => timeouts.delete(t))
replace('setInterval', (fn, ms) => { const t = { fn, ms }; intervals.add(t); return t })
replace('clearInterval', t => intervals.delete(t))
let nextRaf = 0
replace('requestAnimationFrame', fn => { rafs.set(++nextRaf, fn); return nextRaf })
replace('cancelAnimationFrame', id => rafs.delete(id))
const savedSignalTimeout = AbortSignal.timeout
AbortSignal.timeout = () => new AbortController().signal
const requests = []
replace('fetch', (url, options) => {
  assert(['/_dsh/dsh-android-pane/act', '/_dsh/dsh-android-pane/claim/release'].includes(url), 'Only mocked input/release requests are allowed')
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  requests.push({ body: JSON.parse(options.body), options, resolve, reject })
  return promise
})
replace('window', { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} })
class FakeCanvas {
  width = 1280
  height = 720
  getBoundingClientRect() { return { left: 10, top: 20, width: 640, height: 360 } }
}
replace('HTMLCanvasElement', FakeCanvas)
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const answer = async request => { request.resolve({ ok: true, json: async () => ({ ok: true }) }); await settle() }
const fireRaf = () => { for (const [id, fn] of [...rafs]) { rafs.delete(id); fn() } }
const code = expected => error => error.code === expected
const event = (p, x = 10, y = 20, extra = {}) => ({ p, x, y, ...extra })
const batch = (events, gesture = 'gesture-1', extra = {}) => ({ gesture, w: 1280, h: 720, events, ...extra })
let groups = 0

try {
  const entry = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(entry, /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]\.{1,2}\//, 'Main entry must bundle internal modules without relative imports')
  const { StreamSession, parsePanelInput, ACTION_DOWN, ACTION_MOVE, ACTION_UP } = await import('../lib/scrcpy-host.js')
  const { PaneHub } = await import('../lib/pane-service.js')
  const { PaneWindow } = await import('../lib/client/index.js')
  const streamMock = () => {
    const bytes = []
    const stream = new StreamSession('never-adb', 'fake-device', 'never-jar', { maxSize: 1280, maxFps: 30, videoBitRate: 1000000 }, () => {})
    stream.meta = { streamWidth: 1280, streamHeight: 720 }
    stream.proc = {} // Only the running getter may inspect this fake process.
    stream.controlSock = { destroyed: false, write: b => bytes.push(Buffer.from(b)), destroy() { this.destroyed = true } }
    return { stream, bytes }
  }
  const touch = (b, action, x, y) => {
    assert.equal(b.length, 32)
    assert.equal(b[0], 2)
    assert.equal(b[1], action)
    assert.equal(b.readBigUInt64BE(2), 0n)
    assert.equal(b.readUInt32BE(10), x)
    assert.equal(b.readUInt32BE(14), y)
    assert.equal(b.readUInt16BE(18), 1280)
    assert.equal(b.readUInt16BE(20), 720)
    assert.equal(b.readUInt16BE(22), action === ACTION_UP ? 0 : 65535)
    assert.equal(b.readUInt32BE(24), 0)
    assert.equal(b.readUInt32BE(28), 0)
  }

  // A scroll must end at byte 21, not consume the following 14-byte key.
  {
    const { stream, bytes } = streamMock()
    stream.scroll(-5, 900, 1, -1)
    stream.injectKey(ACTION_DOWN, 66, 7, 3)
    stream.injectKey(ACTION_UP, 66, 7, 0)
    const all = Buffer.concat(bytes)
    assert.deepEqual(bytes.map(b => b.length), [21, 14, 14])
    assert.equal(all.length, 49)
    assert.equal(all[0], 3)
    assert.equal(all.readUInt32BE(1), 0)
    assert.equal(all.readUInt32BE(5), 719)
    assert.equal(all.readUInt16BE(9), 1280)
    assert.equal(all.readUInt16BE(11), 720)
    assert.equal(all.readInt16BE(13), 2048)
    assert.equal(all.readInt16BE(15), -2048)
    assert.equal(all.readUInt32BE(17), 0)
    for (const [offset, action, repeat] of [[21, ACTION_DOWN, 3], [35, ACTION_UP, 0]]) {
      assert.equal(all[offset], 0)
      assert.equal(all[offset + 1], action)
      assert.equal(all.readUInt32BE(offset + 2), 66)
      assert.equal(all.readUInt32BE(offset + 6), repeat)
      assert.equal(all.readUInt32BE(offset + 10), 7)
    }
    for (const [delta, expected] of [[1, 2048], [-1, -2048], [16, 32767], [-16, -32768], [0.3333, 682], [-0.3333, -682]]) {
      stream.scroll(10.6, 20.4, delta, delta)
      const b = bytes.at(-1)
      assert.equal(b.length, 21)
      assert.equal(b.readUInt32BE(1), 11)
      assert.equal(b.readUInt32BE(5), 20)
      assert.equal(b.readInt16BE(13), expected)
      assert.equal(b.readInt16BE(15), expected)
    }
    stream.injectTouch(-100, 10000, ACTION_DOWN)
    stream.injectTouch(10.6, 20.4, ACTION_MOVE)
    stream.injectTouch(2000, -1, ACTION_UP)
    touch(bytes.at(-3), ACTION_DOWN, 0, 719)
    touch(bytes.at(-2), ACTION_MOVE, 11, 20)
    touch(bytes.at(-1), ACTION_UP, 1279, 0)
    groups++
  }

  // Validation is atomic: neither truncate an oversized batch nor filter bad events.
  {
    const valid = batch([event('down'), event('up')])
    assert.equal(parsePanelInput(valid), valid)
    const invalid = [null, {}, batch([]), batch(Array(65).fill(event('up'))),
      batch([event('down'), event('move', NaN)]), batch([event('up', 0, Infinity)]),
      batch([event('cancel')]), batch([event('scroll', 0, 0, { dx: NaN, dy: 1 })]),
      batch([event('scroll', 0, 0, { dx: 1 })]), batch([event('up', 2147483648)]),
      ...[0, -1, 65536, 1.5, NaN].flatMap(n => [batch([event('up')], 'g', { w: n }), batch([event('up')], 'g', { h: n })]),
      batch([event('up')], ''), batch([event('up')], 'bad/id'), batch([event('up')], 'a'.repeat(81))]
    const { stream, bytes } = streamMock()
    for (const input of invalid) {
      assert.throws(() => parsePanelInput(input), code('bad-request'))
      assert.throws(() => stream.injectPanelInput(input), code('bad-request'))
    }
    assert.equal(bytes.length, 0)
    assert.equal(parsePanelInput(batch(Array(64).fill(event('up')))).events.length, 64)
    assert.throws(() => stream.injectPanelInput(batch([event('down')], 'g', { w: 640 })), code('input-stale'))
    assert.equal(bytes.length, 0)
    assert.throws(() => stream.injectPanelInput(batch([event('down'), event('down')])), code('input-busy'))
    assert.throws(() => stream.injectPanelInput(batch([event('down'), event('up'), event('move')])), code('input-stale'))
    assert.equal(bytes.length, 0)
    groups++
  }

  // Lease renewal, late IDs, cancel/UP idempotence, timeout and stop all release once.
  {
    const { stream, bytes } = streamMock()
    stream.injectPanelInput(batch([event('down'), event('move', 30, 40), event('up', 50, 60)]))
    assert.deepEqual(bytes.map(b => b[1]), [ACTION_DOWN, ACTION_MOVE, ACTION_UP])
    assert.equal(stream.panelTouch, null)
    stream.injectPanelInput(batch([event('down')], 'old'))
    const oldTimer = stream.panelTouch.timer
    assert.equal(oldTimer.ms, 2000)
    stream.cancelPanelTouch('wrong')
    assert.equal(stream.panelTouch.id, 'old')
    stream.cancelPanelTouch('old')
    const released = bytes.length
    stream.cancelPanelTouch('old')
    stream.injectPanelInput(batch([event('up')], 'old'))
    assert.equal(bytes.length, released)
    stream.injectPanelInput(batch([event('down')], 'new'))
    oldTimer.fn()
    stream.injectPanelInput(batch([event('up')], 'old'))
    assert.equal(stream.panelTouch.id, 'new')
    assert.throws(() => stream.injectPanelInput(batch([event('move')], 'old')), code('input-stale'))
    assert.throws(() => stream.injectPanelInput(batch([event('scroll', 0, 0, { dx: 1, dy: 1 })], 'wheel')), code('input-busy'))
    const timer = stream.panelTouch.timer
    stream.injectPanelInput(batch([event('move', 31, 41)], 'new'))
    assert(!timeouts.has(timer), 'MOVE must clear the previous lease')
    const renewed = stream.panelTouch.timer
    assert(timeouts.has(renewed))
    const beforeTimeout = bytes.length
    renewed.fn()
    renewed.fn()
    assert.equal(bytes.length, beforeTimeout + 1, 'Timeout emits exactly one UP')
    touch(bytes.at(-1), ACTION_UP, 31, 41)
    stream.injectPanelInput(batch([event('down')], 'stale-size'))
    assert.throws(() => stream.injectPanelInput(batch([event('move')], 'stale-size', { h: 1 })), code('input-stale'))
    assert.equal(stream.panelTouch, null)
    stream.injectPanelInput(batch([event('down')], 'stop'))
    stream.proc = null
    stream.port = 0
    const beforeStop = bytes.length
    stream.stop()
    stream.stop()
    assert.equal(bytes.length, beforeStop + 1)
    assert.equal(bytes.at(-1)[1], ACTION_UP)
    assert.equal(stream.controlSock, null)
    assert.equal(stream.running, false)
    groups++
  }

  // Explicit UP is strict; teardown and lease expiry remain non-blocking on write failure.
  {
    const broken = () => {
      const mock = streamMock()
      mock.stream.injectPanelInput(batch([event('down')], 'broken-up'))
      const socket = mock.stream.controlSock
      const failure = new Error('mock UP write failure')
      socket.write = () => { throw failure }
      return { ...mock, socket, failure }
    }
    const explicit = broken()
    assert.throws(() => explicit.stream.injectPanelInput(batch([event('up')], 'broken-up')), error => error === explicit.failure)
    assert.equal(explicit.socket.destroyed, true, 'Failed strict UP closes the control socket during cleanup')
    assert.equal(explicit.stream.panelTouch, null)
    const stopped = broken()
    stopped.stream.proc = null
    stopped.stream.port = 0
    assert.doesNotThrow(() => stopped.stream.stop(), 'Failed cleanup UP cannot block stop')
    assert.equal(stopped.socket.destroyed, true)
    assert.equal(stopped.stream.controlSock, null)
    assert.equal(stopped.stream.panelTouch, null)
    const expired = broken()
    const lease = expired.stream.panelTouch.timer
    assert.doesNotThrow(() => lease.fn(), 'Failed timeout UP remains best effort')
    assert.equal(expired.socket.destroyed, true)
    assert.equal(expired.stream.panelTouch, null)
    assert(!timeouts.has(lease))
    assert.doesNotThrow(() => lease.fn())
    groups++
  }

  const hub = Object.create(PaneHub.prototype)
  Object.assign(hub, { streams: new Map(), claims: new Map(), busyUntil: new Map(),
    debugSessions: new Map(), debugBySerial: new Map(), lastDims: new Map() })
  const serial = 'fake-device'
  const { stream, bytes } = streamMock()
  hub.streams.set(serial, stream)
  {
    const input = batch([event('down')])
    assert.throws(() => hub.panelInput(undefined, input), code('bad-request'))
    hub.claims.set(serial, { sessionId: 'agent-session' })
    assert.throws(() => hub.panelInput(serial, input), code('agent-busy'))
    hub.claims.clear()
    hub.busyUntil.set(serial, Date.now() + 100000)
    assert.throws(() => hub.panelInput(serial, input), code('agent-busy'))
    hub.busyUntil.clear()
    const debug = { acts: [] }
    hub.debugSessions.set('debug', debug)
    hub.debugBySerial.set(serial, 'debug')
    assert.equal(hub.panelInput(serial, input).performed, 'input(down)|ctl')
    assert.equal(debug.acts.length, 1)
    hub.claims.set(serial, { sessionId: 'agent-session' })
    const beforeUp = bytes.length
    assert.equal(hub.panelInput(serial, batch([event('up')], 'gesture-1', { w: 1 })).performed, 'input(released)')
    assert.equal(bytes.length, beforeUp + 1, 'Cleanup is allowed while locked')
    hub.panelInput(serial, batch([event('up')]))
    assert.equal(bytes.length, beforeUp + 1)
    assert.equal(debug.acts.length, 1)
    hub.claims.clear()
    hub.streams.delete(serial)
    assert.throws(() => hub.panelInput(serial, input), code('no-stream'))
    assert.equal(hub.panelInput(serial, batch([event('up')])).performed, 'input(released)')
    hub.streams.set(serial, stream)
    debug.stoppedAt = Date.now()
    hub.panelInput(serial, batch([event('scroll', 1, 2, { dx: 1, dy: -1 })], 'wheel'))
    assert.equal(debug.acts.length, 1)
    groups++
  }
  {
    const commands = []
    hub.adb = { shellOk: async (s, command) => { assert.equal(s, serial); commands.push(command) } }
    hub.lastDims.set(serial, { sw: 1280, sh: 720, dw: 2560, dh: 1440 })
    await hub.performActInner(serial, { action: 'tap', x: 123, y: 456 }, undefined, 'agent')
    await hub.performActInner(serial, { action: 'tap', x: 123, y: 456 }, undefined, 'panel')
    await hub.performActInner(serial, { action: 'swipe', x: 10, y: 20, x2: 30, y2: 40, durationMs: 300 }, undefined, 'agent')
    await hub.performActInner(serial, { action: 'swipe', x: 10, y: 20, x2: 30, y2: 40, durationMs: 300 }, undefined, 'panel')
    hub.uiFind = async () => ({ center: [321, 654], text: 'Target' })
    stream.injectPanelInput(batch([event('down')], 'ui-cleanup'))
    const beforeUi = bytes.length
    await hub.uiTap(serial, { target: 'Target' })
    assert.equal(bytes.length, beforeUi + 1, 'Agent UI tap cancels the human touch')
    assert.deepEqual(commands, ['input tap 123 456', 'input tap 246 912',
      'input swipe 10 20 30 40 300', 'input swipe 20 40 60 80 300', 'input tap 321 654'])
    stream.displaySize = { w: 2560, h: 1440 }
    const scrollStart = bytes.length
    await hub.performActInner(serial, { action: 'scroll', x: 640, y: 480, y2: -1 }, undefined, 'agent')
    await hub.performActInner(serial, { action: 'scroll', x: 640, y: 480, y2: -1 }, undefined, 'panel')
    assert.deepEqual(bytes.slice(scrollStart).map(b => [b.readUInt32BE(1), b.readUInt32BE(5)]), [[320, 240], [640, 480]])
    stream.displaySize = { w: 2560, h: 2880 }
    await hub.performActInner(serial, { action: 'scroll', x: 640, y: 480, y2: -1 }, undefined, 'agent')
    assert.deepEqual([bytes.at(-1).readUInt32BE(1), bytes.at(-1).readUInt32BE(5)], [320, 120], 'X/Y ratios must be independent')
    stream.meta = null
    await hub.performActInner(serial, { action: 'scroll', x: 640, y: 480, y2: -1 }, undefined, 'agent')
    assert.deepEqual([bytes.at(-1).readUInt32BE(1), bytes.at(-1).readUInt32BE(5)], [640, 480], 'No metadata means display space')
    hub.streams.delete(serial)
    await hub.performActInner(serial, { action: 'scroll', x: 640, y: 480, y2: -1 }, undefined, 'agent')
    await hub.performActInner(serial, { action: 'scroll', x: 640, y: 480, y2: -1 }, undefined, 'panel')
    assert.deepEqual(commands.slice(5), ['input swipe 640 480 640 80 300', 'input swipe 1280 960 1280 560 300'])
    hub.ensureStream = async () => { hub.claims.set(serial, { sessionId: 'racing-agent' }) }
    await assert.rejects(hub.actPanel({ serial, action: 'tap', x: 1, y: 1 }), code('agent-busy'))
    assert.equal(commands.length, 7, 'Recheck the lock after async recovery')
    hub.claims.clear()
    groups++
  }

  const paneMock = () => {
    const pane = new PaneWindow({})
    pane.setState = patch => Object.assign(pane.state, patch)
    Object.assign(pane.state, { serial, mode: 'h264' })
    pane.canvasRef = new FakeCanvas()
    return pane
  }
  {
    const pane = paneMock(), start = requests.length, attached = []
    pane.attach = async serial => attached.push(serial)
    const release = pane.forceRelease()
    requests[start].resolve({ ok: true, json: async () => ({ ok: true, released: true, note: 'released' }) })
    await release
    assert.deepEqual(attached, [serial], 'Force unlock reconnects the stopped control stream')
    const late = pane.forceRelease()
    pane.state.serial = 'other-device'
    requests[start + 1].resolve({ ok: true, json: async () => ({ ok: true, released: true, note: 'released' }) })
    await late
    assert.deepEqual(attached, [serial], 'Late unlock must not switch back to an old device')
    for (const timer of [...timeouts]) if (timer.ms === 6000) { timeouts.delete(timer); timer.fn() }
    assert.equal(pane.state.note, null, 'Takeover note expires')
    groups++
  }
  {
    const pane = paneMock(), start = requests.length
    const wheel = { serial, gesture: 'wheel', w: 1280, h: 720 }
    const drag = { ...wheel, gesture: 'drag' }
    pane.queueInput(wheel, event('scroll', 1, 2, { dx: 1, dy: 2 }))
    pane.queueInput(wheel, event('scroll', 3, 4, { dx: 2, dy: -1 }))
    pane.queueInput(drag, event('down')) // Flush the older wheel first.
    pane.queueInput(drag, event('move', 11, 21))
    pane.queueInput(drag, event('move', 12, 22))
    pane.queueInput(drag, event('up', 13, 23))
    pane.queueInput(wheel, event('scroll', 5, 6, { dx: -1, dy: 1 }))
    fireRaf()
    assert.equal(requests.length, start + 1, 'One input request in flight')
    assert.deepEqual(requests[start].body.input.events, [event('scroll', 3, 4, { dx: 3, dy: 1 })])
    await answer(requests[start])
    assert.equal(requests.length, start + 2)
    assert.deepEqual(requests[start + 1].body.input.events, [event('down'), event('move', 12, 22), event('up', 13, 23)])
    await answer(requests[start + 1])
    assert.equal(requests.length, start + 3)
    assert.equal(requests[start + 2].body.input.gesture, 'wheel')
    await answer(requests[start + 2])
    assert.equal(pane.inputInflight, false)
    assert.equal(pane.inputQueue.length, 0)
    for (const r of requests.slice(start)) {
      assert.equal(r.options.keepalive, true)
      assert.equal(r.body.action, 'input')
      assert(r.options.signal instanceof AbortSignal)
    }
    const bounded = paneMock()
    bounded.inputInflight = true
    for (let i = 0; i < 65; i++) bounded.queueInput(drag, event(i % 2 ? 'move' : 'up'))
    assert.deepEqual(bounded.inputQueue.map(b => b.input.events.length), [64, 1])
    rafs.clear()
    groups++
  }
  {
    const pane = paneMock(), start = requests.length
    const capture = new Set(), target = pane.canvasRef
    const screen = { setPointerCapture: id => capture.add(id), hasPointerCapture: id => capture.has(id), releasePointerCapture: id => capture.delete(id) }
    const e = { button: 0, isPrimary: true, pointerId: 7, target, currentTarget: screen, clientX: 60, clientY: 70 }
    pane.onPointerDown({ ...e, target: {} })
    pane.onPointerDown({ ...e, button: 2 })
    pane.onPointerDown({ ...e, isPrimary: false })
    pane.state.busy = true; pane.onPointerDown(e); pane.state.busy = false
    pane.state.claimSessionId = 'locked'; pane.onPointerDown(e); pane.state.claimSessionId = null
    assert.equal(requests.length, start, 'Toolbar, non-primary and locked input never captures')
    assert.equal(capture.size, 0)
    pane.onPointerDown(e)
    assert(capture.has(7))
    assert.deepEqual(requests[start].body.input.events, [event('down', 100, 100)])
    assert.equal(pane.holdTimer.ms, 750)
    pane.onPointerMove({ ...e, pointerId: 8, clientX: 99 })
    assert.equal(pane.inputQueue.length, 0)
    pane.onPointerMove({ ...e, clientX: 80 })
    pane.holdTimer.fn()
    pane.onPointerUp({ ...e, clientX: 90 })
    assert.equal(capture.size, 0)
    assert.equal(pane.pointer, null)
    assert.equal(pane.holdTimer, null)
    await answer(requests[start])
    assert.deepEqual(requests[start + 1].body.input.events, [event('move', 140, 100), event('up', 160, 100)])
    await answer(requests[start + 1])
    pane.onPointerDown(e)
    target.width = 640
    pane.onPointerMove(e)
    assert.equal(pane.pointer, null, 'Resize cancels the captured gesture')
    await answer(requests[start + 2])
    assert.equal(requests[start + 3].body.input.events[0].p, 'up')
    await answer(requests[start + 3])
    target.width = 1280
    pane.onPointerDown(e)
    pane.onPointerCancel(e)
    await answer(requests[start + 4])
    assert.equal(requests[start + 5].body.input.events[0].p, 'up')
    await answer(requests[start + 5])
    let prevented = 0
    pane.onWheelNative({ ...e, deltaMode: 1, deltaX: 2, deltaY: 3, preventDefault: () => prevented++ })
    fireRaf()
    assert.equal(prevented, 1)
    assert.deepEqual(requests[start + 6].body.input.events, [event('scroll', 100, 100, { dx: -0.32, dy: -0.48 })])
    await answer(requests[start + 6])
    assert.equal(pane.inputInflight, false)
    groups++
  }
  // A different in-flight gesture must not allow cancelled queued taps to inject later.
  {
    const pane = paneMock(), start = requests.length
    const context = gesture => ({ serial, gesture, w: 1280, h: 720 })
    pane.queueInput(context('inflight'), event('down'))
    pane.queueInput(context('queued-tap'), event('down'))
    pane.queueInput(context('queued-tap'), event('up'))
    pane.queueInput(context('queued-hold'), event('down'))
    pane.queueInput(context('queued-hold'), event('move', 30, 40))
    pane.queueInput(context('wheel'), event('scroll', 0, 0, { dx: 1, dy: 1 }))
    pane.pointer = { ...context('queued-hold'), realtime: true, lastX: 30, lastY: 40 }
    pane.clearGesture()
    assert.equal(pane.pointer, null)
    assert.deepEqual(pane.inputQueue.map(b => [b.input.gesture, b.input.events]), [
      ['queued-tap', [event('up')]], ['queued-hold', [event('up', 30, 40)]]])
    assert.equal(requests.length, start + 1)
    await answer(requests[start])
    await answer(requests[start + 1])
    await answer(requests[start + 2])
    assert.equal(requests.length, start + 3)
    assert(requests.slice(start + 1).every(r => r.body.input.events.every(e => e.p === 'up')))
    assert.equal(pane.inputQueue.length, 0)
    assert.equal(pane.inputInflight, false)
    groups++
  }
  // An uncertain DOWN reports failure and sends cleanup, never replays queued input.
  {
    const pane = paneMock(), start = requests.length
    const context = { serial, gesture: 'failed-down', w: 1280, h: 720 }
    pane.queueInput(context, event('down'))
    pane.queueInput(context, event('move'))
    requests[start].reject(new Error('mock transport failure'))
    await settle()
    assert.match(pane.state.error, /mock transport failure/)
    assert.equal(pane.inputQueue.length, 0)
    assert.equal(requests.length, start + 2)
    assert.deepEqual(requests[start + 1].body.input.events, [event('up', 0, 0)])
    await answer(requests[start + 1])
    assert.equal(requests.length, start + 2, 'A failed DOWN cannot be retried')
    groups++
  }
  // Use the real wheel handler under backpressure: bounded chunks preserve the total.
  {
    const pane = paneMock(), start = requests.length
    pane.queueInput({ serial, gesture: 'blocker', w: 1280, h: 720 }, event('up'))
    let prevented = 0
    const wheel = { target: pane.canvasRef, clientX: 60, clientY: 70, deltaMode: 0,
      deltaX: 0, deltaY: -100, preventDefault: () => prevented++ }
    for (let i = 0; i < 20; i++) pane.onWheelNative(wheel)
    const accumulated = pane.inputQueue.flatMap(b => b.input.events)
    assert(accumulated.length > 1, 'Backpressure cannot merge scroll beyond the wire range')
    assert.equal(accumulated.reduce((sum, e) => sum + e.dy, 0), 20)
    assert(accumulated.every(e => e.p === 'scroll' && Math.abs(e.dx) <= 15 && Math.abs(e.dy) <= 15))
    fireRaf()
    assert.equal(requests.length, start + 1, 'Wheel batches respect the single-flight transport')
    await answer(requests[start])
    assert.deepEqual(requests[start + 1].body.input.events, JSON.parse(JSON.stringify(accumulated))) // JSON normalizes -0.
    await answer(requests[start + 1])
    pane.onWheelNative({ ...wheel, deltaY: 2000 })
    fireRaf()
    const large = requests[start + 2].body.input.events
    assert(large.length > 1, 'A 2000px wheel event must split')
    assert.equal(large.reduce((sum, e) => sum + e.dy, 0), -20, 'Splitting must preserve all 2000px')
    assert(large.every(e => Math.abs(e.dx) <= 15 && Math.abs(e.dy) <= 15))
    await answer(requests[start + 2])
    assert.equal(prevented, 21)
    assert.equal(pane.inputQueue.length, 0)
    const { stream, bytes } = streamMock()
    for (const value of [16.01, -16.01]) {
      for (const axis of ['dx', 'dy']) {
        const input = batch([event('down'), event('scroll', 0, 0, { dx: 0, dy: 0, [axis]: value })])
        assert.throws(() => parsePanelInput(input), code('bad-request'))
        assert.throws(() => stream.injectPanelInput(input), code('bad-request'))
      }
    }
    assert.equal(bytes.length, 0, 'Invalid remote scroll rejects the entire batch before DOWN')
    assert.equal(parsePanelInput(batch([event('scroll', 0, 0, { dx: 16, dy: -16 })])).events.length, 1)
    groups++
  }
  assert.equal(spawnCalls, 0)
  assert.equal(intervals.size, 0, 'No held gesture timers leak')
  assert.equal(timeouts.size, 0, 'No host lease timers leak')
  console.log('PASS ' + groups + ' input check groups (protocol, validation, lease, hub, coordinates/UI, queue, capture; no device/spawn)')
} finally {
  childProcess.spawn = savedSpawn
  syncBuiltinESMExports()
  AbortSignal.timeout = savedSignalTimeout
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
  if (quiet === undefined) delete process.env.DAP_QUIET
  else process.env.DAP_QUIET = quiet
}
