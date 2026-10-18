import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import { CacheStore } from '../../cache/store.js'
import { DEFAULT_CACHE_DIR, findConfigFile, loadConfigFile, resolveConfig } from '../../config/load.js'
import { embedTexts } from '../../embeddings/embed.js'
import { RagChunkerError } from '../../errors.js'
import {
  type Comparison,
  compareReports,
  type EvalReport,
  evaluate,
  generateQuestions,
  type QuestionSet,
} from '../../eval/eval.js'
import { createReranker, RERANKERS, resolveReranker } from '../../local/reranker.js'
import { readOutputDir } from '../../output/writer.js'
import { Reporter } from '../../pipeline/events.js'
import { ProviderRegistry } from '../../providers/registry.js'
import type { Reranker } from '../../search/search.js'
import { cliEnv } from '../env.js'
import { err, out, ProgressRenderer, parseIntOption, reportError, sym } from '../ui.js'

interface EvalFlags {
  model?: string
  questions?: number
  questionsFile?: string
  embedding?: string
  rerank?: string | boolean
  compare?: boolean
  config?: string
  json?: boolean
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

/** Folder names, with as much of the path as needed to tell folders with the same name apart. */
export function outputLabels(outputs: string[]): string[] {
  const parts = outputs.map((o) => resolve(o).split(sep).filter(Boolean))
  return parts.map((p, i) => {
    for (let n = 1; n < p.length; n++) {
      const tail = p.slice(-n).join('/')
      if (parts.every((q, j) => j === i || q.slice(-n).join('/') !== tail)) return tail
    }
    return p.join('/')
  })
}

const signed = (n: number, digits: number, suffix = '') =>
  `${n >= 0 ? '+' : ''}${(suffix === '%' ? n * 100 : n).toFixed(digits)}${suffix}`

/** Per-question view: which output (or mode) finds the answer earlier, and where the ranks moved. */
function printComparison(cmp: Comparison): void {
  const [base, ...others] = cmp.columns
  if (!base) return
  const width = Math.max(8, ...cmp.columns.map((c) => c.label.length))
  err(
    `  ${pc.bold('Compare')} ${pc.dim(`baseline ${base.label}${others.length > 0 && others.every((c) => c.mode === base.mode) ? ` (mode ${base.mode})` : ''}`)}`,
  )
  for (const c of others) {
    err(
      `  ${c.label.padEnd(width)} MRR ${c.metrics.mrr.toFixed(3)} ${pc.dim(`(${signed(c.deltaMrr, 3)})`)}  hit@5 ${pct(c.metrics.hitAt5)} ${pc.dim(`(${signed(c.metrics.hitAt5 - base.metrics.hitAt5, 1, '%')})`)}  ${pc.green(`↑${c.improved}`)} ${pc.red(`↓${c.regressed}`)}`,
    )
  }
  const changed = cmp.questions
    .map((q, i) => ({ q, ranks: cmp.columns.map((c) => c.ranks[i] as number) }))
    .filter(({ ranks }) => ranks.some((r) => r !== ranks[0]))
  if (changed.length === 0) {
    err(pc.dim('  Every question ranks the same.'))
    err()
    return
  }
  err(
    pc.dim(
      `  Questions whose rank changed (${cmp.columns.map((c) => c.label).join(' → ')}; 0 = not in top 10):`,
    ),
  )
  for (const { q, ranks } of changed) {
    const text = q.question.length > 70 ? `${q.question.slice(0, 69)}…` : q.question
    err(
      `   ${pc.dim(`#${String(q.id).padStart(2)}`)}  ${ranks.join(' → ').padEnd(cmp.columns.length * 4)}  ${text}`,
    )
  }
  err()
}

function printTable(reports: EvalReport[]): void {
  const labels = outputLabels(reports.map((r) => r.output))
  const width = Math.max(6, ...labels.map((l) => l.length))
  err()
  err(
    `  ${pc.bold('Output'.padEnd(width))} ${'mode'.padEnd(7)} ${'hit@1'.padStart(7)} ${'hit@5'.padStart(7)} ${'hit@10'.padStart(7)} ${'MRR'.padStart(6)} ${'chunks'.padStart(7)}`,
  )
  reports.forEach((r, i) => {
    for (const m of r.metrics) {
      err(
        `  ${(labels[i] as string).padEnd(width)} ${m.mode.padEnd(7)} ${pct(m.hitAt1).padStart(7)} ${pct(m.hitAt5).padStart(7)} ${pct(m.hitAt10).padStart(7)} ${m.mrr.toFixed(3).padStart(6)} ${String(r.chunks).padStart(7)}`,
      )
    }
  })
  err()
}

export function evalCommand(): Command {
  return new Command('eval')
    .description(
      'Measure retrieval quality with generated questions (compare several output folders of the same document)',
    )
    .argument('<dirs...>', 'output folders written by `rag-chunker process`')
    .option('--model <model>', 'LLM that writes the questions, e.g. ollama/gemma4:e4b-it-qat')
    .option('--questions <n>', 'number of questions (default 30)', parseIntOption('questions'))
    .option('--questions-file <file>', 'reuse a question set instead of generating one')
    .option(
      '--embedding <model>',
      'embedding model for vector/hybrid search (default: the one in the manifest)',
    )
    .option(
      '--rerank [model]',
      'add a "rerank" mode: a local cross-encoder reorders the top candidates (default model mmarco-minilm, downloads 120 MB once)',
    )
    .option('--no-rerank', 'no reranking even when the model is downloaded')
    .option(
      '--compare',
      'show which questions each output (or, with one output, each mode) answers better; writes eval-compare.json',
    )
    .option('-c, --config <file>', 'config file')
    .option('--json', 'print the report as JSON')
    .action(async (dirs: string[], flags: EvalFlags) => {
      const renderer = new ProgressRenderer(!flags.json)
      let registry: ProviderRegistry | undefined
      try {
        const env = await cliEnv()
        const configFile = flags.config ?? findConfigFile()
        const config = resolveConfig(configFile ? await loadConfigFile(configFile) : undefined)
        registry = new ProviderRegistry({ config, env })
        const cache = new CacheStore(config.cache.enabled ? (config.cache.dir ?? DEFAULT_CACHE_DIR) : null)
        const rerankPlan = await resolveReranker(config, flags.rerank)
        let reranker: Reranker | undefined
        if (rerankPlan.id) {
          if (rerankPlan.download)
            renderer.print(
              `  ${pc.dim(`downloading reranker ${rerankPlan.id} (${RERANKERS[rerankPlan.id].label})…`)}`,
            )
          reranker = await createReranker(rerankPlan.id)
        }
        const outputs = await Promise.all(dirs.map((d) => readOutputDir(d)))
        const first = outputs[0]
        if (!first) throw new RagChunkerError('INPUT_INVALID', 'No output folder given')
        if (outputs.some((o) => o.manifest.source.documentId !== first.manifest.source.documentId)) {
          err(
            `  ${sym.warn} ${pc.yellow('The folders come from different documents; questions follow the first one.')}`,
          )
        }

        let set: QuestionSet
        if (flags.questionsFile) {
          set = JSON.parse(await readFile(flags.questionsFile, 'utf8')) as QuestionSet
        } else {
          const model = flags.model ?? config.models.context
          if (!model) {
            throw new RagChunkerError('CONFIG_INVALID', 'eval needs a model to write questions', {
              hint: 'Pass --model <provider/model> (or set models.context in the config).',
            })
          }
          const res = await generateQuestions(
            {
              markdown: first.markdown,
              documentId: first.manifest.source.documentId,
              source: first.manifest.source.name,
            },
            {
              llm: registry.llm(model),
              count: flags.questions ?? 30,
              cache,
              reporter: new Reporter(renderer.handle),
            },
          )
          set = res.set
          const file = join(dirs[0] as string, 'eval-questions.json')
          await writeFile(file, `${JSON.stringify(set, null, 2)}\n`)
          renderer.print(`  ${sym.ok} ${set.questions.length} questions ${pc.dim(`→ ${file}`)}`)
        }
        if (set.questions.length === 0)
          throw new RagChunkerError('INPUT_INVALID', 'No usable questions were generated')

        const reports: EvalReport[] = []
        for (const [i, o] of outputs.entries()) {
          const embeddingModel = flags.embedding ?? o.manifest.stages.embedding?.model
          let queryVectors: number[][] | undefined
          let chunks = o.chunks
          if (embeddingModel) {
            const embedder = registry.embedder(embeddingModel)
            if (
              !chunks.every((c) => c.embedding.length > 0) ||
              (flags.embedding && flags.embedding !== o.manifest.stages.embedding?.model)
            ) {
              const res = await embedTexts(
                chunks.map((c) => c.content),
                { embedder, kind: 'document', cache, dimensions: config.embedding.dimensions },
              )
              chunks = chunks.map((c, j) => ({ ...c, embedding: res.vectors[j] as number[] }))
            }
            const q = await embedTexts(
              set.questions.map((x) => x.question),
              { embedder, kind: 'query', cache, dimensions: config.embedding.dimensions },
            )
            queryVectors = q.vectors
          }
          const report = await evaluate(set, chunks, dirs[i] as string, queryVectors, {
            reranker,
            candidates: config.rerank.candidates,
          })
          reports.push(report)
          await writeFile(join(dirs[i] as string, 'eval.json'), `${JSON.stringify(report, null, 2)}\n`)
        }
        renderer.stop()
        const comparison = flags.compare ? compareReports(reports, outputLabels(dirs)) : null
        if (comparison) {
          await writeFile(
            join(dirs[0] as string, 'eval-compare.json'),
            `${JSON.stringify(comparison, null, 2)}\n`,
          )
        }
        if (flags.json) out(JSON.stringify(comparison ? { reports, comparison } : reports, null, 2))
        else {
          printTable(reports)
          if (comparison) printComparison(comparison)
        }
      } catch (e) {
        renderer.stop()
        process.exitCode = reportError(e)
      } finally {
        await registry?.dispose()
      }
    })
}
