import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { errorMessage } from './util.js'

/**
 * Resolve one HMAC secret per operation. Resolution order is the DSH
 * credential seam, then the process environment, then a local 0600 secret
 * file. A missing secret is generated once (32 random bytes) when allowed, so
 * a fresh install works without a plaintext secret in the patch.
 */
export class SecretStore {
  /** @param {import('@deepseek-ai/cordis').Context} ctx @param {string} dataDir */
  constructor(ctx, dataDir) {
    this.ctx = ctx
    this.dataDir = dataDir
    this.file = join(dataDir, 'secret')
    this.lastSource = 'unresolved'
    this.generated = false
  }

  async readFileSecret() {
    try {
      const value = (await readFile(this.file, 'utf8')).trim()
      if (value.length < 32) throw new Error(`secret file ${this.file} is shorter than 32 characters`)
      return value
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * @param {string} ref credential/environment reference.
   * @param {{autoGenerate?: boolean}} options
   * @returns {Promise<{value: string, source: string}>}
   */
  async resolve(ref, { autoGenerate = true } = {}) {
    const credentials = this.ctx.get?.('credentials')
    if (credentials && ref) {
      try {
        const resolved = await credentials.resolve(ref)
        if (resolved?.value) {
          this.lastSource = `credential:${resolved.source ?? ref}`
          return { value: resolved.value, source: this.lastSource }
        }
      } catch (error) {
        this.ctx.logger?.debug?.(`[erp-bridge] credential ${ref} did not resolve: ${errorMessage(error)}`)
      }
    }
    if (ref && process.env[ref]) {
      this.lastSource = `env:${ref}`
      return { value: process.env[ref], source: this.lastSource }
    }
    const fileValue = await this.readFileSecret()
    if (fileValue) {
      this.lastSource = `file:${this.file}`
      return { value: fileValue, source: this.lastSource }
    }
    if (!autoGenerate) throw new Error(`no HMAC secret for ${ref || 'erp-bridge'}; set ${ref || 'DSH_ERP_HMAC_SECRET'} or provide dataDir/secret`)
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    const value = randomBytes(32).toString('hex')
    await writeFile(this.file, `${value}\n`, { mode: 0o600 })
    this.generated = true
    this.lastSource = `generated:${this.file}`
    this.ctx.logger?.warn?.(`[erp-bridge] generated a new HMAC secret at ${this.file}; configure ${ref || 'DSH_ERP_HMAC_SECRET'} for production`)
    return { value, source: this.lastSource }
  }

  /** Describe whether a secret currently resolves, without returning it. */
  async describe(ref) {
    try {
      const resolved = await this.resolve(ref, { autoGenerate: false })
      return { configured: true, source: resolved.source }
    } catch {
      return { configured: false }
    }
  }
}
