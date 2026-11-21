const text = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''

export function describeModelRequest(wire) {
  const user = (wire.messages ?? []).findLast(message => message.role === 'user')
  const kind = /Completion protocol: call `/u.test(text(wire.system)) ? 'memory task'
    : text(user?.content).startsWith('Generate the session title') ? 'title' : 'conversation'
  return {
    model: wire.model,
    kind,
    tools: (wire.tools ?? []).length,
    ...(wire.thinking?.type === undefined ? {} : { thinking: wire.thinking.type }),
    ...(wire.output_config?.effort === undefined ? {} : { effort: wire.output_config.effort }),
  }
}
