import { HttpGatewayAdapter } from './http-gateway.js'
import { MockAdapter } from './mock.js'
import { OdooAdapter } from './odoo.js'

/**
 * Build the one adapter this bridge process owns. Vendor differences end at
 * this boundary; the engine never learns a vendor name.
 */
export function createAdapter(config, deps) {
  switch (config.id) {
    case 'mock':
      return new MockAdapter()
    case 'odoo':
      return new OdooAdapter(config, deps)
    case 'http-gateway':
      return new HttpGatewayAdapter(config, deps)
    default:
      throw new Error(`unsupported adapter id "${config.id}"`)
  }
}
