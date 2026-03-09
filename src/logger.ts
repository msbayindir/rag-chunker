import pino from 'pino'

export interface ILogger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

export function createDefaultLogger(): ILogger {
  const p = pino({
    level: 'info',
    serializers: { err: pino.stdSerializers.err }
  })
  return {
    debug: (msg, meta) => p.debug(meta != null ? (meta as object) : {}, msg),
    info:  (msg, meta) => p.info(meta != null ? (meta as object) : {}, msg),
    warn:  (msg, meta) => p.warn(meta != null ? (meta as object) : {}, msg),
    error: (msg, meta) => p.error(meta != null ? (meta as object) : {}, msg),
  }
}
