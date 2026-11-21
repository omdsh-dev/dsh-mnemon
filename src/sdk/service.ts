import type { MemoryPluginDescriptor, MemorySourceDefinition, MemoryStrategyDefinition, MemoryStrategyExtensionDefinition } from '../core/contracts/index.ts'

export interface MemoryInstallContribution {
  plugin?: MemoryPluginDescriptor
  sources?: readonly MemorySourceDefinition[]
  strategies?: readonly MemoryStrategyDefinition[]
  strategyExtensions?: readonly MemoryStrategyExtensionDefinition[]
}

export interface InstallMemoryOptions {
  instanceId?: string
  artifactDigest?: string
  effectiveDigest?: string
}

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
