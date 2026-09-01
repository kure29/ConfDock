import { describe, expect, it } from 'vitest'
import type { ValidationResult } from '../core'
import {
  SERVED_POINTER_NOTICE,
  VALIDATION_STATUS_COPY,
  validationScopeCopy,
  validationStatus,
} from './copy'

const result = (diagnostics: ValidationResult['diagnostics']): ValidationResult => ({
  level: 'basic',
  diagnostics,
})

describe('validation copy', () => {
  it('derives the visible status from diagnostic severity', () => {
    expect(validationStatus(result([]))).toBe('clean')
    expect(validationStatus(result([{ severity: 'info', code: 'i', message: 'info', span: null }]))).toBe(
      'clean',
    )
    expect(
      validationStatus(result([{ severity: 'warning', code: 'w', message: 'warning', span: null }])),
    ).toBe('warning')
    expect(
      validationStatus(result([{ severity: 'error', code: 'e', message: 'error', span: null }])),
    ).toBe('error')
  })

  it('uses the plain-language scope descriptions and registry client name', () => {
    expect(validationScopeCopy('basic', 'Surge').detail).toContain('Surge 配置')
    expect(validationScopeCopy('basic', 'Surge').detail).toContain('当前暂不支持')
    expect(validationScopeCopy('syntax').detail).toBe('已检查配置语法。')
    expect(validationScopeCopy('static').detail).toBe('已检查配置语法和已支持的配置规则。')
    expect(validationScopeCopy('native', undefined, false).detail).not.toContain('已使用客户端校验器')
    expect(VALIDATION_STATUS_COPY.error.title).toBe('检查发现问题')
    expect(VALIDATION_STATUS_COPY.warning.title).toBe('检查完成，有需要注意的内容')
    expect(VALIDATION_STATUS_COPY.clean.title).toBe('检查完成')
    expect(SERVED_POINTER_NOTICE).toBe('保存只会更新草稿；发布后客户端才会获取新内容。')
  })
})
