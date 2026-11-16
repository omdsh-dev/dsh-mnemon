import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { type MemoryGraphEdge, type MemoryGraphNode, type MemoryGraphSnapshot } from '../contracts.ts'
import { short } from 'dsh-mnemon/client'
import { graphNodeKey, graphNodeKind, type MemoryGraphProps } from './memory-graph.tsx'

export interface Point3D {
  x: number
  y: number
  z: number
}

export interface Camera3D {
  yaw: number
  pitch: number
  distance: number
}

export interface ProjectedNode {
  id: string
  node: MemoryGraphNode
  sx: number
  sy: number
  rz: number
  scale: number
  radius: number
}

const DEFAULT_CAMERA: Camera3D = { yaw: 0.42, pitch: 0.24, distance: 960 }
const MAX_VISIBLE_NODES = 60
const MAX_VISIBLE_EDGES = 240
const FOCAL_LENGTH = 820
const SPHERE_RADIUS = 310
const CATEGORY_ORDER = ['space', 'entity', 'preference', 'decision', 'fact', 'insight', 'context', 'general'] as const
const PROVIDER_COLORS: Record<string, string> = {
  'mnemon-native': '#64748b',
  openviking: '#3b82d0',
  honcho: '#c44fcf',
  mem0: '#8b5cf6',
  hindsight: '#0891b2',
  holographic: '#6366d9',
  retaindb: '#d08a28',
  byterover: '#0f9a83',
  supermemory: '#df4d72',
}
const CATEGORY_COLORS: Record<string, string> = {
  decision: '#ef8354',
  preference: '#a879e1',
  fact: '#4d7cfe',
  insight: '#19a77d',
  context: '#d8a624',
  entity: '#2b9db9',
  general: '#8290a8',
}
const EDGE_COLORS: Record<string, string> = {
  scope: '#708199',
  temporal: '#87909f',
  semantic: '#4d7cfe',
  causal: '#f07667',
  entity: '#25b383',
}
const EDGE_PRIORITY: Record<string, number> = { entity: 0, causal: 1, semantic: 2, temporal: 3, scope: 4 }

function hashString(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function resolveColor(node: MemoryGraphNode): string {
  const kind = graphNodeKind(node)
  if (kind === 'space') return PROVIDER_COLORS[node.memoryProviderId ?? ''] ?? '#64748b'
  if (kind === 'entity') return '#2b9db9'
  return CATEGORY_COLORS[(node.category ?? 'general').toLowerCase()] ?? (node.color || '#8290a8')
}

function sliceVisibleGraph(graph: MemoryGraphSnapshot, selectedId: string | undefined): {
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
  neighborIds: Set<string>
} {
  const degree = new Map<string, number>()
  for (const edge of graph.edges) {
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1)
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1)
  }
  const directNeighbors = new Set<string>()
  if (selectedId !== undefined) {
    for (const edge of graph.edges) {
      if (edge.sourceId === selectedId) directNeighbors.add(edge.targetId)
      else if (edge.targetId === selectedId) directNeighbors.add(edge.sourceId)
    }
  }
  const score = (node: MemoryGraphNode): number => {
    const id = graphNodeKey(node)
    const kind = graphNodeKind(node)
    if (id === selectedId) return 10_000
    if (kind === 'space') return 5_000 + (degree.get(id) ?? 0)
    if (directNeighbors.has(id)) return 2_000 + (degree.get(id) ?? 0)
    return (kind === 'entity' ? 100 : 0) + (degree.get(id) ?? 0) * 10 + (node.importance ?? 3)
  }
  const nodes = [...graph.nodes]
    .sort((a, b) => score(b) - score(a) || graphNodeKey(a).localeCompare(graphNodeKey(b)))
    .slice(0, MAX_VISIBLE_NODES)
  const visibleSet = new Set(nodes.map(graphNodeKey))
  const edges = graph.edges
    .filter(edge => edge.sourceId !== edge.targetId && visibleSet.has(edge.sourceId) && visibleSet.has(edge.targetId))
    .sort((a, b) => (EDGE_PRIORITY[a.type ?? ''] ?? 9) - (EDGE_PRIORITY[b.type ?? ''] ?? 9))
    .slice(0, MAX_VISIBLE_EDGES)
  return { nodes, edges, neighborIds: directNeighbors }
}

/** Compute deterministic 3D force-directed coordinates grouped around spherical category anchors. */
export function compute3DLayout(nodes: readonly MemoryGraphNode[], edges: readonly MemoryGraphEdge[]): Map<string, Point3D> {
  const positions = new Map<string, Point3D>()
  if (nodes.length === 0) return positions

  const ids = nodes.map(graphNodeKey)
  const indexById = new Map(ids.map((id, idx) => [id, idx]))
  const categoryAnchors = new Map<string, Point3D>()
  CATEGORY_ORDER.forEach((cat, idx) => {
    const phi = Math.acos(1 - (2 * (idx + 0.5)) / CATEGORY_ORDER.length)
    const theta = Math.PI * (1 + Math.sqrt(5)) * idx
    const r = cat === 'space' ? 0 : 175
    categoryAnchors.set(cat, {
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta) * 0.78,
      z: r * Math.cos(phi),
    })
  })

  const spaces = nodes.filter(node => graphNodeKind(node) === 'space')
  const coords = nodes.map((node, i): Point3D => {
    const id = ids[i]!
    const kind = graphNodeKind(node)
    if (kind === 'space') {
      if (spaces.length === 1) return { x: 0, y: 0, z: 0 }
      const sIdx = spaces.indexOf(node)
      const angle = (sIdx / spaces.length) * Math.PI * 2
      return { x: Math.cos(angle) * 95, y: ((sIdx % 2) * 2 - 1) * 28, z: Math.sin(angle) * 95 }
    }
    const catKey = kind === 'entity' ? 'entity' : (node.category ?? 'general').toLowerCase()
    const anchor = categoryAnchors.get(catKey) ?? categoryAnchors.get('general')!
    const h = hashString(id)
    const u = ((h & 0xff) / 255) * 2 - 1
    const v = (((h >>> 8) & 0xff) / 255) * 2 - 1
    const w = (((h >>> 16) & 0xff) / 255) * 2 - 1
    return {
      x: anchor.x + u * 86,
      y: anchor.y + v * 72,
      z: anchor.z + w * 86,
    }
  })

  const velocities: Point3D[] = coords.map(() => ({ x: 0, y: 0, z: 0 }))
  const linkPairs = edges.flatMap(edge => {
    const s = indexById.get(edge.sourceId)
    const t = indexById.get(edge.targetId)
    if (s === undefined || t === undefined) return []
    const rest = edge.type === 'scope' ? 145 : edge.type === 'entity' ? 105 : 120
    return [{ s, t, rest }]
  })

  const iterations = Math.min(64, Math.max(24, Math.round(90 - nodes.length * 0.6)))
  const singleSpaceHub = spaces.length === 1 ? indexById.get(graphNodeKey(spaces[0]!)) : undefined

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / (iterations + 6)
    const forces: Point3D[] = coords.map(p => ({ x: -p.x * 0.018, y: -p.y * 0.018, z: -p.z * 0.018 }))

    for (let i = 0; i < coords.length; i++) {
      const a = coords[i]!
      for (let j = i + 1; j < coords.length; j++) {
        const b = coords[j]!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dz = a.z - b.z
        const distSq = dx * dx + dy * dy + dz * dz + 16
        const dist = Math.sqrt(distSq)
        const repulse = Math.min(28, 3600 / distSq) / dist
        const fx = dx * repulse
        const fy = dy * repulse
        const fz = dz * repulse
        forces[i]!.x += fx
        forces[i]!.y += fy
        forces[i]!.z += fz
        forces[j]!.x -= fx
        forces[j]!.y -= fy
        forces[j]!.z -= fz
      }
    }

    for (const link of linkPairs) {
      const a = coords[link.s]!
      const b = coords[link.t]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const dist = Math.hypot(dx, dy, dz) || 1
      const stretch = (dist - link.rest) * 0.065
      const fx = (dx / dist) * stretch
      const fy = (dy / dist) * stretch
      const fz = (dz / dist) * stretch
      forces[link.s]!.x += fx
      forces[link.s]!.y += fy
      forces[link.s]!.z += fz
      forces[link.t]!.x -= fx
      forces[link.t]!.y -= fy
      forces[link.t]!.z -= fz
    }

    for (let i = 0; i < coords.length; i++) {
      if (i === singleSpaceHub) continue
      const vel = velocities[i]!
      const f = forces[i]!
      vel.x = (vel.x + f.x) * 0.72 * cooling
      vel.y = (vel.y + f.y) * 0.72 * cooling
      vel.z = (vel.z + f.z) * 0.72 * cooling
      const pos = coords[i]!
      pos.x += clamp(vel.x, -26, 26)
      pos.y += clamp(vel.y, -26, 26)
      pos.z += clamp(vel.z, -26, 26)
      const mag = Math.hypot(pos.x, pos.y, pos.z)
      if (mag > SPHERE_RADIUS) {
        const pull = SPHERE_RADIUS / mag
        pos.x *= pull
        pos.y *= pull
        pos.z *= pull
      }
    }
  }

  for (let i = 0; i < ids.length; i++) positions.set(ids[i]!, coords[i]!)
  return positions
}

/** Project one 3D point onto viewport screen space with perspective scaling. */
export function project3DPoint(
  point: Point3D,
  camera: Camera3D,
  width: number,
  height: number,
): { sx: number; sy: number; rz: number; scale: number } | undefined {
  const cosY = Math.cos(camera.yaw)
  const sinY = Math.sin(camera.yaw)
  const cosP = Math.cos(camera.pitch)
  const sinP = Math.sin(camera.pitch)

  const x1 = point.x * cosY - point.z * sinY
  const z1 = point.x * sinY + point.z * cosY
  const y2 = point.y * cosP - z1 * sinP
  const z2 = point.y * sinP + z1 * cosP
  const depth = camera.distance + z2
  if (depth <= 48) return undefined
  const scale = (FOCAL_LENGTH / depth) * (Math.min(width, height) / 520)
  return { sx: width / 2 + x1 * scale, sy: height / 2 + y2 * scale, rz: z2, scale }
}

/** Hit-test projected 3D nodes front-to-back and return the top match. */
export function pickProjectedNode(projected: readonly ProjectedNode[], x: number, y: number): MemoryGraphNode | undefined {
  for (let i = projected.length - 1; i >= 0; i--) {
    const item = projected[i]!
    const hitRadius = Math.max(12, item.radius + 6)
    if (Math.hypot(x - item.sx, y - item.sy) <= hitRadius) return item.node
  }
  return undefined
}

function readThemePalette(canvas: HTMLCanvasElement) {
  const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(canvas) : undefined
  const pick = (names: readonly string[], fallback: string) => {
    if (style === undefined) return fallback
    for (const name of names) {
      const value = style.getPropertyValue(name).trim()
      if (value !== '') return value
    }
    return fallback
  }
  return {
    bg: pick(['--dsw-alias-bg-layer-1', '--mn-layer-1'], '#ffffff'),
    line: pick(['--dsw-alias-border-l2', '--mn-line'], '#e5e7eb'),
    text: pick(['--dsw-alias-label-primary', '--mn-text'], '#111827'),
    muted: pick(['--dsw-alias-label-secondary', '--mn-muted'], '#4b5563'),
    faint: pick(['--dsw-alias-label-tertiary', '--mn-faint'], '#9ca3af'),
    accent: pick(['--dsw-alias-state-business-primary', '--mn-accent'], '#4d7cfe'),
  }
}

export interface MemoryGraph3DProps extends MemoryGraphProps {}

/** Zero-dependency interactive HTML5 2D-canvas 3D perspective renderer for multi-space memory graphs. */
export const MemoryGraph3D = memo(function MemoryGraph3D(props: MemoryGraph3DProps): JSX.Element {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<Camera3D>({ ...DEFAULT_CAMERA })
  const projectedRef = useRef<ProjectedNode[]>([])
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  const skipNextClickRef = useRef(false)
  const animRef = useRef<number | null>(null)
  const drawRef = useRef<() => void>(() => undefined)
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined)
  const [dragging, setDragging] = useState(false)

  const { nodes: visibleNodes, edges: visibleEdges, neighborIds } = useMemo(
    () => sliceVisibleGraph(props.graph, props.selectedId),
    [props.graph, props.selectedId],
  )
  const layout = useMemo(() => compute3DLayout(visibleNodes, visibleEdges), [visibleNodes, visibleEdges])
  const nodeById = useMemo(() => new Map(visibleNodes.map(node => [graphNodeKey(node), node])), [visibleNodes])

  const cancelAnimation = useCallback(() => {
    if (animRef.current !== null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(animRef.current)
    }
    animRef.current = null
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    let ctx: CanvasRenderingContext2D | null = null
    try { ctx = canvas.getContext('2d') } catch { ctx = null }
    if (ctx === null) return

    const width = canvas.clientWidth > 0 ? canvas.clientWidth : 930
    const height = canvas.clientHeight > 0 ? canvas.clientHeight : 520
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2)
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const palette = readThemePalette(canvas)
    const cam = cameraRef.current
    const quiet = props.quiet === true
    const focusId = props.selectedId ?? hoveredId

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = palette.bg
    ctx.fillRect(0, 0, width, height)

    if (!quiet) {
      ctx.save()
      ctx.strokeStyle = palette.line
      ctx.lineWidth = 0.75
      ctx.globalAlpha = 0.45
      for (const radiusFactor of [0.45, 0.85]) {
        const center = project3DPoint({ x: 0, y: 0, z: 0 }, cam, width, height)
        if (center !== undefined) {
          const rx = SPHERE_RADIUS * radiusFactor * center.scale
          const ry = Math.max(12, rx * Math.abs(Math.sin(cam.pitch)) * 0.72 + 12)
          ctx.beginPath()
          ctx.ellipse(center.sx, center.sy, rx, ry, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      ctx.restore()
    }

    const projectedById = new Map<string, ProjectedNode>()
    const projectedList: ProjectedNode[] = []
    for (const node of visibleNodes) {
      const id = graphNodeKey(node)
      const pt = layout.get(id)
      if (pt === undefined) continue
      const p = project3DPoint(pt, cam, width, height)
      if (p === undefined) continue
      const kind = graphNodeKind(node)
      const baseRadius = kind === 'space' ? 11.5 : kind === 'entity' ? 8.2 : 5.2 + Math.min(3.5, (node.importance ?? 3) * 0.65)
      const item: ProjectedNode = { id, node, sx: p.sx, sy: p.sy, rz: p.rz, scale: p.scale, radius: clamp(baseRadius * p.scale, 3.5, 22) }
      projectedById.set(id, item)
      projectedList.push(item)
    }

    const drawableEdges = visibleEdges
      .flatMap(edge => {
        const s = projectedById.get(edge.sourceId)
        const tgt = projectedById.get(edge.targetId)
        return s === undefined || tgt === undefined ? [] : [{ edge, s, tgt, depth: (s.rz + tgt.rz) / 2 }]
      })
      .sort((a, b) => b.depth - a.depth)

    for (const { edge, s, tgt, depth } of drawableEdges) {
      const connected = focusId !== undefined && (edge.sourceId === focusId || edge.targetId === focusId)
      const depthAlpha = clamp(0.75 - depth / 1100, 0.25, 0.95)
      ctx.save()
      ctx.beginPath()
      ctx.strokeStyle = quiet ? (connected ? palette.accent : palette.faint) : (EDGE_COLORS[edge.type ?? ''] ?? palette.faint)
      ctx.lineWidth = (edge.type === 'entity' ? 1.4 : 1) * (connected ? 1.45 : 1)
      ctx.globalAlpha = quiet ? (connected ? 0.85 : focusId !== undefined ? 0.16 : 0.36) : (connected ? 0.9 : 0.48 * depthAlpha)
      if (!quiet && edge.type === 'scope') ctx.setLineDash([4, 5])
      ctx.moveTo(s.sx, s.sy)
      ctx.lineTo(tgt.sx, tgt.sy)
      ctx.stroke()
      ctx.restore()
    }

    projectedList.sort((a, b) => b.rz - a.rz)
    projectedRef.current = projectedList

    const sparse = visibleNodes.length <= 16
    for (const item of projectedList) {
      const { id, node, sx, sy, rz, radius } = item
      const isSelected = props.selectedId === id
      const isHovered = hoveredId === id
      const isNeighbor = neighborIds.has(id)
      const dimmed = quiet && focusId !== undefined && !isSelected && !isHovered && !isNeighbor
      const depthAlpha = clamp(0.85 - rz / 950, 0.38, 1)
      const color = quiet ? (isSelected || isHovered ? palette.accent : palette.muted) : resolveColor(node)

      ctx.save()
      ctx.globalAlpha = dimmed ? 0.32 : depthAlpha

      if (isSelected || isHovered || graphNodeKind(node) === 'space') {
        ctx.beginPath()
        ctx.arc(sx, sy, radius + (isSelected ? 5 : 3.5), 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.lineWidth = isSelected ? 2 : 1.25
        ctx.globalAlpha = dimmed ? 0.25 : (isSelected ? 0.95 : 0.52)
        ctx.stroke()
      }

      ctx.globalAlpha = dimmed ? 0.35 : depthAlpha
      ctx.beginPath()
      ctx.arc(sx, sy, radius, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      const showLabel = isSelected || isHovered || (!quiet && (sparse || graphNodeKind(node) === 'space' || (focusId !== undefined && isNeighbor)))
      if (showLabel) {
        const label = short(node.content, graphNodeKind(node) === 'space' ? 24 : 20)
        ctx.font = `${isSelected || graphNodeKind(node) === 'space' ? 500 : 400} 11px system-ui, -apple-system, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = isSelected ? palette.text : palette.muted
        ctx.globalAlpha = dimmed ? 0.4 : 0.95
        ctx.fillText(label, sx, sy + radius + 5)
      }
      ctx.restore()
    }
  }, [hoveredId, layout, neighborIds, props.quiet, props.selectedId, visibleEdges, visibleNodes])

  drawRef.current = draw

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      cancelAnimation()
      cameraRef.current = {
        ...cameraRef.current,
        distance: clamp(cameraRef.current.distance + event.deltaY * 0.75, 340, 1650),
      }
      drawRef.current()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [cancelAnimation])

  useEffect(() => () => cancelAnimation(), [cancelAnimation])

  const animateCameraTo = useCallback((target: Camera3D) => {
    cancelAnimation()
    const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    if (prefersReducedMotion || typeof window.requestAnimationFrame !== 'function') {
      cameraRef.current = { ...target }
      drawRef.current()
      return
    }
    const start = { ...cameraRef.current }
    const startedAt = performance.now()
    const tick = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / 480)
      const eased = 1 - Math.pow(1 - progress, 3)
      cameraRef.current = {
        yaw: start.yaw + (target.yaw - start.yaw) * eased,
        pitch: start.pitch + (target.pitch - start.pitch) * eased,
        distance: start.distance + (target.distance - start.distance) * eased,
      }
      drawRef.current()
      animRef.current = progress < 1 ? window.requestAnimationFrame(tick) : null
    }
    animRef.current = window.requestAnimationFrame(tick)
  }, [cancelAnimation])

  const canvasCoordinates = (clientX: number, clientY: number, element: HTMLCanvasElement) => {
    const rect = element.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  const pickAt = (clientX: number, clientY: number, element: HTMLCanvasElement) => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return
    const point = canvasCoordinates(clientX, clientY, element)
    const hit = pickProjectedNode(projectedRef.current, point.x, point.y)
    if (hit !== undefined) props.onSelect(hit)
    else props.onClearSelection?.()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    cancelAnimation()
    dragRef.current = { pointerId: event.pointerId ?? 0, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const pointerId = event.pointerId ?? 0
    if (drag !== null && drag.pointerId === pointerId && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const dx = event.clientX - drag.lastX
      const dy = event.clientY - drag.lastY
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) drag.moved = true
      cameraRef.current = {
        ...cameraRef.current,
        yaw: cameraRef.current.yaw + dx * 0.0065,
        pitch: clamp(cameraRef.current.pitch + dy * 0.0055, -1.35, 1.35),
      }
      drawRef.current()
      return
    }
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    const point = canvasCoordinates(event.clientX, event.clientY, event.currentTarget)
    const hit = pickProjectedNode(projectedRef.current, point.x, point.y)
    setHoveredId(hit === undefined ? undefined : graphNodeKey(hit))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== (event.pointerId ?? 0)) return
    dragRef.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    skipNextClickRef.current = true
    if (!drag.moved) pickAt(event.clientX, event.clientY, event.currentTarget)
  }

  const onClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (skipNextClickRef.current) { skipNextClickRef.current = false; return }
    pickAt(event.clientX, event.clientY, event.currentTarget)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === 'Escape') { props.onClearSelection?.(); return }
    if (event.key === '0' || event.key === 'r' || event.key === 'R') { event.preventDefault(); animateCameraTo(DEFAULT_CAMERA); return }
    const yawStep = event.key === 'ArrowLeft' ? -0.18 : event.key === 'ArrowRight' ? 0.18 : 0
    const pitchStep = event.key === 'ArrowUp' ? -0.14 : event.key === 'ArrowDown' ? 0.14 : 0
    const zoomStep = event.key === '+' || event.key === '=' ? -120 : event.key === '-' || event.key === '_' ? 120 : 0
    if (yawStep === 0 && pitchStep === 0 && zoomStep === 0) return
    event.preventDefault()
    cancelAnimation()
    cameraRef.current = {
      yaw: cameraRef.current.yaw + yawStep,
      pitch: clamp(cameraRef.current.pitch + pitchStep, -1.35, 1.35),
      distance: clamp(cameraRef.current.distance + zoomStep, 340, 1650),
    }
    drawRef.current()
  }

  const adjustZoom = (delta: number) => {
    animateCameraTo({ ...cameraRef.current, distance: clamp(cameraRef.current.distance + delta, 340, 1650) })
  }

  const hoveredNode = hoveredId === undefined ? undefined : nodeById.get(hoveredId)

  return (
    <>
      <div className={css.graphCanvasControls} role="toolbar" aria-label={t('graph.orbitAria')}>
        <span role="status"><i />{hoveredNode !== undefined ? short(hoveredNode.content, 24) : t('graph.orbitHint')}</span>
        {props.onQuietChange !== undefined && <button type="button" aria-pressed={props.quiet === true} data-active={props.quiet || undefined} title={t('graph.quietHint')} onClick={() => props.onQuietChange?.(!props.quiet)}>{t('graph.quietAction')}</button>}
        <button type="button" aria-label={t('graph.zoomInAction')} onClick={() => adjustZoom(-160)}>+</button>
        <button type="button" aria-label={t('graph.zoomOutAction')} onClick={() => adjustZoom(160)}>−</button>
        <button type="button" onClick={() => animateCameraTo(DEFAULT_CAMERA)}>{t('graph.resetViewAction')}</button>
      </div>
      <canvas
        ref={canvasRef}
        className={css.graphCanvas}
        role="img"
        tabIndex={0}
        data-view="3d"
        data-quiet={props.quiet || undefined}
        data-dragging={dragging || undefined}
        data-hover={hoveredId !== undefined || undefined}
        aria-label={t('graph.aria3d', { nodes: props.graph.nodes.length, edges: props.graph.edges.length })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
        onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) { dragRef.current = null; setDragging(false) } }}
        onPointerLeave={() => { if (dragRef.current === null) setHoveredId(undefined) }}
        onKeyDown={onKeyDown}
      />
    </>
  )
})
