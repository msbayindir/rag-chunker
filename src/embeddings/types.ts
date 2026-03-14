export interface IEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  readonly dimensions: number
  readonly providerName: string
}
