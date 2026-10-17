import { generateFixtures } from '../fixtures/generate.js'

export default async function setup(): Promise<void> {
  await generateFixtures()
}
