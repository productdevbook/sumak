/**
 * Thrown for user-facing CLI failures — a bad config, a missing file,
 * a driver that refused to connect. The CLI catches `CliError` and
 * prints only the message; any other throw gets a full stack trace
 * so genuine bugs still surface.
 */
export class CliError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "CliError"
  }
}
