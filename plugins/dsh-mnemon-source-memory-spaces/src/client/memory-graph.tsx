import { css, useT } from './presentation.ts'
import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { normalizeEntityKey, type MemorySpaceView, type MemoryGraphNode, type MemoryGraphSnapshot } from '../contracts.ts'
import { type MnemonTranslate, short } from 'dsh-mnemon/client'
import { categoryLabel } from './widgets.tsx'

const GRAPH_WIDTH = 930

const GRAPH_HEIGHT = 520

const GRAPH_MARGIN_X = 58

const GRAPH_MARGIN_Y = 58

const CATEGORY_ORDER = ['space', 'entity', 'preference', 'decision', 'fact', 'insight', 'context', 'general']

interface GraphPosition { x: number; y: number }

type GraphPositions = Map<string, GraphPosition>

type GraphLayoutMode = 'natural' | 'uniform' | 'custom'

function hash(value: string): number {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return result >>> 0
}

export function graphNodeKey(node: MemoryGraphNode): string {
  return node.graphId ?? node.id
}

export function graphNodeKind(node: MemoryGraphNode): NonNullable<MemoryGraphNode['kind']> {
  return node.kind ?? 'memory'
}

function spaceGraphId(id: string): string {
  return `space:${id}`
}

function entityGraphId(entity: string): string {
  return `entity:${encodeURIComponent(normalizeEntity(entity))}`
}

/** The graph and the Entities page count an entity by the same key. */
const normalizeEntity = normalizeEntityKey

/** Add routing scopes and entity indexes without issuing another recall. */
export function enrichMultiSpaceGraph(graph: MemoryGraphSnapshot, bodies: MemorySpaceView[]): MemoryGraphSnapshot {
  if (graph.nodes.length === 0) return graph
  const memories = graph.nodes.map(node => ({ ...node, kind: 'memory' as const }))
  const memoriesBySpace = new Map<string, MemoryGraphNode[]>()
  for (const node of memories) {
    if (node.memoryBodyId === undefined) continue
    memoriesBySpace.set(node.memoryBodyId, [...(memoriesBySpace.get(node.memoryBodyId) ?? []), node])
  }

  const activeSpaces = bodies.filter(body => body.active && ((memoriesBySpace.get(body.id)?.length ?? 0) > 0 || (body.stats?.topEntities.length ?? 0) > 0))
  const spaceNodes: MemoryGraphNode[] = activeSpaces.map(body => ({
    id: body.id,
    graphId: spaceGraphId(body.id),
    kind: 'space',
    category: 'space',
    content: body.name,
    color: '#22a879',
    memoryBodyId: body.id,
    memoryBodyName: body.name,
    memoryProviderId: body.provider.id,
    occurrenceCount: body.stats?.totalInsights ?? memoriesBySpace.get(body.id)?.length ?? 0,
  }))

  // Native Mnemon entity edges connect two memories. This overview renders
  // entities as first-class nodes, so retaining those edges would falsely make
  // a memory-to-memory edge look like an entity-to-memory association.
  const edges: MemoryGraphSnapshot['edges'] = graph.edges.filter(edge => edge.type !== 'entity')
  for (const body of activeSpaces) {
    for (const memory of memoriesBySpace.get(body.id) ?? []) {
      edges.push({ sourceId: spaceGraphId(body.id), targetId: graphNodeKey(memory), label: 'scope', color: '#708199', type: 'scope' })
    }
  }

  const spacesById = new Map(activeSpaces.map(body => [body.id, body]))
  const indexedEntities = new Map<string, { entity: string; memories: MemoryGraphNode[]; bodies: MemorySpaceView[] }>()
  for (const memory of memories) {
    const body = memory.memoryBodyId === undefined ? undefined : spacesById.get(memory.memoryBodyId)
    if (body === undefined) continue
    const seen = new Set<string>()
    for (const rawEntity of memory.entities ?? []) {
      const entity = rawEntity.trim()
      const key = normalizeEntity(entity)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      const current = indexedEntities.get(key)
      if (current === undefined) indexedEntities.set(key, { entity, memories: [memory], bodies: [body] })
      else {
        current.memories.push(memory)
        if (!current.bodies.some(candidate => candidate.id === body.id)) current.bodies.push(body)
      }
    }
  }
  const entities = [...indexedEntities.values()].sort((left, right) => right.memories.length - left.memories.length || left.entity.localeCompare(right.entity)).slice(0, 24)
  const entityNodes: MemoryGraphNode[] = entities.map(item => ({
    id: item.entity,
    graphId: entityGraphId(item.entity),
    kind: 'entity',
    category: 'entity',
    content: item.entity,
    color: '#2b9db9',
    occurrenceCount: item.memories.length,
    memoryBodyIds: item.bodies.map(body => body.id),
    memoryBodyNames: item.bodies.map(body => body.name),
  }))
  for (const item of entities) {
    const key = entityGraphId(item.entity)
    for (const memory of item.memories) edges.push({ sourceId: key, targetId: graphNodeKey(memory), label: item.entity, color: '#22a879', type: 'entity' })
  }

  return { ...graph, nodes: [...spaceNodes, ...entityNodes, ...memories], edges }
}

export function graphKindLabel(t: MnemonTranslate, node: MemoryGraphNode): string {
  const kind = graphNodeKind(node)
  return kind === 'space' ? t('graph.kindSpace') : kind === 'entity' ? t('graph.kindEntity') : categoryLabel(t, node.category ?? 'general')
}

function activeCategoryAnchors(grouped: Map<string, MemoryGraphNode[]>): Map<string, GraphPosition> {
  const categories = [...grouped.keys()].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left)
    const rightIndex = CATEGORY_ORDER.indexOf(right)
    return (leftIndex < 0 ? CATEGORY_ORDER.length : leftIndex) - (rightIndex < 0 ? CATEGORY_ORDER.length : rightIndex)
  })
  const anchors = new Map<string, GraphPosition>()
  if (categories.length === 1) {
    anchors.set(categories[0]!, { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 })
    return anchors
  }
  categories.forEach((category, index) => {
    const angle = -Math.PI / 2 + (index / categories.length) * Math.PI * 2
    anchors.set(category, {
      x: GRAPH_WIDTH / 2 + Math.cos(angle) * Math.min(250, 115 + categories.length * 23),
      y: GRAPH_HEIGHT / 2 + Math.sin(angle) * Math.min(165, 78 + categories.length * 15),
    })
  })
  return anchors
}

function clampGraphPosition(position: GraphPosition): GraphPosition {
  return {
    x: Math.min(GRAPH_WIDTH - GRAPH_MARGIN_X, Math.max(GRAPH_MARGIN_X, position.x)),
    y: Math.min(GRAPH_HEIGHT - GRAPH_MARGIN_Y, Math.max(GRAPH_MARGIN_Y, position.y)),
  }
}

function naturalGraphPositions(nodes: MemoryGraphNode[], edges: MemoryGraphSnapshot['edges']): GraphPositions {
  const positions: GraphPositions = new Map()
  const grouped = new Map<string, MemoryGraphNode[]>()
  for (const node of nodes) {
    const category = node.category ?? 'general'
    grouped.set(category, [...(grouped.get(category) ?? []), node])
  }
  const anchors = activeCategoryAnchors(grouped)
  for (const [category, items] of grouped) {
    const anchor = anchors.get(category) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
    items.forEach((node, index) => {
      const seed = hash(graphNodeKey(node))
      const angle = index * 2.399963 + ((seed % 37) / 37) * .4
      const radius = items.length === 1 ? 0 : 24 + Math.sqrt(index + 1) * 35
      positions.set(graphNodeKey(node), clampGraphPosition({ x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius }))
    })
  }

  const velocities = new Map(nodes.map(node => [graphNodeKey(node), { x: 0, y: 0 }]))
  const visibleIds = new Set(nodes.map(graphNodeKey))
  const visibleEdges = edges.filter(edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
  for (let iteration = 0; iteration < 150; iteration += 1) {
    const cooling = 1 - iteration / 180
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex]!
      const leftPosition = positions.get(graphNodeKey(left))!
      const leftVelocity = velocities.get(graphNodeKey(left))!
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex]!
        const rightPosition = positions.get(graphNodeKey(right))!
        const rightVelocity = velocities.get(graphNodeKey(right))!
        let dx = leftPosition.x - rightPosition.x
        let dy = leftPosition.y - rightPosition.y
        if (dx === 0 && dy === 0) { dx = ((hash(graphNodeKey(left)) % 13) - 6) || 1; dy = ((hash(graphNodeKey(right)) % 11) - 5) || -1 }
        const distanceSquared = Math.max(100, dx * dx + dy * dy)
        const distance = Math.sqrt(distanceSquared)
        const repulsion = Math.min(9, 18_000 / distanceSquared) * cooling
        const collision = distance < 66 ? (66 - distance) * .08 : 0
        const force = repulsion + collision
        const forceX = (dx / distance) * force
        const forceY = (dy / distance) * force
        leftVelocity.x += forceX; leftVelocity.y += forceY
        rightVelocity.x -= forceX; rightVelocity.y -= forceY
      }
    }
    for (const edge of visibleEdges) {
      const source = positions.get(edge.sourceId)!
      const target = positions.get(edge.targetId)!
      const sourceVelocity = velocities.get(edge.sourceId)!
      const targetVelocity = velocities.get(edge.targetId)!
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const sparseScale = nodes.length <= 3 ? 2 : nodes.length <= 8 ? 1.45 : 1
      const desired = (edge.type === 'scope' ? 138 : edge.type === 'entity' ? 94 : edge.type === 'semantic' ? 118 : 106) * sparseScale
      const spring = (distance - desired) * .018 * cooling
      const forceX = (dx / distance) * spring
      const forceY = (dy / distance) * spring
      sourceVelocity.x += forceX; sourceVelocity.y += forceY
      targetVelocity.x -= forceX; targetVelocity.y -= forceY
    }
    for (const node of nodes) {
      const key = graphNodeKey(node)
      const position = positions.get(key)!
      const velocity = velocities.get(key)!
      const anchor = anchors.get(node.category ?? 'general') ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
      velocity.x += (anchor.x - position.x) * .0035 * cooling + (GRAPH_WIDTH / 2 - position.x) * .0008
      velocity.y += (anchor.y - position.y) * .0035 * cooling + (GRAPH_HEIGHT / 2 - position.y) * .0008
      velocity.x = Math.max(-12, Math.min(12, velocity.x * .76))
      velocity.y = Math.max(-12, Math.min(12, velocity.y * .76))
      positions.set(key, clampGraphPosition({ x: position.x + velocity.x, y: position.y + velocity.y }))
    }
  }
  return positions
}

function uniformGraphPositions(nodes: MemoryGraphNode[]): GraphPositions {
  const positions: GraphPositions = new Map()
  const ordered = [...nodes].sort((left, right) => {
    const categoryDifference = CATEGORY_ORDER.indexOf(left.category ?? 'general') - CATEGORY_ORDER.indexOf(right.category ?? 'general')
    return categoryDifference === 0 ? left.id.localeCompare(right.id) : categoryDifference
  })
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * 1.65)))
  const rows = Math.max(1, Math.ceil(ordered.length / columns))
  const cellWidth = (GRAPH_WIDTH - GRAPH_MARGIN_X * 2) / columns
  const cellHeight = (GRAPH_HEIGHT - GRAPH_MARGIN_Y * 2) / rows
  ordered.forEach((node, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const rowLength = Math.min(columns, ordered.length - row * columns)
    const rowOffset = (columns - rowLength) * cellWidth / 2
    positions.set(graphNodeKey(node), {
      x: GRAPH_MARGIN_X + rowOffset + cellWidth * (column + .5),
      y: GRAPH_MARGIN_Y + cellHeight * (row + .5),
    })
  })
  return positions
}

function graphPoint(svg: SVGSVGElement, clientX: number, clientY: number): GraphPosition {
  const matrix = svg.getScreenCTM?.()
  if (matrix !== null && matrix !== undefined && typeof svg.createSVGPoint === 'function') {
    const point = svg.createSVGPoint()
    point.x = clientX; point.y = clientY
    return clampGraphPosition(point.matrixTransform(matrix.inverse()))
  }
  const bounds = svg.getBoundingClientRect()
  const width = bounds.width || GRAPH_WIDTH
  const height = bounds.height || GRAPH_HEIGHT
  return clampGraphPosition({ x: (clientX - bounds.left) * GRAPH_WIDTH / width, y: (clientY - bounds.top) * GRAPH_HEIGHT / height })
}

export function MemoryGraph(props: { graph: MemoryGraphSnapshot; selectedId?: string | undefined; onSelect: (node: MemoryGraphNode) => void; onClearSelection?: () => void; quiet?: boolean; onQuietChange?: (quiet: boolean) => void }): JSX.Element {
  const t = useT()
  const visibleNodes = useMemo(() => {
    const spaces = props.graph.nodes.filter(node => graphNodeKind(node) === 'space')
    const entities = props.graph.nodes.filter(node => graphNodeKind(node) === 'entity').slice(0, 20)
    const memories = props.graph.nodes.filter(node => graphNodeKind(node) === 'memory').slice(0, Math.max(0, 60 - spaces.length - entities.length))
    return [...spaces, ...entities, ...memories].slice(0, 60)
  }, [props.graph.nodes])
  const visibleIds = useMemo(() => new Set(visibleNodes.map(graphNodeKey)), [visibleNodes])
  const neighbors = useMemo(() => {
    if (!props.quiet || props.selectedId === undefined || !visibleIds.has(props.selectedId)) return undefined
    const result = new Set([props.selectedId])
    for (const edge of props.graph.edges) {
      if (edge.sourceId === props.selectedId) result.add(edge.targetId)
      if (edge.targetId === props.selectedId) result.add(edge.sourceId)
    }
    return result
  }, [props.quiet, props.selectedId, props.graph.edges, visibleIds])
  const visibleKinds = useMemo(() => new Map(visibleNodes.map(node => [graphNodeKey(node), graphNodeKind(node)])), [visibleNodes])
  const edges = useMemo(() => {
    const priority = new Map<string, number>([['entity', 0], ['scope', 1], ['causal', 2], ['semantic', 3], ['temporal', 4]])
    return props.graph.edges
      .filter(edge => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId))
      .map((edge, index) => ({ edge, index }))
      .sort((left, right) => (priority.get(left.edge.type ?? 'temporal') ?? 5) - (priority.get(right.edge.type ?? 'temporal') ?? 5) || left.index - right.index)
      .slice(0, 180)
      .map(({ edge }) => edge)
  }, [props.graph.edges, visibleIds])
  const curvedEdges = useMemo(() => {
    const groups = new Map<string, number[]>()
    edges.forEach((edge, index) => {
      const key = [edge.sourceId, edge.targetId].sort().join('::')
      groups.set(key, [...(groups.get(key) ?? []), index])
    })
    return edges.map((edge, index) => {
      const key = [edge.sourceId, edge.targetId].sort().join('::')
      const group = groups.get(key) ?? [index]
      const groupIndex = group.indexOf(index)
      return { edge, offset: (groupIndex - (group.length - 1) / 2) * 12 }
    })
  }, [edges])
  const layoutKey = `${visibleNodes.map(node => `${graphNodeKey(node)}:${graphNodeKind(node)}:${node.category ?? 'general'}`).join('|')}::${edges.map(edge => `${edge.sourceId}>${edge.targetId}:${edge.type ?? 'temporal'}`).join('|')}`
  const naturalLayout = useMemo(() => naturalGraphPositions(visibleNodes, edges), [layoutKey])
  const [positions, setPositions] = useState<GraphPositions>(() => naturalLayout)
  const [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('natural')
  const positionsRef = useRef(positions)
  const animationRef = useRef<number | null>(null)
  const dragRef = useRef<{ nodeId: string; pointerId: number; startX: number; startY: number; moved: boolean } | null>(null)

  const commitPositions = useCallback((next: GraphPositions) => {
    positionsRef.current = next
    setPositions(next)
  }, [])

  const cancelAnimation = useCallback(() => {
    if (animationRef.current !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(animationRef.current)
    animationRef.current = null
  }, [])

  const animateTo = useCallback((target: GraphPositions, mode: Exclude<GraphLayoutMode, 'custom'>) => {
    cancelAnimation()
    setLayoutMode(mode)
    if (typeof window.requestAnimationFrame !== 'function') { commitPositions(target); return }
    const start = new Map(positionsRef.current)
    const startedAt = performance.now()
    const tick = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / 620)
      const eased = 1 - Math.pow(1 - progress, 3)
      const next: GraphPositions = new Map()
      for (const [id, destination] of target) {
        const origin = start.get(id) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        next.set(id, { x: origin.x + (destination.x - origin.x) * eased, y: origin.y + (destination.y - origin.y) * eased })
      }
      commitPositions(next)
      if (progress < 1) animationRef.current = window.requestAnimationFrame(tick)
      else animationRef.current = null
    }
    animationRef.current = window.requestAnimationFrame(tick)
  }, [cancelAnimation, commitPositions])

  useEffect(() => { animateTo(naturalLayout, 'natural') }, [layoutKey])
  useEffect(() => () => cancelAnimation(), [cancelAnimation])

  const beginDrag = (event: ReactPointerEvent<SVGGElement>, nodeId: string) => {
    cancelAnimation()
    dragRef.current = { nodeId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const drag = dragRef.current
    const svg = event.currentTarget.ownerSVGElement
    if (drag === null || svg === null || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
    drag.moved = true
    const point = graphPoint(svg, event.clientX, event.clientY)
    const next = new Map(positionsRef.current)
    next.set(drag.nodeId, point)
    commitPositions(next)
    setLayoutMode('custom')
  }
  const endDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const svg = event.currentTarget.ownerSVGElement
    if (drag.moved && svg !== null) {
      const next = new Map(positionsRef.current)
      next.set(drag.nodeId, graphPoint(svg, event.clientX, event.clientY))
      commitPositions(next)
    }
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!drag.moved) {
      const node = visibleNodes.find(candidate => graphNodeKey(candidate) === drag.nodeId)
      if (node !== undefined) props.onSelect(node)
    }
  }
  const cancelDrag = (event: ReactPointerEvent<SVGGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
  }
  const nudge = (nodeId: string, dx: number, dy: number) => {
    cancelAnimation()
    const current = positionsRef.current.get(nodeId)
    if (current === undefined) return
    const next = new Map(positionsRef.current)
    next.set(nodeId, clampGraphPosition({ x: current.x + dx, y: current.y + dy }))
    commitPositions(next)
    setLayoutMode('custom')
  }
  const layoutLabel = t(layoutMode === 'natural' ? 'graph.layoutNatural' : layoutMode === 'uniform' ? 'graph.layoutUniform' : 'graph.layoutCustom')
  return (
    <>
      <div className={css.graphCanvasControls} role="toolbar" aria-label={t('graph.layoutAria')}>
        <span role="status" aria-label={t('graph.layoutStatus', { layout: layoutLabel })}><i />{t('graph.draggable', { layout: layoutLabel })}</span>
        {props.onQuietChange !== undefined && <button type="button" aria-pressed={props.quiet === true} data-active={props.quiet || undefined} title={t('graph.quietHint')} onClick={() => props.onQuietChange?.(!props.quiet)}>{t('graph.quietAction')}</button>}
        <button type="button" data-active={layoutMode === 'natural' || undefined} onClick={() => animateTo(naturalGraphPositions(visibleNodes, edges), 'natural')}>{t('graph.naturalAction')}</button>
        <button type="button" data-active={layoutMode === 'uniform' || undefined} onClick={() => animateTo(uniformGraphPositions(visibleNodes), 'uniform')}>{t('graph.uniformAction')}</button>
      </div>
      <svg className={css.graphSvg} viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} role="img" data-quiet={props.quiet || undefined} data-layout={layoutMode} data-density={visibleNodes.length <= 12 ? 'sparse' : 'dense'} aria-label={t('graph.aria', { nodes: props.graph.nodes.length, edges: props.graph.edges.length })}
        onClick={() => { if (props.quiet) props.onClearSelection?.() }}
        onKeyDown={event => {
          if (props.quiet && props.selectedId !== undefined && event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            props.onClearSelection?.()
          }
        }}>
      <defs>
        <pattern id="mnemon-grid" width="26" height="26" patternUnits="userSpaceOnUse"><path d="M 26 0 L 0 0 0 26" className={css.graphGridLine} fill="none" /></pattern>
        <filter id="mnemon-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} className={css.graphBackdrop} />
      {!props.quiet && <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#mnemon-grid)" />}
      {curvedEdges.map(({ edge, offset }, index) => {
        const source = positions.get(edge.sourceId) ?? naturalLayout.get(edge.sourceId) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        const target = positions.get(edge.targetId) ?? naturalLayout.get(edge.targetId) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        const dx = target.x - source.x
        const dy = target.y - source.y
        const distance = Math.max(1, Math.hypot(dx, dy))
        const direction = edge.sourceId.localeCompare(edge.targetId) <= 0 ? 1 : -1
        const controlX = (source.x + target.x) / 2 - (dy / distance) * offset * direction
        const controlY = (source.y + target.y) / 2 + (dx / distance) * offset * direction
        return <path key={`${edge.sourceId}-${edge.targetId}-${index}`} d={`M ${source.x} ${source.y} Q ${controlX} ${controlY} ${target.x} ${target.y}`} className={css.graphEdge} data-edge={edge.type ?? 'temporal'} data-dimmed={neighbors !== undefined && !(neighbors.has(edge.sourceId) && neighbors.has(edge.targetId)) || undefined} data-source-id={edge.sourceId} data-target-id={edge.targetId} data-source-kind={visibleKinds.get(edge.sourceId)} data-target-kind={visibleKinds.get(edge.targetId)} />
      })}
      {visibleNodes.map((node, index) => {
        const nodeKey = graphNodeKey(node)
        const position = positions.get(nodeKey) ?? naturalLayout.get(nodeKey) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
        const selected = props.selectedId === nodeKey
        const showLabel = selected || visibleNodes.length < 22 || index % 3 === 0
        return (
          <g key={nodeKey} className={css.graphNode} data-node-id={nodeKey} data-provider={node.memoryProviderId} data-category={node.category ?? 'general'} data-kind={graphNodeKind(node)} data-selected={selected || undefined} data-dimmed={neighbors !== undefined && !neighbors.has(nodeKey) || undefined}
            transform={`translate(${position.x} ${position.y})`} role="button" tabIndex={0} aria-label={`${graphKindLabel(t, node)}: ${short(node.content, 80)}`}
            data-dragging={dragRef.current?.nodeId === nodeKey || undefined}
            onPointerDown={event => beginDrag(event, nodeKey)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
            onClick={event => { if (props.quiet) event.stopPropagation(); props.onSelect(node) }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') props.onSelect(node)
              else if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(nodeKey, -12, 0) }
              else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(nodeKey, 12, 0) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); nudge(nodeKey, 0, -12) }
              else if (event.key === 'ArrowDown') { event.preventDefault(); nudge(nodeKey, 0, 12) }
            }}>
            {graphNodeKind(node) === 'space'
              ? <><rect x={selected ? -20 : -17} y={selected ? -15 : -13} width={selected ? 40 : 34} height={selected ? 30 : 26} rx="9" className={css.nodeHalo} filter={selected ? 'url(#mnemon-glow)' : undefined} /><circle r={selected ? 6 : 5} className={css.nodeCore} /></>
              : graphNodeKind(node) === 'entity'
                ? <><path d={selected ? 'M 0 -18 L 18 0 L 0 18 L -18 0 Z' : 'M 0 -14 L 14 0 L 0 14 L -14 0 Z'} className={css.nodeHalo} filter={selected ? 'url(#mnemon-glow)' : undefined} /><circle r={selected ? 5 : 4} className={css.nodeCore} /></>
                : <><circle r={selected ? 17 : visibleNodes.length <= 12 ? 14 : 11} className={css.nodeHalo} filter={selected ? 'url(#mnemon-glow)' : undefined} /><circle r={selected ? 7 : visibleNodes.length <= 12 ? 6 : 4.5} className={css.nodeCore} /></>}
            {(props.quiet || selected || visibleNodes.length <= 12) && graphNodeKind(node) === 'memory' && node.memoryBodyName !== undefined && <text x="0" y="-18" textAnchor="middle" className={css.nodeBodyLabel}>{short(node.memoryBodyName, 12)}</text>}
            {(props.quiet || showLabel) && <text x={visibleNodes.length <= 12 ? 19 : 15} y="4" className={css.nodeLabel}>{short(node.content.replace(/\s+/gu, ' '), selected ? 34 : visibleNodes.length <= 12 ? 26 : 19)}</text>}
          </g>
        )
      })}
      </svg>
    </>
  )
}
