export type Stage = 'read' | 'ocr' | 'structure' | 'chunk' | 'context' | 'embedding' | 'write'

export type ProgressEvent =
  | { type: 'stage-start'; stage: Stage; detail?: string }
  | { type: 'progress'; stage: Stage; done: number; total: number; detail?: string }
  | { type: 'stage-end'; stage: Stage; detail?: string; skipped?: boolean }
  | { type: 'warning'; stage: Stage; message: string }

export type ProgressListener = (event: ProgressEvent) => void

/** Small helper that never lets a throwing listener break the pipeline. */
export class Reporter {
  readonly warnings: string[] = []

  constructor(private readonly listener?: ProgressListener) {}

  emit(event: ProgressEvent): void {
    if (event.type === 'warning') this.warnings.push(event.message)
    try {
      this.listener?.(event)
    } catch {
      // Listeners are for display only.
    }
  }

  start(stage: Stage, detail?: string): void {
    this.emit({ type: 'stage-start', stage, detail })
  }

  progress(stage: Stage, done: number, total: number, detail?: string): void {
    this.emit({ type: 'progress', stage, done, total, detail })
  }

  end(stage: Stage, detail?: string, skipped = false): void {
    this.emit({ type: 'stage-end', stage, detail, skipped })
  }

  warn(stage: Stage, message: string): void {
    this.emit({ type: 'warning', stage, message })
  }
}
