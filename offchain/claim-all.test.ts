import { expect, test } from 'bun:test'
import { selectUnclaimed, type ManifestEntry } from './claim-all'

const e = (holder: string): ManifestEntry => ({ holder, amounts: ['1'], proof: ['0x00'] })

test('selectUnclaimed keeps only holders whose claimed flag is false', () => {
  const entries = [e('0xa0'), e('0xa1'), e('0xa2')]
  const out = selectUnclaimed(entries, [false, true, false])
  expect(out.map((x) => x.holder)).toEqual(['0xa0', '0xa2'])
})

test('selectUnclaimed returns nothing when all are claimed', () => {
  const entries = [e('0xa0'), e('0xa1')]
  expect(selectUnclaimed(entries, [true, true])).toEqual([])
})

test('selectUnclaimed throws on a length mismatch (guards a mis-aligned read)', () => {
  expect(() => selectUnclaimed([e('0xa0')], [false, false])).toThrow(/length/)
})
