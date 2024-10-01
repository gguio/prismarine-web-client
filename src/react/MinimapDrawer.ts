import { Vec3 } from 'vec3'
import { TypedEventEmitter } from 'contro-max/build/typedEventEmitter'
import { WorldWarp } from 'flying-squid/dist/lib/modules/warps'
import { Chunk } from 'prismarine-world/types/world'

export type MapUpdates = {
  updateBlockColor: (pos: Vec3) => void
  updatePlayerPosition: () => void
  updateWarps: () => void
}

export interface DrawerAdapter extends TypedEventEmitter<MapUpdates> {
  getHighestBlockColor: (x: number, z: number, full?: boolean) => Promise<string>
  getHighestBlockY: (x: number, z: number, chunk?: Chunk) => number
  clearChunksStore: (x: number, z: number) => void
  chunksStore: Record<string, Chunk | null | 'unavailable'>
  playerPosition: Vec3
  warps: WorldWarp[]
  world?: string
  yaw: number
  setWarp: (warp: WorldWarp, remove?: boolean) => void
  quickTp?: (x: number, z: number) => void
  loadChunk: (chunkX: number, chunkZ: number) => Promise<void>
}

export type ChunkInfo = {
  heightmap: Uint8Array,
  colors: string[],
}

export class MinimapDrawer {
  canvasWidthCenterX: number
  canvasWidthCenterY: number
  _mapSize: number
  radius: number
  ctx: CanvasRenderingContext2D
  _canvas: HTMLCanvasElement
  worldColors: { [key: string]: string } = {}
  chunksStore = new Map<string, undefined | null | 'requested' | ChunkInfo >()
  chunksInView = new Set<string>()
  lastBotPos: Vec3
  lastWarpPos: Vec3
  mapPixel: number
  updatingPixels: Set<string>
  _full = false

  constructor (
    canvas: HTMLCanvasElement,
    public adapter: DrawerAdapter
  ) {
    this.canvas = canvas
    this.adapter = adapter
    this.updatingPixels = new Set([] as string[])
  }

  get full () {
    return this._full
  }

  set full (full: boolean) {
    this._full = full
    this.radius = Math.floor(Math.min(this.canvas.width, this.canvas.height) / 2)
    this._mapSize = 16
    this.mapPixel = Math.floor(this.radius * 2 / this.mapSize)
  }

  get canvas () {
    return this._canvas
  }

  set canvas (canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!
    this.ctx.imageSmoothingEnabled = false
    this.radius = Math.floor(Math.min(canvas.width, canvas.height) / 2.2)
    this._mapSize = this.radius * 2
    this.mapPixel = Math.floor(this.radius * 2 / this.mapSize)
    this.canvasWidthCenterX = canvas.width / 2
    this.canvasWidthCenterY = canvas.height / 2
    this._canvas = canvas
  }

  get mapSize () {
    return this._mapSize
  }

  set mapSize (mapSize: number) {
    this._mapSize = mapSize
    this.mapPixel = Math.floor(this.radius * 2 / this.mapSize)
    this.draw(this.lastBotPos)
  }

  draw (botPos: Vec3,) {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)

    this.lastBotPos = botPos
    this.updateChunksInView()
    for (const key of this.chunksInView) {
      if (!this.chunksStore.has(key)) {
        const [chunkX, chunkZ] = key.split(',').map(Number)
        void this.adapter.loadChunk(chunkX, chunkZ)
        this.chunksStore.set(key, 'requested')
      }
      this.drawChunk(key)
    }
    if (!this.full) this.drawPartsOfWorld()
  }

  updateChunksInView (viewX?: number, viewZ?: number) {
    const worldCenterX = viewX ?? this.lastBotPos.x
    const worldCenterZ = viewZ ?? this.lastBotPos.z

    const radius = this.mapSize / 2
    const leftViewBorder = Math.floor((worldCenterX - radius) / 16) - 1
    const rightViewBorder = Math.ceil((worldCenterX + radius) / 16)
    const topViewBorder = Math.floor((worldCenterZ - radius) / 16) - 1
    const bottomViewBorder = Math.ceil((worldCenterZ + radius) / 16)

    this.chunksInView.clear()
    for (let i = topViewBorder; i <= bottomViewBorder; i += 1) {
      for (let j = leftViewBorder; j <= rightViewBorder; j += 1) {
        this.chunksInView.add(`${j},${i}`)
      }
    }
  }

  drawChunk (key: string) {
    const [chunkX, chunkZ] = key.split(',').map(Number)
    const chunkWorldX = chunkX * 16
    const chunkWorldZ = chunkZ * 16
    const chunkCanvasX = Math.floor((chunkWorldX - this.lastBotPos.x) * this.mapPixel + this.canvasWidthCenterX)
    const chunkCanvasY = Math.floor((chunkWorldZ - this.lastBotPos.z) * this.mapPixel + this.canvasWidthCenterY)
    const chunk = this.chunksStore.get(key)
    if (typeof chunk !== 'object') {
      const chunkSize = this.mapPixel * 16
      this.ctx.fillStyle = chunk === 'requested' ? 'rgb(200, 200, 200)' : 'rgba(0, 0, 0, 0.5)'
      this.ctx.fillRect(chunkCanvasX, chunkCanvasY, chunkSize, chunkSize)
      return
    }
    for (let row = 0; row < 16; row += 1) {
      for (let col = 0; col < 16; col += 1) {
        const index = row * 16 + col
        const color = chunk?.colors[index] ?? 'rgb(255, 0, 0)'
        const pixelX = chunkCanvasX + this.mapPixel * col
        const pixelY = chunkCanvasY + this.mapPixel * row
        this.drawPixel(pixelX, pixelY, color)
      }
    }
  }

  clearRect (full?: boolean) {
    if (full) {
      this.radius = Math.floor(Math.min(this.canvas.width, this.canvas.height) / 2)
      this._mapSize = this.radius * 2
      this.mapPixel = Math.floor(this.radius * 2 / this.mapSize)
    }
    this.ctx.clearRect(
      this.canvasWidthCenterX - this.canvas.width,
      this.canvasWidthCenterY - this.canvas.height,
      this.canvas.width * 2,
      this.canvas.height * 2
    )
  }

  async updateWorldColors (
    getHighestBlockColor: DrawerAdapter['getHighestBlockColor'],
    x: number,
    z: number,
    full?: boolean
  ) {
    if (this.adapter.chunksStore[`${Math.floor(x / 16) * 16},${Math.floor(z / 16) * 16}`] === null) return

    for (let row = 0; row < this.mapSize; row += 1) {
      for (let col = 0; col < this.mapSize; col += 1) {
        // void this.drawPixel(x, z, col, row)
      }
    }
  }

  drawPixel (pixelX: number, pixelY: number, color: string) {
    // if (!this.full && Math.hypot(pixelX - this.canvasWidthCenterX, pixelY - this.canvasWidthCenterY) > this.radius) {
    //   this.ctx.clearRect(pixelX, pixelY, this.mapPixel, this.mapPixel)
    //   return
    // }
    this.ctx.fillStyle = color
    this.ctx.fillRect(
      pixelX,
      pixelY,
      this.mapPixel,
      this.mapPixel
    )
    if (this.full) {
      // this.drawPlayerPos(x, z)
      // const lastPixel = this.mapSize - 1
      // if (col === lastPixel && row === lastPixel) this.drawWarps(new Vec3(x, 0, z), this.full)
    }
  }

  getDistance (x1: number, z1: number, x2: number, z2: number): number {
    return Math.hypot((x2 - x1), (z2 - z1))
  }

  deleteOldWorldColors (currX: number, currZ: number) {
    for (const key of Object.keys(this.worldColors)) {
      const [x, z] = key.split(',').map(Number)
      if (this.getDistance(x, z, currX, currZ) > this.radius * 5) {

        delete this.worldColors[`${x},${z}`]
      }
    }
  }

  setWarpPosOnClick (mousePos: Vec3) {
    this.lastWarpPos = new Vec3(mousePos.x, mousePos.y, mousePos.z)
  }

  drawWarps (centerPos?: Vec3, full?: boolean) {
    for (const warp of this.adapter.warps) {
      if (!full) {
        const distance = this.getDistance(
          centerPos?.x ?? this.adapter.playerPosition.x,
          centerPos?.z ?? this.adapter.playerPosition.z,
          warp.x,
          warp.z
        )
        if (distance > this.mapSize) continue
      }
      const offset = full ? 0 : this.radius * 0.2
      const z = Math.floor(
        (this.mapSize / 2 - (centerPos?.z ?? this.adapter.playerPosition.z) + warp.z) * this.mapPixel
      ) + offset
      const x = Math.floor(
        (this.mapSize / 2 - (centerPos?.x ?? this.adapter.playerPosition.x) + warp.x) * this.mapPixel
      ) + offset
      const dz = z - this.canvasWidthCenterX
      const dx = x - this.canvasWidthCenterY
      const circleDist = Math.hypot(dx, dz)

      const angle = Math.atan2(dz, dx)
      const circleZ = circleDist > this.mapSize / 2 && !full ?
        this.canvasWidthCenterX + this.mapSize / 2 * Math.sin(angle)
        : z
      const circleX = circleDist > this.mapSize / 2 && !full ?
        this.canvasWidthCenterY + this.mapSize / 2 * Math.cos(angle)
        : x
      this.ctx.beginPath()
      this.ctx.arc(
        circleX,
        circleZ,
        circleDist > this.mapSize / 2 && !full
          ? this.mapPixel * 1.5
          : full ? this.mapPixel : this.mapPixel * 2,
        0,
        Math.PI * 2,
        false
      )
      this.ctx.strokeStyle = 'black'
      this.ctx.lineWidth = this.mapPixel
      this.ctx.stroke()
      this.ctx.fillStyle = warp.disabled ? 'rgba(255, 255, 255, 0.4)' : warp.color ?? '#d3d3d3'
      this.ctx.fill()
      this.ctx.closePath()
    }
  }

  drawPartsOfWorld () {
    this.ctx.fillStyle = 'white'
    this.ctx.shadowOffsetX = 1
    this.ctx.shadowOffsetY = 1
    this.ctx.shadowColor = 'black'
    this.ctx.font = `${this.radius / 4}px serif`
    this.ctx.textAlign = 'center'
    this.ctx.textBaseline = 'middle'
    this.ctx.strokeStyle = 'black'
    this.ctx.lineWidth = 1

    const angle = - Math.PI / 2
    const angleS = angle + Math.PI
    const angleW = angle + Math.PI * 3 / 2
    const angleE = angle + Math.PI / 2

    this.ctx.strokeText(
      'N',
      this.canvasWidthCenterX + this.radius * Math.cos(angle),
      this.canvasWidthCenterY + this.radius * Math.sin(angle)
    )
    this.ctx.strokeText(
      'S',
      this.canvasWidthCenterX + this.radius * Math.cos(angleS),
      this.canvasWidthCenterY + this.radius * Math.sin(angleS)
    )
    this.ctx.strokeText(
      'W',
      this.canvasWidthCenterX + this.radius * Math.cos(angleW),
      this.canvasWidthCenterY + this.radius * Math.sin(angleW)
    )
    this.ctx.strokeText(
      'E',
      this.canvasWidthCenterX + this.radius * Math.cos(angleE),
      this.canvasWidthCenterY + this.radius * Math.sin(angleE)
    )
    this.ctx.fillText(
      'N',
      this.canvasWidthCenterX + this.radius * Math.cos(angle),
      this.canvasWidthCenterY + this.radius * Math.sin(angle)
    )
    this.ctx.fillText(
      'S',
      this.canvasWidthCenterX + this.radius * Math.cos(angleS),
      this.canvasWidthCenterY + this.radius * Math.sin(angleS)
    )
    this.ctx.fillText(
      'W',
      this.canvasWidthCenterX + this.radius * Math.cos(angleW),
      this.canvasWidthCenterY + this.radius * Math.sin(angleW)
    )
    this.ctx.fillText(
      'E',
      this.canvasWidthCenterX + this.radius * Math.cos(angleE),
      this.canvasWidthCenterY + this.radius * Math.sin(angleE)
    )

    this.ctx.shadowOffsetX = 0
    this.ctx.shadowOffsetY = 0
  }

  drawPlayerPos (canvasWidthCenterX?: number, centerZ?: number, disableTurn?: boolean) {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)

    const x = (this.adapter.playerPosition.x - (canvasWidthCenterX ?? this.adapter.playerPosition.x)) * this.mapPixel
    const z = (this.adapter.playerPosition.z - (centerZ ?? this.adapter.playerPosition.z)) * this.mapPixel
    const center = this.mapSize / 2 * this.mapPixel + (this.full ? 0 : this.radius * 0.1)
    this.ctx.translate(center + x, center + z)
    if (!disableTurn) this.ctx.rotate(-this.adapter.yaw)

    const size = 3
    const factor = this.full ? 2 : 1
    const width = size * factor
    const height = size * factor

    this.ctx.beginPath()
    this.ctx.moveTo(0, -height)
    this.ctx.lineTo(-width, height)
    this.ctx.lineTo(width, height)
    this.ctx.closePath()

    this.ctx.strokeStyle = '#000000'
    this.ctx.lineWidth = this.full ? 2 : 1
    this.ctx.stroke()
    this.ctx.fillStyle = '#FFFFFF'
    this.ctx.fill()

    // Reset transformations
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  rotateMap (angle: number) {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.translate(this.canvasWidthCenterX, this.canvasWidthCenterY)
    this.ctx.rotate(angle)
    this.ctx.translate(-this.canvasWidthCenterX, -this.canvasWidthCenterY)
  }
}
