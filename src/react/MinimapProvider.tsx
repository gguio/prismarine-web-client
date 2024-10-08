import { useEffect, useState } from 'react'
import { versions } from 'minecraft-data'
import { simplify } from 'prismarine-nbt'
import RegionFile from 'prismarine-provider-anvil/src/region'
import { Vec3 } from 'vec3'
import { versionToNumber } from 'prismarine-viewer/viewer/prepare/utils'
import { WorldWarp } from 'flying-squid/dist/lib/modules/warps'
import { TypedEventEmitter } from 'contro-max/build/typedEventEmitter'
import { PCChunk } from 'prismarine-chunk'
import { Chunk } from 'prismarine-world/types/world'
import { INVISIBLE_BLOCKS } from 'prismarine-viewer/viewer/lib/mesher/worldConstants'
import { getRenamedData } from 'flying-squid/dist/blockRenames'
import { useSnapshot } from 'valtio'
import BlockData from '../../prismarine-viewer/viewer/lib/moreBlockDataGenerated.json'
import preflatMap from '../preflatMap.json'
import { contro } from '../controls'
import { gameAdditionalState, showModal, hideModal, miscUiState, loadedGameState, activeModalStack } from '../globalState'
import { options } from '../optionsStorage'
import Minimap, { DisplayMode } from './Minimap'
import { ChunkInfo, DrawerAdapter, MapUpdates } from './MinimapDrawer'
import { useIsModalActive } from './utilsApp'

const getBlockKey = (x: number, z: number) => {
  return `${x},${z}`
}

const findHeightMap = (obj: any): any => {
  function search (obj: any): any | undefined {
    for (const key in obj) {
      if (['heightmap', 'heightmaps'].includes(key.toLowerCase())) {
        return obj[key]
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        const result = search(obj[key])
        if (result !== undefined) {
          return result
        }
      }
    }
  }
  return search(obj)
}

export class DrawerAdapterImpl extends TypedEventEmitter<MapUpdates> implements DrawerAdapter {
  playerPosition: Vec3
  yaw: number
  warps: WorldWarp[]
  world: string
  chunksStore = new Map<string, undefined | null | 'requested' | ChunkInfo >()
  loadingChunksQueue = new Set<string>()
  currChunk: PCChunk | undefined
  currChunkPos: { x: number, z: number } = { x: 0, z: 0 }
  isOldVersion: boolean
  blockData: any
  heightMap: Record<string, number> = {}
  regions: Record<string, RegionFile> = {}
  chunksHeightmaps: Record<string, any> = {}
  loadChunk: (key: string) => Promise<void>
  _full: boolean

  constructor (pos?: Vec3) {
    super()
    this.full = false
    this.playerPosition = pos ?? new Vec3(0, 0, 0)
    this.warps = gameAdditionalState.warps
    // if (localServer) {
    //   this.overwriteWarps(localServer.warps)
    //   this.on('cellReady', (key: string) => {
    //     if (this.loadingChunksQueue.size === 0) return
    //     const [x, z] = this.loadingChunksQueue.values().next().value.split(',').map(Number)
    //     this.loadChunk(x, z)
    //     this.loadingChunksQueue.delete(`${x},${z}`)
    //   })
    // } else {
    //   const storageWarps = localStorage.getItem(`warps: ${loadedGameState.username} ${loadedGameState.serverIp ?? ''}`)
    //   this.overwriteWarps(JSON.parse(storageWarps ?? '[]'))
    // }
    this.isOldVersion = versionToNumber(bot.version) < versionToNumber('1.13')
    this.blockData = {}
    for (const blockKey of Object.keys(BlockData.colors)) {
      const renamedKey = getRenamedData('blocks', blockKey, '1.20.2', bot.version)
      this.blockData[renamedKey as string] = BlockData.colors[blockKey]
    }

    viewer.world?.renderUpdateEmitter.on('chunkFinished', (key) => {
      if (!this.loadingChunksQueue.has(key)) return
      void this.loadChunk(key)
      this.loadingChunksQueue.delete(key)
    })
  }

  get full () {
    return this._full
  }

  set full (full: boolean) {
    if (full) {
      this.loadChunk = this.loadChunkFullmap
    } else {
      console.log('this is minimap')
      this.loadChunk = this.loadChunkMinimap
    }
    this._full = full
  }

  overwriteWarps (newWarps: WorldWarp[]) {
    this.warps.splice(0, this.warps.length)
    for (const warp of newWarps) {
      this.warps.push({ ...warp })
    }
  }

  async getChunkHeightMapFromRegion (chunkX: number, chunkZ: number, cb?: (hm: number[]) => void) {
    const regionX = Math.floor(chunkX / 32)
    const regionZ = Math.floor(chunkZ / 32)
    const { worldFolder } = localServer!.options
    const path = `${worldFolder}/region/r.${regionX}.${regionZ}.mca`
    if (!this.regions[`${regionX},${regionZ}`]) {
      const region = new RegionFile(path)
      await region.initialize()
      this.regions[`${regionX},${regionZ}`] = region
    }
    const rawChunk = await this.regions[`${regionX},${regionZ}`].read(chunkX - regionX * 32, chunkZ - regionZ * 32)
    const chunk = simplify(rawChunk as any)
    console.log(`chunk ${chunkX}, ${chunkZ}:`, chunk)
    const heightmap = findHeightMap(chunk)
    console.log(`heightmap ${chunkX}, ${chunkZ}:`, heightmap)
    this.chunksHeightmaps[`${chunkX * 16},${chunkZ * 16}`] = heightmap
    cb?.(heightmap)
  }

  setWarp (warp: WorldWarp, remove?: boolean): void {
    this.world = bot.game.dimension
    const index = this.warps.findIndex(w => w.name === warp.name)
    if (index === -1) {
      this.warps.push(warp)
    } else if (remove && index !== -1) {
      this.warps.splice(index, 1)
    } else {
      this.warps[index] = warp
    }
    if (localServer) {
      // type suppressed until server is updated. It works fine
      void (localServer as any).setWarp(warp, remove)
    } else if (remove) {
      localStorage.removeItem(`warps: ${loadedGameState.username} ${loadedGameState.serverIp}`)
    } else {
      localStorage.setItem(`warps: ${loadedGameState.username} ${loadedGameState.serverIp}`, JSON.stringify(this.warps))
    }
    this.emit('updateWarps')
  }

  getHighestBlockY (x: number, z: number, chunk?: Chunk) {
    const chunkX = Math.floor(x / 16) * 16
    const chunkZ = Math.floor(z / 16) * 16
    if (this.chunksHeightmaps[`${chunkX},${chunkZ}`]) {
      return this.chunksHeightmaps[`${chunkX},${chunkZ}`][x - chunkX + (z - chunkZ) * 16] - 1
    }
    const source = chunk ?? bot.world
    const { height, minY } = (bot.game as any)
    for (let i = height; i > 0; i -= 1) {
      const block = source.getBlock(new Vec3(x & 15, minY + i, z & 15))
      if (block && !INVISIBLE_BLOCKS.has(block.name)) {
        return minY + i
      }
    }
    return minY
  }

  async getChunkSingleplayer (chunkX: number, chunkZ: number) {
    // absolute coords
    const region = (localServer!.overworld.storageProvider as any).getRegion(chunkX * 16, chunkZ * 16)
    if (!region) return 'unavailable'
    const chunk = await localServer!.players[0]!.world.getColumn(chunkX, chunkZ)
    return chunk
  }

  async loadChunkMinimap (key: string) {
    // void this.getChunkHeightMapFromRegion(chunkX / 16, chunkZ / 16)
    const [chunkX, chunkZ] = key.split(',').map(Number)
    const chunkWorldX = chunkX * 16
    const chunkWorldZ = chunkZ * 16
    if (viewer.world.finishedChunks[`${chunkWorldX},${chunkWorldZ}`]) {
      const heightmap = new Uint8Array(256)
      const colors = Array.from({ length: 256 }).fill('') as string[]
      for (let z = 0; z < 16; z += 1) {
        for (let x = 0; x < 16; x += 1) {
          const block = viewer.world.highestBlocks[`${chunkWorldX + x},${chunkWorldZ + z}`]
          if (!block) {
            console.warn(`[loadChunk] ${chunkX}, ${chunkZ}, ${chunkWorldX + x}, ${chunkWorldZ + z}`)
            return
          }
          const index = z * 16 + x
          heightmap[index] = block.pos.y
          const color = this.isOldVersion ? BlockData.colors[preflatMap.blocks[`${block.type}:${block.metadata}`]?.replaceAll(/\[.*?]/g, '')] ?? 'rgb(0, 0, 255)' : this.blockData[block.name] ?? 'rgb(0, 255, 0)'
          colors[index] = color
        }
      }
      const chunk = { heightmap, colors }
      this.applyShadows(chunk)
      this.chunksStore.set(key, chunk)
      this.emit(`chunkReady`, `${chunkX},${chunkZ}`)
    } else {
      this.loadingChunksQueue.add(`${chunkX},${chunkZ}`)
      this.chunksStore.set(key, 'requested')
    }
  }

  async loadChunkFullmap (key: string) {
    // this.loadingChunksQueue.add(`${chunkX},${chunkZ}`)
    this.chunksStore.set(key, 'requested')
    const [chunkX, chunkZ] = key.split(',').map(Number)
    const chunkWorldX = chunkX * 16
    const chunkWorldZ = chunkZ * 16
    const chunkInfo = await this.getChunkSingleplayer(chunkX, chunkZ)
    if (chunkInfo === 'unavailable') {
      this.chunksStore.set(key, null)
      this.emit(`chunkReady`, key)
      return
    }
    const heightmap = new Uint8Array(256)
    const colors = Array.from({ length: 256 }).fill('') as string[]
    for (let z = 0; z < 16; z += 1) {
      for (let x = 0; x < 16; x += 1) {
        const blockX = chunkWorldX + x
        const blockZ = chunkWorldZ + z
        const blockY = this.getHighestBlockY(blockX, blockZ, chunkInfo)
        const block = chunkInfo.getBlock(new Vec3(blockX & 15, blockY, blockZ & 15))
        if (!block) {
          console.warn(`[loadChunk] ${chunkX}, ${chunkZ}, ${chunkWorldX + x}, ${chunkWorldZ + z}`)
          return
        }
        const index = z * 16 + x
        heightmap[index] = blockY
        const color = this.isOldVersion ? BlockData.colors[preflatMap.blocks[`${block.type}:${block.metadata}`]?.replaceAll(/\[.*?]/g, '')] ?? 'rgb(0, 0, 255)' : this.blockData[block.name] ?? 'rgb(0, 255, 0)'
        colors[index] = color
      }
    }
    const chunk = { heightmap, colors }
    this.applyShadows(chunk)
    this.chunksStore.set(key, chunk)
    this.emit(`chunkReady`, key)
  }

  applyShadows (chunk: ChunkInfo) {
    for (let j = 0; j < 16; j += 1) {
      for (let i = 0; i < 16; i += 1) {
        const index = j * 16 + i
        const color = chunk.colors[index]
        // if (i === 0 || j === 0 || i === 15 || j === 16) {
        //   const r = Math.floor(Math.random() * 2)
        //   chunk.colors[index] = r===0 ? this.makeDarker(color) : this.makeLighter(color)
        //   continue
        // }

        const h = chunk.heightmap[index]
        let isLighterOrDarker = 0

        const r = chunk.heightmap[index + 1] ?? 0
        const u = chunk.heightmap[index - 16] ?? 0
        const ur = chunk.heightmap[index - 15] ?? 0
        if (r > h || u > h || ur > h) {
          chunk.colors[index] = this.makeDarker(color)
          isLighterOrDarker -= 1
        }

        const l = chunk.heightmap[index - 1] ?? 0
        const d = chunk.heightmap[index + 16] ?? 0
        const dl = chunk.heightmap[index + 15] ?? 0
        if (l > h || d > h || dl > h) {
          chunk.colors[index] = this.makeLighter(color)
          isLighterOrDarker += 1
        }

        let linkedIndex: number | undefined
        if (i === 1) {
          linkedIndex = index - 1
        } else if (i === 14) {
          linkedIndex = index + 1
        } else if (j === 1) {
          linkedIndex = index - 16
        } else if (j === 14) {
          linkedIndex = index + 16
        }
        if (linkedIndex !== undefined) {
          const linkedColor = chunk.colors[linkedIndex]
          switch (isLighterOrDarker) {
            case 1:
              chunk.colors[linkedIndex] = this.makeLighter(linkedColor)
              break
            case -1:
              chunk.colors[linkedIndex] = this.makeDarker(linkedColor)
              break
            default:
              break
          }
        }
      }
    }
  }

  makeDarker (color: string) {
    let rgbArray = color.match(/\d+/g)?.map(Number) ?? []
    if (rgbArray.length !== 3) return color
    rgbArray = rgbArray.map(element => {
      let newColor = element - 20
      if (newColor < 0) newColor = 0
      return newColor
    })
    return `rgb(${rgbArray.join(',')})`
  }

  makeLighter (color: string) {
    let rgbArray = color.match(/\d+/g)?.map(Number) ?? []
    if (rgbArray.length !== 3) return color
    rgbArray = rgbArray.map(element => {
      let newColor = element + 20
      if (newColor > 255) newColor = 255
      return newColor
    })
    return `rgb(${rgbArray.join(',')})`
  }

  clearChunksStore (x: number, z: number) {
    for (const key of Object.keys(this.chunksStore)) {
      const [chunkX, chunkZ] = key.split(',').map(Number)
      if (Math.hypot((chunkX - x), (chunkZ - z)) > 300) {
        delete this.chunksStore[key]
        delete this.chunksHeightmaps[key]
        for (let i = 0; i < 16; i += 1) {
          for (let j = 0; j < 16; j += 1) {
            delete this.heightMap[`${chunkX + i},${chunkZ + j}`]
          }
        }
      }
    }
  }

  quickTp (x: number, z: number) {
    const y = this.getHighestBlockY(x, z)
    bot.chat(`/tp ${x} ${y + 20} ${z}`)
    const timeout = setTimeout(() => {
      const y = this.getHighestBlockY(x, z)
      bot.chat(`/tp ${x} ${y + 20} ${z}`)
      clearTimeout(timeout)
    }, 500)
  }
}

const Inner = (
  { displayMode, toggleFullMap }:
  {
    displayMode?: DisplayMode,
    toggleFullMap?: ({ command }: { command?: string }) => void
  }
) => {
  const [adapter] = useState(() => new DrawerAdapterImpl(bot.entity.position))

  const updateWarps = (newWarps: WorldWarp[] | Error) => {
    if (newWarps instanceof Error) {
      console.error('An error occurred:', newWarps.message)
      return
    }

    adapter.overwriteWarps(newWarps)
  }

  const updateMap = () => {
    if (!adapter) return
    adapter.playerPosition = bot.entity.position
    adapter.yaw = bot.entity.yaw
    adapter.emit('updateMap')
  }

  useEffect(() => {
    bot.on('move', updateMap)
    localServer?.on('warpsUpdated' as keyof ServerEvents, updateWarps)

    return () => {
      bot?.off('move', updateMap)
      localServer?.off('warpsUpdated' as keyof ServerEvents, updateWarps)
    }
  }, [])

  return <div>
    <Minimap
      adapter={adapter}
      showMinimap={options.showMinimap}
      showFullmap='always'
      singleplayer={miscUiState.singleplayer}
      fullMap={displayMode === 'fullmapOnly'}
      toggleFullMap={toggleFullMap}
      displayMode={displayMode}
    />
  </div>
}

export default ({ displayMode }: { displayMode?: DisplayMode }) => {
  const { showMinimap } = useSnapshot(options)
  const fullMapOpened = useIsModalActive('full-map')

  const readChunksHeightMaps = async () => {
    const { worldFolder } = localServer!.options
    const path = `${worldFolder}/region/r.0.0.mca`
    const region = new RegionFile(path)
    await region.initialize()
    const chunks: Record<string, any> = {}
    console.log('Reading chunks...')
    console.log(chunks)
    let versionDetected = false
    for (const [i, _] of Array.from({ length: 32 }).entries()) {
      for (const [k, _] of Array.from({ length: 32 }).entries()) {
        // todo, may use faster reading, but features is not commonly used
        // eslint-disable-next-line no-await-in-loop
        const nbt = await region.read(i, k)
        chunks[`${i},${k}`] = nbt
        if (nbt && !versionDetected) {
          const simplified = simplify(nbt)
          const version = versions.pc.find(x => x['dataVersion'] === simplified.DataVersion)?.minecraftVersion
          console.log('Detected version', version ?? 'unknown')
          versionDetected = true
        }
      }
    }
    Object.defineProperty(chunks, 'simplified', {
      get () {
        const mapped = {}
        for (const [i, _] of Array.from({ length: 32 }).entries()) {
          for (const [k, _] of Array.from({ length: 32 }).entries()) {
            const key = `${i},${k}`
            const chunk = chunks[key]
            if (!chunk) continue
            mapped[key] = simplify(chunk)
          }
        }
        return mapped
      },
    })
    console.log('Done!', chunks)
  }

  const toggleFullMap = ({ command }: { command?: string }) => {
    if (command === 'ui.toggleMap') {
      if (activeModalStack.at(-1)?.reactType === 'full-map') {
        hideModal({ reactType: 'full-map' })
      } else {
        showModal({ reactType: 'full-map' })
      }
    }
  }

  useEffect(() => {
    if (displayMode !== 'fullmapOnly') return
    contro?.on('trigger', toggleFullMap)
    return () => {
      contro?.off('trigger', toggleFullMap)
    }
  }, [])

  if (
    displayMode === 'minimapOnly'
      ? showMinimap === 'never' || (showMinimap === 'singleplayer' && !miscUiState.singleplayer)
      : !fullMapOpened
  ) {
    return null
  }

  return <Inner displayMode={displayMode} toggleFullMap={toggleFullMap} />
}
