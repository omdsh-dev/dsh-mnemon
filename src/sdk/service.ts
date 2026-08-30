import type { MemorySourceDefinition, MemoryStrategyDefinition } from '../core/contracts/index.ts'

export interface MemoryInstallContribution {
  sources?: readonly MemorySourceDefinition[]
  strategies?: readonly MemoryStrategyDefinition[]
}

export interface InstallMemoryOptions {
  /** Required for a direct ctx.plugin() mount that has no stable Loader Entry. */
  instanceId?: string
  artifactDigest?: string
  /** Source-private dependency digest, opaque to Mnemon core. */
  effectiveDigest?: string
}

/**
 * The only Mnemon-wide Cordis service: accept plugin definitions, not engine
 * objects. Use installMemory(ctx, ...) to resolve the calling Entry identity
 * and bind the returned registration disposer to its Fiber.
 */
export interface MnemonMemoryService {
  installContributions(
    contribution: MemoryInstallContribution,
    options: InstallMemoryOptions & { instanceId: string },
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mnemonMemory: MnemonMemoryService
  }
}
