import pino from 'pino'

export interface ILogger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

export function createDefaultLogger(): ILogger {
  return pino({ level: 'info' })
}
