import { describe, expect, it } from 'vitest'
import { createMutationGate } from './useProject'

describe('project mutation gate', () => {
  it('serializes Save and Publish admission synchronously', () => {
    const gate = createMutationGate()
    let requests = 0
    const publish = gate.begin('publish', 'p1')
    expect(publish).not.toBeNull()
    requests += 1
    expect(gate.begin('save', 'p1')).toBeNull()
    expect(gate.begin('publish', 'p1')).toBeNull()
    expect(requests).toBe(1)
  })

  it('serializes Save retries and allows the next write only after finish', () => {
    const gate = createMutationGate()
    const save = gate.begin('save', 'p1')
    expect(save).not.toBeNull()
    expect(gate.begin('save', 'p1')).toBeNull()
    expect(gate.finish(save!)).toBe(true)
    expect(gate.begin('save', 'p1')).not.toBeNull()
  })

  it('invalidates old responses and finally handlers after a project switch', () => {
    const gate = createMutationGate()
    const oldPublish = gate.begin('publish', 'p1')
    expect(oldPublish).not.toBeNull()
    gate.invalidate()
    const newSave = gate.begin('save', 'p2')
    expect(newSave).not.toBeNull()
    expect(gate.isCurrent(oldPublish!)).toBe(false)
    expect(gate.finish(oldPublish!)).toBe(false)
    expect(gate.isCurrent(newSave!)).toBe(true)
    expect(gate.finish(newSave!)).toBe(true)
  })

  it('keeps the active mutation token while a stale response completes', () => {
    const gate = createMutationGate()
    const publish = gate.begin('publish', 'p1')
    expect(publish).not.toBeNull()
    expect(gate.finish({ ...publish!, projectId: 'p2' })).toBe(false)
    expect(gate.isCurrent(publish!)).toBe(true)
    expect(gate.finish(publish!)).toBe(true)
  })
})
