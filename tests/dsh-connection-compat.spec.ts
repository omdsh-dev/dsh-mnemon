import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it } from 'vitest'
import type {
  HostConnectionHandle,
  HostRpcHandler,
  HostRpcRegistrationOptions,
  HostSettingsService,
} from "../src/host/dsh.ts"
import { registerSettingsRpc } from "../src/host/settings.ts"
import { MNEMON_SETTINGS_CHANNEL } from "../src/host/protocol.ts"

interface RegisteredRoute {
  path: string
}

interface BranchFreeConnection {
  rpc: {
    handle(
      channel: string,
      handler: HostRpcHandler,
      options: HostRpcRegistrationOptions,
    ): () => Promise<void>
  }
}

type BranchFreeConnectionConstructor = new (
  context: Context,
  trustedHosts: readonly string[],
  browserAuth: {
    isAuthenticated(request: unknown): boolean
    authorizeIndex(request: unknown, response: unknown): boolean
    authenticatedUrl(baseUrl: string): string
  },
) => BranchFreeConnection

describe('released and source DSH Connection compatibility', () => {
  it('registers the same legacy-options call against the active real implementation', async () => {
    const routes: RegisteredRoute[] = []
    const context = new Context()
    context.provide('webServer', {
      register(route: RegisteredRoute) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    } as never)
    const Connection = HostConnectionService as unknown as BranchFreeConnectionConstructor
    const connection = new Connection(context, [], {
      isAuthenticated: () => true,
      authorizeIndex: () => true,
      authenticatedUrl: value => value,
    })

    registerSettingsRpc(
      connection as unknown as HostConnectionHandle,
      {} as HostSettingsService,
    )

    expect(routes.map(route => route.path)).toEqual([MNEMON_SETTINGS_CHANNEL])
  })
})
