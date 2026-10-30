import { expect, test } from 'bun:test'
import { surfaceOf } from '../src/director/surfaces/index.ts'

test('a director with no recorded surface retains v1, while an explicit unknown surface is never replaced with v1', () => {
  expect(surfaceOf(null)).toBe('director.v1')
  expect(surfaceOf({ config: {} })).toBe('director.v1')
  expect(surfaceOf({ config: { tool_surface: null } })).toBe('director.v1')
  expect(surfaceOf({ config: { tool_surface: 'director.v1' } })).toBe('director.v1')
  expect(surfaceOf({ config: { tool_surface: 'director.v2' } })).toBe('director.v2')
  for (const tool_surface of ['director.v999', '', 2, false, {}]) {
    expect(() => surfaceOf({ config: { tool_surface } })).toThrow('unsupported director tool surface')
  }
})
