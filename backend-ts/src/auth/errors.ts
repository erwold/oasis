/** The credential errors: none of their messages contains a token. */

export class NativeAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'NativeAuthError' }
}

/** A retryable refresh outage, separate from a rejected grant. */
export class NativeAuthTemporaryError extends NativeAuthError {
  readonly status_code: number | null
  constructor(message: string, statusCode: number | null = null) {
    super(message)
    this.name = 'NativeAuthTemporaryError'
    this.status_code = statusCode
  }
}

/** The provider rejected the grant permanently; an interactive login is needed. */
export class LoginRequired extends NativeAuthError {
  constructor(message: string) { super(message); this.name = 'LoginRequired' }
}
