import pino from 'pino'
import chalk from 'chalk'

export interface ILogger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

/** Default library logger — structured JSON via pino. For programmatic use. */
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

/** CLI logger — human-readable, colored output to stderr. No JSON. */
export function createCliLogger(verbose = false): ILogger {
  const write = (line: string) => process.stderr.write(line + '\n')
  return {
    debug: (msg) => {
      if (verbose) write(chalk.gray('  · ' + msg))
    },
    info: (msg) => {
      write(chalk.cyan('  ›') + '  ' + chalk.dim(msg))
    },
    warn: (msg) => {
      write(chalk.yellow('  !') + '  ' + chalk.yellow(msg))
    },
    error: (msg) => {
      write(chalk.red('  ✗') + '  ' + chalk.red(msg))
    },
  }
}
