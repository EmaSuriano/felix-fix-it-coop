import kaplay from 'kaplay'
import type { Room } from '@trystero-p2p/mqtt'
import {
  WIDTH,
  HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  HOST_COLOR,
  JOIN_COLOR,
  MOVE_MS,
  TICK_S,
  SHEET_W,
  SHEET_H,
  STAGE_H,
  HUD_Y,
  HUD_H,
  MAPA_W,
  MAPA_H,
} from './config'

const ROWS = GRID_ROWS
const COLS = GRID_COLS
const HIT_IMMUNE_MS = 2000
const PIE_MS = 5000
const LIFE_EVERY = 2000
const MAX_LIVES = 3
const START_LIVES = 3

type PlayerId = 'host' | 'peer'

type HelloMsg = { name?: string }
type PosMsg = { col: number; row: number }
type HammerMsg = { col: number; row: number }

type NetPlayer = {
  id: PlayerId
  col: number
  row: number
  lives: number
  score: number
  immune: boolean
  berserk: boolean
}

type Brick = { col: number; row: number }
type Duck = { col: number; row: number; dir: number }
type Pie = { col: number; row: number } | null

type WorldMsg = {
  windows: number[][]
  players: NetPlayer[]
  bricks: Brick[]
  ducks: Duck[]
  pie: Pie
  stage: number
  over: boolean
  started: boolean
}

type SimPlayer = {
  id: PlayerId
  col: number
  row: number
  lives: number
  score: number
  immuneUntil: number
  berserkUntil: number
  name: string
  swingUntil: number
  lastStepAt: number
}

export function startGame(
  room: Room,
  opts: { isHost: boolean; canvas: HTMLCanvasElement; peerCountEl: HTMLElement; roomCode: string },
): void {
  const { isHost, canvas, peerCountEl, roomCode } = opts
  const myId: PlayerId = isHost ? 'host' : 'peer'
  const myName = isHost ? 'Host' : 'Guest'
  const peerNameDefault = isHost ? 'Guest' : 'Host'

  const k = kaplay({
    global: false,
    width: WIDTH,
    height: HEIGHT,
    letterbox: true,
    background: [16, 19, 26],
    crisp: true,
    canvas,
  })

  const assetBase = import.meta.env.BASE_URL
  let mapaOk = false
  let sheetOk = false
  k.loadSprite('mapa', `${assetBase}mapa.jpg`).onLoad(() => {
    mapaOk = true
  })
  k.loadSprite('felixSheet', `${assetBase}spritesFelix.png`).onLoad(() => {
    sheetOk = true
  })

  const helloAction = room.makeAction<HelloMsg>('hello')
  const posAction = room.makeAction<PosMsg>('pos')
  const hammerAction = room.makeAction<HammerMsg>('hammer')
  const worldAction = room.makeAction<WorldMsg>('world')

  const peers = new Set<string>()

  function hexColor(hex: string) {
    if (k.Color && typeof k.Color.fromHex === 'function') {
      return k.Color.fromHex(hex)
    }
    const n = String(hex).replace('#', '')
    const r = parseInt(n.slice(0, 2), 16) || 0
    const g = parseInt(n.slice(2, 4), 16) || 0
    const b = parseInt(n.slice(4, 6), 16) || 0
    return k.rgb(r, g, b)
  }

  function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n))
  }

  function randInt(lo: number, hi: number): number {
    return lo + Math.floor(Math.random() * (hi - lo + 1))
  }

  function emptyWindows(): number[][] {
    return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0))
  }

  function fillStageWindows(): number[][] {
    const grid = emptyWindows()
    let damaged = 0
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const roll = Math.random()
        if (roll < 0.42) grid[r][c] = 2
        else if (roll < 0.88) grid[r][c] = 1
        else grid[r][c] = 0
        if (grid[r][c] > 0) damaged++
      }
    }
    if (damaged === 0) grid[0][Math.floor(COLS / 2)] = 2
    return grid
  }

  function allFixed(grid: number[][]): boolean {
    return grid.every((row) => row.every((cell) => cell === 0))
  }

  const hostP: SimPlayer = {
    id: 'host',
    col: 0,
    row: ROWS - 1,
    lives: START_LIVES,
    score: 0,
    immuneUntil: 0,
    berserkUntil: 0,
    name: isHost ? myName : peerNameDefault,
    swingUntil: 0,
    lastStepAt: 0,
  }
  const peerP: SimPlayer = {
    id: 'peer',
    col: COLS - 1,
    row: ROWS - 1,
    lives: START_LIVES,
    score: 0,
    immuneUntil: 0,
    berserkUntil: 0,
    name: isHost ? peerNameDefault : myName,
    swingUntil: 0,
    lastStepAt: 0,
  }

  let windows = emptyWindows()
  let bricks: Brick[] = []
  let ducks: Duck[] = []
  let pie: Pie = null
  let stage = 1
  let over = false
  let started = false
  let peerJoined = false
  let lastPieAt = 0
  let hazardAcc = 0
  let moveTick = 0
  let lastMoveAt = 0
  let localCol = isHost ? hostP.col : peerP.col
  let localRow = isHost ? hostP.row : peerP.row
  let world: WorldMsg | null = null

  function nowMs(): number {
    return performance.now()
  }

  function simOf(id: PlayerId): SimPlayer {
    return id === 'host' ? hostP : peerP
  }

  function netPlayer(p: SimPlayer, t: number): NetPlayer {
    return {
      id: p.id,
      col: p.col,
      row: p.row,
      lives: p.lives,
      score: p.score,
      immune: t < p.immuneUntil,
      berserk: t < p.berserkUntil,
    }
  }

  function snapshot(t = nowMs()): WorldMsg {
    return {
      windows: windows.map((row) => row.slice()),
      players: [netPlayer(hostP, t), netPlayer(peerP, t)],
      bricks: bricks.map((b) => ({ ...b })),
      ducks: ducks.map((d) => ({ ...d })),
      pie: pie ? { ...pie } : null,
      stage,
      over,
      started,
    }
  }

  function sendWorld(): void {
    if (!isHost) return
    const msg = snapshot()
    world = msg
    worldAction.send(msg)
  }

  function extraLife(p: SimPlayer, prevScore: number): void {
    const before = Math.floor(prevScore / LIFE_EVERY)
    const after = Math.floor(p.score / LIFE_EVERY)
    if (after > before && p.lives > 0 && p.lives < MAX_LIVES) p.lives++
  }

  function eatPie(p: SimPlayer, t: number): void {
    if (!pie) return
    pie = null
    lastPieAt = t
    p.immuneUntil = t + PIE_MS
    p.berserkUntil = t + PIE_MS
  }

  function maybePie(p: SimPlayer, t: number): void {
    if (!pie || p.lives <= 0) return
    if (p.col === pie.col && p.row === pie.row) eatPie(p, t)
  }

  function applyHammer(p: SimPlayer, col: number, row: number, t: number): void {
    if (!started || over || p.lives <= 0) return
    const c = clamp(Math.round(col), 0, COLS - 1)
    const r = clamp(Math.round(row), 0, ROWS - 1)
    p.col = c
    p.row = r
    p.swingUntil = t + 180
    if (pie && pie.col === c && pie.row === r) eatPie(p, t)
    const cell = windows[r]?.[c]
    if (cell === undefined || cell <= 0) {
      sendWorld()
      return
    }
    const berserk = t < p.berserkUntil
    if (berserk && cell === 2) windows[r][c] = 0
    else windows[r][c] = cell - 1
    const prev = p.score
    p.score += 100
    extraLife(p, prev)
    if (allFixed(windows)) nextStage(t)
    sendWorld()
  }

  function nextStage(t: number): void {
    stage += 1
    bricks = []
    ducks = []
    pie = null
    lastPieAt = t
    windows = fillStageWindows()
  }

  function hitPlayer(p: SimPlayer, t: number): void {
    if (p.lives <= 0) return
    if (t < p.immuneUntil) return
    p.lives -= 1
    if (p.lives < 0) p.lives = 0
    p.immuneUntil = t + HIT_IMMUNE_MS
    p.berserkUntil = Math.min(p.berserkUntil, t)
  }

  function checkHits(t: number): void {
    const cells = (p: SimPlayer) =>
      bricks.some((b) => b.col === p.col && b.row === p.row) ||
      ducks.some((d) => d.col === p.col && d.row === p.row)
    if (cells(hostP)) hitPlayer(hostP, t)
    if (peerJoined && cells(peerP)) hitPlayer(peerP, t)
  }

  function matchOver(): boolean {
    if (!started) return false
    if (hostP.lives > 0) return false
    if (!peerJoined) return false
    return peerP.lives <= 0
  }

  function beginMatch(t: number): void {
    if (started) return
    started = true
    peerJoined = true
    windows = fillStageWindows()
    bricks = []
    ducks = []
    pie = null
    lastPieAt = t
    sendWorld()
  }

  function pauseMatch(): void {
    started = false
    peerJoined = false
    bricks = []
    ducks = []
    pie = null
    sendWorld()
  }

  function tickHost(dt: number): void {
    if (!isHost) return
    const t = nowMs()
    if (!started) {
      hazardAcc += dt
      if (hazardAcc >= TICK_S) {
        hazardAcc = 0
        sendWorld()
      }
      return
    }
    maybePie(hostP, t)
    if (peerJoined) maybePie(peerP, t)
    if (over) {
      hazardAcc += dt
      if (hazardAcc >= TICK_S) {
        hazardAcc = 0
        sendWorld()
      }
      return
    }
    hazardAcc += dt
    let stepped = false
    while (hazardAcc >= TICK_S) {
      hazardAcc -= TICK_S
      stepped = true
      moveTick++
      bricks = bricks
        .map((b) => ({ col: b.col, row: b.row + 1 }))
        .filter((b) => b.row < ROWS)
      ducks = ducks
        .map((d) => ({ col: d.col + d.dir, row: d.row, dir: d.dir }))
        .filter((d) => d.col >= 0 && d.col < COLS)
      const maxBricks = Math.min(3, 1 + Math.floor(stage / 2))
      const maxDucks = Math.min(2, stage)
      const brickChance = 0.12
      const duckChance = 0.08
      if (bricks.length < maxBricks && Math.random() < brickChance) {
        const col = randInt(0, COLS - 1)
        bricks.push({ col, row: 0 })
        ralphCol = col
        ralphThrowUntil = t + 700
      }
      if (ducks.length < maxDucks && Math.random() < duckChance) {
        const dir = Math.random() < 0.5 ? 1 : -1
        ducks.push({
          col: dir > 0 ? 0 : COLS - 1,
          row: randInt(0, ROWS - 1),
          dir,
        })
      }
      if (!pie && t - lastPieAt > 12000 && Math.random() < 0.06) {
        pie = { col: randInt(0, COLS - 1), row: randInt(0, ROWS - 1) }
      }
      checkHits(t)
      if (matchOver()) over = true
    }
    if (stepped || over) sendWorld()
  }

  function applyWorld(data: WorldMsg): void {
    if (!data || !Array.isArray(data.windows)) return
    windows = data.windows
    bricks = Array.isArray(data.bricks) ? data.bricks : []
    ducks = Array.isArray(data.ducks) ? data.ducks : []
    pie = data.pie ?? null
    stage = data.stage
    over = data.over
    started = Boolean(data.started)
    const t = nowMs()
    for (const np of data.players) {
      const p = simOf(np.id)
      p.col = np.col
      p.row = np.row
      p.lives = np.lives
      p.score = np.score
      p.immuneUntil = np.immune ? t + 200 : t
      p.berserkUntil = np.berserk ? t + 200 : t
    }
    world = data
  }

  function refreshPeerCount(): void {
    peerCountEl.textContent = String(peers.size)
  }

  function greetPeer(peerId: string): void {
    peers.add(peerId)
    peerJoined = true
    refreshPeerCount()
    helloAction.send({ name: myName }, { target: peerId })
    posAction.send({ col: localCol, row: localRow }, { target: peerId })
    if (isHost) beginMatch(nowMs())
  }

  room.onPeerJoin = (peerId) => {
    greetPeer(peerId)
  }

  room.onPeerLeave = (peerId) => {
    peers.delete(peerId)
    refreshPeerCount()
    if (peers.size === 0 && isHost && !over) pauseMatch()
  }

  helloAction.onMessage = (data, context) => {
    peers.add(context.peerId)
    refreshPeerCount()
    peerJoined = true
    if (data && data.name) {
      if (isHost) peerP.name = data.name
      else hostP.name = data.name
    }
  }

  posAction.onMessage = (data, context) => {
    if (!data) return
    peers.add(context.peerId)
    if (!isHost) return
    const p = peerP
    if (p.lives <= 0 || over) return
    p.col = clamp(Math.round(data.col), 0, COLS - 1)
    p.row = clamp(Math.round(data.row), 0, ROWS - 1)
    maybePie(p, nowMs())
  }

  hammerAction.onMessage = (data, context) => {
    if (!isHost || !data) return
    peers.add(context.peerId)
    applyHammer(peerP, data.col, data.row, nowMs())
  }

  worldAction.onMessage = (data) => {
    if (isHost || !data) return
    applyWorld(data)
  }

  if (typeof room.getPeers === 'function') {
    const existing = room.getPeers() || {}
    const ids = Array.isArray(existing) ? existing : Object.keys(existing)
    for (const peerId of ids) greetPeer(peerId)
  }

  function tryMove(): void {
    const me = simOf(myId)
    if (over || me.lives <= 0) return
    const t = nowMs()
    if (t - lastMoveAt < MOVE_MS) return
    let dc = 0
    let dr = 0
    if (k.isKeyDown('left') || k.isKeyDown('a')) dc -= 1
    if (k.isKeyDown('right') || k.isKeyDown('d')) dc += 1
    if (k.isKeyDown('up') || k.isKeyDown('w')) dr -= 1
    if (k.isKeyDown('down') || k.isKeyDown('s')) dr += 1
    if (dc && dr) dr = 0
    if (!dc && !dr) return
    lastMoveAt = t
    me.lastStepAt = t
    localCol = clamp(localCol + dc, 0, COLS - 1)
    localRow = clamp(localRow + dr, 0, ROWS - 1)
    me.col = localCol
    me.row = localRow
    posAction.send({ col: localCol, row: localRow })
    if (isHost) maybePie(me, t)
  }

  function tryHammer(): void {
    const me = simOf(myId)
    if (!started || over || me.lives <= 0) return
    const t = nowMs()
    me.swingUntil = t + 180
    hammerAction.send({ col: localCol, row: localRow })
    if (isHost) applyHammer(me, localCol, localRow, t)
  }

  k.onKeyPress('space', tryHammer)
  k.onKeyPress('j', tryHammer)

  const WIN_W = 50
  const WIN_H = 86
  const WIN_X = [101, 165, 229, 293, 357]
  const WIN_Y = [140, 248, 356]
  const cellW = 64
  const cellH = 108
  let ralphCol = 2
  let ralphThrowUntil = 0
  let ralphDir = 1

  function cellXY(col: number, row: number): { x: number; y: number } {
    return { x: WIN_X[col] ?? WIN_X[0], y: WIN_Y[row] ?? WIN_Y[0] }
  }

  function setHud(id: string, text: string): void {
    const el = document.getElementById(id)
    if (el) el.textContent = text
  }

  function paintHud(): void {
    const t = nowMs()
    const you = simOf(myId)
    const other = simOf(myId === 'host' ? 'peer' : 'host')
    setHud('youName', you.name)
    setHud('youScore', String(you.score))
    setHud('youLives', String(you.lives))
    setHud('peerName', other.name)
    setHud('peerScore', String(other.score))
    setHud('peerLives', String(other.lives))
    void t
  }

  function sheetQuad(x: number, y: number, w: number, h: number) {
    return k.quad(x / SHEET_W, y / SHEET_H, w / SHEET_W, h / SHEET_H)
  }

  function blitSheet(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    posX: number,
    posY: number,
    dw: number,
    dh: number,
    opacity: number,
    flipX = false,
  ): boolean {
    if (!sheetOk) return false
    k.drawSprite({
      sprite: 'felixSheet',
      pos: k.vec2(posX, posY),
      quad: sheetQuad(sx, sy, sw, sh),
      width: dw,
      height: dh,
      opacity,
      flipX,
    })
    return true
  }

  function drawBuilding(): void {
    if (mapaOk) {
      k.drawSprite({
        sprite: 'mapa',
        pos: k.vec2(0, 0),
        width: WIDTH,
        height: STAGE_H,
        quad: k.quad(0, 325 / MAPA_H, 506 / MAPA_W, 448 / MAPA_H),
      })
      return
    }
    k.drawRect({
      pos: k.vec2(0, 0),
      width: WIDTH,
      height: STAGE_H,
      color: hexColor('#1a2230'),
    })
  }

  function drawWindows(): void {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const st = windows[r]?.[c] ?? 0
        if (st === 0) continue
        const { x, y } = cellXY(c, r)
        const sx = st === 2 ? 356 : 306
        if (!blitSheet(sx, 120, 50, 86, x, y, WIN_W, WIN_H, 1)) {
          k.drawRect({
            pos: k.vec2(x, y),
            width: WIN_W,
            height: WIN_H,
            color: hexColor(st === 2 ? '#141820' : '#6a8aa8'),
          })
        }
      }
    }
  }

  function drawRalph(t: number): void {
    const throwing = t < ralphThrowUntil
    const { x } = cellXY(ralphCol, 0)
    let sx = 0
    let sy = 169
    let sw = 87
    let sh = 104
    if (throwing) {
      const fra = Math.floor(t / 140) % 2
      sx = fra === 0 ? 372 : 240
      sy = 206
      sw = 132
      sh = 116
    }
    const px = x + WIN_W / 2 - sw / 2
    const py = 18
    blitSheet(sx, sy, sw, sh, px, py, sw, sh, 1)
  }

  function drawFelix(p: SimPlayer, color: string, t: number): void {
    const { x, y } = cellXY(p.col, p.row)
    const blinking = t < p.immuneUntil && Math.floor(t / 120) % 2 === 0
    const opacity = p.lives <= 0 ? 0.25 : blinking ? 0.35 : 1
    const sheL = p.id === 'peer' ? 65 : 0
    let sx = 0
    let sw = 29
    if (t < p.swingUntil) {
      if (p.swingUntil - t < 90) {
        sx = 117
        sw = 56
      } else {
        sx = 69
        sw = 48
      }
    } else if (t - p.lastStepAt < 220) {
      sx = 29
      sw = 40
    }
    const dh = 65
    const dw = sw
    const px = x + (WIN_W - dw) / 2
    const py = y + WIN_H - dh
    if (!blitSheet(sx, sheL, sw, 65, px, py, dw, dh, opacity)) {
      k.drawRect({
        pos: k.vec2(px, py),
        width: dw,
        height: dh,
        color: hexColor(color),
        opacity,
      })
    }
  }

  function drawHazards(): void {
    for (const b of bricks) {
      const { x, y } = cellXY(b.col, b.row)
      const dw = 28
      const dh = 22
      if (!blitSheet(173, 0, 20, 16, x + (cellW - dw) / 2, y + 10, dw, dh, 1)) {
        k.drawRect({
          pos: k.vec2(x + cellW * 0.3, y + 8),
          width: cellW * 0.4,
          height: 14,
          color: hexColor('#8a3b24'),
        })
      }
    }
    for (const d of ducks) {
      const { x, y } = cellXY(d.col, d.row)
      const fra = Math.floor(nowMs() / 180) % 2 === 0 ? 0 : 42
      const dw = 42
      const dh = 38
      const px = x + (cellW - dw) / 2
      if (!blitSheet(fra, 131, 42, 38, px, y + 8, dw, dh, 1, d.dir < 0)) {
        k.drawCircle({
          pos: k.vec2(x + cellW * 0.5, y + 18),
          radius: 8,
          color: hexColor('#d6c24a'),
          anchor: 'center',
        })
      }
    }
    if (pie) {
      const { x, y } = cellXY(pie.col, pie.row)
      const dw = 28
      const dh = 24
      if (!blitSheet(173, 134, 24, 20, x + (cellW - dw) / 2, y + cellH * 0.45, dw, dh, 1)) {
        k.drawCircle({
          pos: k.vec2(x + cellW * 0.5, y + cellH * 0.55),
          radius: 9,
          color: hexColor('#e8c07a'),
          anchor: 'center',
        })
      }
    }
  }

  function drawHudCanvas(): void {
    blitSheet(0, 660, 506, 78, 0, HUD_Y, WIDTH, HUD_H, 1)
    const gold = hexColor('#feef33')
    for (let i = 0; i < hostP.lives; i++) {
      blitSheet(213, 36, 20, 13, 138 + i * 21, 504, 20, 13, 1)
    }
    for (let i = 0; i < peerP.lives; i++) {
      blitSheet(213, 49, 20, 13, 354 + i * 21, 504, 20, 13, 1)
    }
    k.drawText({
      text: String(hostP.score),
      pos: k.vec2(90, 468),
      size: 15,
      color: gold,
    })
    k.drawText({
      text: hostP.name,
      pos: k.vec2(138, 485),
      size: 13,
      color: gold,
    })
    k.drawText({
      text: String(peerP.score),
      pos: k.vec2(306, 468),
      size: 15,
      color: gold,
    })
    k.drawText({
      text: peerP.name,
      pos: k.vec2(354, 485),
      size: 13,
      color: gold,
    })
    k.drawText({
      text: 'STAGE ' + String(stage),
      pos: k.vec2(0, 8),
      size: 14,
      align: 'center',
      width: WIDTH,
      color: hexColor('#f2d36b'),
    })
    if (!started && !over) {
      k.drawRect({
        pos: k.vec2(0, 0),
        width: WIDTH,
        height: HEIGHT,
        color: hexColor('#000000'),
        opacity: 0.45,
      })
      k.drawText({
        text: 'WAITING FOR PLAYER',
        pos: k.vec2(0, HEIGHT / 2 - 36),
        size: 22,
        align: 'center',
        width: WIDTH,
        color: hexColor('#f2d36b'),
      })
      k.drawText({
        text: 'CODE  ' + roomCode.toUpperCase(),
        pos: k.vec2(0, HEIGHT / 2),
        size: 18,
        align: 'center',
        width: WIDTH,
        color: hexColor('#e7e9ee'),
      })
    }
    if (over) {
      k.drawRect({
        pos: k.vec2(0, 0),
        width: WIDTH,
        height: HEIGHT,
        color: hexColor('#000000'),
        opacity: 0.55,
      })
      k.drawText({
        text: 'GAME OVER',
        pos: k.vec2(0, HEIGHT / 2 - 40),
        size: 28,
        align: 'center',
        width: WIDTH,
        color: hexColor('#f2555a'),
      })
      k.drawText({
        text: `${hostP.name}: ${hostP.score}    ${peerP.name}: ${peerP.score}`,
        pos: k.vec2(0, HEIGHT / 2),
        size: 14,
        align: 'center',
        width: WIDTH,
        color: hexColor('#e7e9ee'),
      })
      k.drawText({
        text: 'Refresh for a new room',
        pos: k.vec2(0, HEIGHT / 2 + 28),
        size: 12,
        align: 'center',
        width: WIDTH,
        color: hexColor('#7c8394'),
      })
    }
  }

  k.onUpdate(() => {
    tryMove()
    if (isHost) tickHost(k.dt())
    paintHud()
  })

  k.onDraw(() => {
    const t = nowMs()
    drawBuilding()
    drawWindows()
    drawRalph(t)
    drawHazards()
    drawFelix(hostP, HOST_COLOR, t)
    drawFelix(peerP, JOIN_COLOR, t)
    drawHudCanvas()
  })

  if (isHost) sendWorld()
}
