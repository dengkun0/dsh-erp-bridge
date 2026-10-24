import { ErpBridge } from './lib/bridge.js'

export const inject = ['tools']

/**
 * Mount the ERP bridge. Configuration is validated here (a bad row fails the
 * plugin with a precise message); I/O starts inside the effect and is torn
 * down when the row unloads.
 */
export function apply(ctx, config) {
  const bridge = new ErpBridge(ctx, config)
  ctx.effect(() => {
    const dispose = bridge.start()
    return () => {
      void dispose()
    }
  }, 'dsh-erp-bridge')
}
