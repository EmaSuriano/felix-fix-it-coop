import kaplay from 'kaplay'
import type { Room } from '@trystero-p2p/mqtt'
import {
  WIDTH,
  HEIGHT,
  GRID_COLS,
  GRID_ROWS,
  HOST_COLOR,
  JOIN_COLOR,
} from './config'

const ROWS = GRID_ROWS
const COLS = GRID_COLS
const MOVE_MS = 150
const TICK_S = 0.1
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
}

export function startGame(
  room: Room,
  opts: { isHost: boolean; canvas: HTMLCanvasElement; peerCountEl: HTMLElement },
): void {
  const { isHost, canvas, peerCountEl } = opts
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
  }

  let windows = isHost ? fillStageWindows() : emptyWindows()
  let bricks: Brick[] = []
  let ducks: Duck[] = []
  let pie: Pie = null
  let stage = 1
  let over = false
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
    if (over || p.lives <= 0) return
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
    if (hostP.lives > 0) return false
    if (!peerJoined) return true
    return peerP.lives <= 0
  }

  function tickHost(dt: number): void {
    if (!isHost) return
    const t = nowMs()
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
      if (moveTick % 2 === 0) {
        bricks = bricks
          .map((b) => ({ col: b.col, row: b.row + 1 }))
          .filter((b) => b.row < ROWS)
        ducks = ducks
          .map((d) => ({ col: d.col + d.dir, row: d.row, dir: d.dir }))
          .filter((d) => d.col >= 0 && d.col < COLS)
      }
      const maxBricks = Math.min(4, 1 + Math.floor(stage / 1))
      const maxDucks = Math.min(3, stage)
      const brickChance = 0.1 + stage * 0.03
      const duckChance = 0.08 + stage * 0.03
      if (bricks.length < maxBricks && Math.random() < brickChance) {
        bricks.push({ col: randInt(0, COLS - 1), row: 0 })
      }
      if (ducks.length < maxDucks && Math.random() < duckChance) {
        const dir = Math.random() < 0.5 ? 1 : -1
        ducks.push({
          col: dir > 0 ? 0 : COLS - 1,
          row: randInt(0, ROWS - 1),
          dir,
        })
      }
      if (!pie && t - lastPieAt > 7000 && Math.random() < 0.08) {
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
    if (isHost) sendWorld()
  }

  room.onPeerJoin = (peerId) => {
    greetPeer(peerId)
  }

  room.onPeerLeave = (peerId) => {
    peers.delete(peerId)
    refreshPeerCount()
    if (peers.size === 0) peerJoined = false
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
    localCol = clamp(localCol + dc, 0, COLS - 1)
    localRow = clamp(localRow + dr, 0, ROWS - 1)
    me.col = localCol
    me.row = localRow
    posAction.send({ col: localCol, row: localRow })
    if (isHost) maybePie(me, t)
  }

  function tryHammer(): void {
    const me = simOf(myId)
    if (over || me.lives <= 0) return
    const t = nowMs()
    me.swingUntil = t + 180
    hammerAction.send({ col: localCol, row: localRow })
    if (isHost) applyHammer(me, localCol, localRow, t)
  }

  k.onKeyPress('space', tryHammer)
  k.onKeyPress('j', tryHammer)

  const PAD_X = 36
  const PAD_TOP = 44
  const PAD_BOT = 78
  const gridW = WIDTH - PAD_X * 2
  const gridH = HEIGHT - PAD_TOP - PAD_BOT
  const cellW = gridW / COLS
  const cellH = gridH / ROWS

  function cellXY(col: number, row: number): { x: number; y: number } {
    return { x: PAD_X + col * cellW, y: PAD_TOP + row * cellH }
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

  function drawBuilding(): void {
    if (mapaOk) {
      k.drawSprite({
        sprite: 'mapa',
        pos: k.vec2(0, 0),
        width: WIDTH,
        height: HEIGHT,
        quad: k.quad(0, 0, 0.5, 1),
      })
      k.drawRect({
        pos: k.vec2(0, 0),
        width: WIDTH,
        height: HEIGHT,
        color: hexColor('#10131a'),
        opacity: 0.28,
      })
      return
    }
    k.drawRect({
      pos: k.vec2(0, 0),
      width: WIDTH,
      height: HEIGHT,
      color: hexColor('#1a2230'),
    })
    k.drawRect({
      pos: k.vec2(PAD_X - 12, PAD_TOP - 12),
      width: gridW + 24,
      height: gridH + 24,
      color: hexColor('#6b2b22'),
      outline: { width: 3, color: hexColor('#3a1610') },
    })
    for (let y = PAD_TOP - 8; y < PAD_TOP + gridH + 8; y += 10) {
      k.drawRect({
        pos: k.vec2(PAD_X - 12, y),
        width: gridW + 24,
        height: 1,
        color: hexColor('#4a1e18'),
        opacity: 0.5,
      })
    }
  }

  function drawWindows(): void {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const { x, y } = cellXY(c, r)
        const insetX = 12
        const insetY = 16
        const wx = x + insetX
        const wy = y + insetY
        const ww = cellW - insetX * 2
        const wh = cellH - insetY * 2 - 6
        const st = windows[r]?.[c] ?? 0
        k.drawRect({
          pos: k.vec2(wx - 3, wy - 3),
          width: ww + 6,
          height: wh + 8,
          color: hexColor('#c9b089'),
        })
        let glass = '#9ad7ff'
        if (st === 1) glass = '#6a8aa8'
        if (st === 2) glass = '#141820'
        k.drawRect({
          pos: k.vec2(wx, wy),
          width: ww,
          height: wh,
          color: hexColor(glass),
        })
        if (st === 0) {
          k.drawRect({
            pos: k.vec2(wx + 4, wy + 4),
            width: ww * 0.35,
            height: 3,
            color: hexColor('#ffffff'),
            opacity: 0.55,
          })
        } else if (st === 1) {
          k.drawLine({
            p1: k.vec2(wx + 4, wy + 6),
            p2: k.vec2(wx + ww - 6, wy + wh - 6),
            width: 2,
            color: hexColor('#e8e0c8'),
          })
          k.drawLine({
            p1: k.vec2(wx + ww * 0.6, wy + 4),
            p2: k.vec2(wx + 8, wy + wh * 0.7),
            width: 2,
            color: hexColor('#d0c4a0'),
          })
        } else {
          k.drawRect({
            pos: k.vec2(wx + 6, wy + 8),
            width: ww - 12,
            height: wh - 14,
            color: hexColor('#05070c'),
          })
        }
      }
    }
  }

  function drawFelix(p: SimPlayer, color: string, t: number): void {
    const { x, y } = cellXY(p.col, p.row)
    const bw = 22
    const bh = 28
    const px = x + (cellW - bw) / 2
    const py = y + cellH - bh - 10
    const blinking = t < p.immuneUntil && Math.floor(t / 120) % 2 === 0
    const opacity = p.lives <= 0 ? 0.25 : blinking ? 0.35 : 1
    const outlineCol = t < p.berserkUntil ? hexColor('#ffe566') : hexColor('#0d1016')
    k.drawRect({
      pos: k.vec2(px, py),
      width: bw,
      height: bh,
      color: hexColor(color),
      opacity,
      outline: { width: 2, color: outlineCol },
    })
    k.drawRect({
      pos: k.vec2(px + 5, py + 4),
      width: 12,
      height: 6,
      color: hexColor('#f3d2b0'),
      opacity,
    })
    const swing = t < p.swingUntil
    const hx = swing ? px + bw - 2 : px + bw + 1
    const hy = swing ? py + 4 : py + 10
    k.drawRect({
      pos: k.vec2(hx, hy),
      width: 10,
      height: 5,
      color: hexColor('#f0c14a'),
      opacity,
    })
  }

  function drawHazards(): void {
    for (const b of bricks) {
      const { x, y } = cellXY(b.col, b.row)
      k.drawRect({
        pos: k.vec2(x + cellW * 0.3, y + 8),
        width: cellW * 0.4,
        height: 14,
        color: hexColor('#8a3b24'),
        outline: { width: 1, color: hexColor('#3a1510') },
      })
    }
    for (const d of ducks) {
      const { x, y } = cellXY(d.col, d.row)
      const cx = x + cellW * 0.5
      const cy = y + 18
      k.drawCircle({
        pos: k.vec2(cx, cy),
        radius: 8,
        color: hexColor('#d6c24a'),
        anchor: 'center',
      })
      k.drawRect({
        pos: k.vec2(cx + (d.dir >= 0 ? 6 : -12), cy - 2),
        width: 8,
        height: 4,
        color: hexColor('#e07020'),
      })
    }
    if (pie) {
      const { x, y } = cellXY(pie.col, pie.row)
      k.drawCircle({
        pos: k.vec2(x + cellW * 0.5, y + cellH * 0.55),
        radius: 9,
        color: hexColor('#e8c07a'),
        anchor: 'center',
      })
      k.drawCircle({
        pos: k.vec2(x + cellW * 0.5, y + cellH * 0.52),
        radius: 6,
        color: hexColor('#c44c3a'),
        anchor: 'center',
      })
    }
  }

  function drawHudCanvas(): void {
    k.drawText({
      text: `STAGE ${stage}`,
      pos: k.vec2(0, 8),
      size: 16,
      align: 'center',
      width: WIDTH,
      color: hexColor('#f2d36b'),
    })
    const y = HEIGHT - 62
    k.drawRect({
      pos: k.vec2(8, y),
      width: WIDTH - 16,
      height: 54,
      color: hexColor('#0d1016'),
      opacity: 0.82,
      outline: { width: 2, color: hexColor('#f2d36b') },
    })
    k.drawText({
      text: `${hostP.name}  ${hostP.score}   lives ${hostP.lives}${nowMs() < hostP.berserkUntil ? '  BERSERK' : ''}`,
      pos: k.vec2(16, y + 8),
      size: 12,
      color: hexColor(HOST_COLOR),
    })
    k.drawText({
      text: `${peerP.name}  ${peerP.score}   lives ${peerP.lives}${nowMs() < peerP.berserkUntil ? '  BERSERK' : ''}`,
      pos: k.vec2(16, y + 28),
      size: 12,
      color: hexColor(JOIN_COLOR),
    })
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
    void sheetOk
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
    drawHazards()
    drawFelix(hostP, HOST_COLOR, t)
    drawFelix(peerP, JOIN_COLOR, t)
    drawHudCanvas()
  })

  if (isHost) sendWorld()
}
