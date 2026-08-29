/**
 * Private Host binding keys used while a generation creates built-in Source
 * runtimes. They are ordinary factory inputs, never Cordis Context services.
 */
export const BUILTIN_MEMORY_BINDINGS = Object.freeze({
  runtime: 'dsh-mnemon.binding.runtime-memory',
  documents: 'dsh-mnemon.binding.documents',
  memorySpaces: 'dsh-mnemon.binding.memory-spaces',
})
