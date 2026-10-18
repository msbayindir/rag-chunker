import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/load.js'
import { RagChunkerError } from '../../src/errors.js'
import { resolveReranker } from '../../src/local/reranker.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { json, MockServer } from '../helpers/mock-server.js'

const server = new MockServer()
beforeAll(async () => {
  await server.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(() => server.reset())

const registry = (name: 'cohere' | 'jina', env: Record<string, string> = {}) =>
  new ProviderRegistry({
    config: resolveConfig({ providers: { [name]: { baseURL: server.url } } }),
    env,
  })

describe('hosted rerankers', () => {
  it('calls Cohere /rerank and maps the scores back to the document order', async () => {
    server.on('POST', '/rerank', (_r, res) =>
      json(res, 200, {
        results: [
          { index: 2, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.4 },
          { index: 1, relevance_score: 0.05 },
        ],
      }),
    )
    const reranker = registry('cohere', { COHERE_API_KEY: 'test-key' }).reranker('cohere/rerank-v3.5')
    const scores = await reranker.score('hiponatremi tedavisi', ['a', 'b', 'c'])
    expect(scores).toEqual([0.4, 0.05, 0.91])
    const req = server.requests[0]
    expect(req?.path).toBe('/rerank')
    expect(req?.headers.authorization).toBe('Bearer test-key')
    expect(req?.body).toMatchObject({
      model: 'rerank-v3.5',
      query: 'hiponatremi tedavisi',
      documents: ['a', 'b', 'c'],
      top_n: 3,
    })
    expect((req?.body as Record<string, unknown>).return_documents).toBeUndefined()
  })

  it('calls Jina with return_documents off and tolerates missing indexes', async () => {
    server.on('POST', '/rerank', (_r, res) =>
      json(res, 200, { results: [{ index: 1, relevance_score: 0.7 }] }),
    )
    const reranker = registry('jina', { JINA_API_KEY: 'j' }).reranker(
      'jina/jina-reranker-v2-base-multilingual',
    )
    expect(await reranker.score('q', ['x', 'y'])).toEqual([0, 0.7])
    expect(await reranker.score('q', [])).toEqual([])
    expect((server.requests[0]?.body as Record<string, unknown>).return_documents).toBe(false)
  })

  it('needs a key, and refuses to act as a language model', () => {
    // The hosted endpoint needs a key; a localhost base URL (as in the other tests) counts as local and does not.
    const hosted = new ProviderRegistry({ config: resolveConfig({}), env: {} })
    expect(() => hosted.reranker('cohere/rerank-v3.5')).toThrow(RagChunkerError)
    expect(() => hosted.reranker('jina/jina-reranker-v2-base-multilingual')).toThrow(/needs an API key/)
    expect(() => registry('cohere', { COHERE_API_KEY: 'k' }).llm('cohere/command-a')).toThrow(
      /reranking provider/,
    )
  })

  it('resolves provider/model rerankers from the config or the flag without any download', async () => {
    const config = resolveConfig({ rerank: { engine: 'cohere/rerank-v3.5' } })
    expect(await resolveReranker(config)).toEqual({ id: null, ref: 'cohere/rerank-v3.5', download: false })
    expect(await resolveReranker(resolveConfig({}), 'jina/jina-reranker-v2-base-multilingual')).toMatchObject(
      {
        ref: 'jina/jina-reranker-v2-base-multilingual',
      },
    )
    expect(await resolveReranker(config, false)).toMatchObject({ id: null, reason: 'disabled by flag' })
    expect(() => resolveConfig({ rerank: { engine: 'nope' } })).toThrow()
  })
})
