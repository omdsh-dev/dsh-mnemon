import { MnemonStoreIdentity } from './mnemon-store-identity.ts'

export class MemorySpaceIdentity {
  readonly #identity: MnemonStoreIdentity

  constructor(parent: string) {
    this.#identity = new MnemonStoreIdentity(parent)
  }

  of(bytes: Uint8Array): string {
    return this.#identity.of(bytes)
  }

  contains(outer: Uint8Array, inner: Uint8Array): boolean {
    return this.#identity.contains(outer, inner)
  }

  merge(local: Uint8Array, incoming: Uint8Array): Uint8Array | undefined {
    return this.#identity.merge(local, incoming)
  }

  dispose(): void {
    this.#identity.dispose()
  }
}
