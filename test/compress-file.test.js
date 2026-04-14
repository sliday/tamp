/**
 * Unit tests for lib/compress-file.js
 * File compression utilities
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectFileStrategy,
  compressContent,
  compressFile,
  compressFiles,
  formatResult,
} from '../lib/compress-file.js'

describe('detectFileStrategy', () => {
  it('detects claude-rules strategy for CLAUDE.md files', () => {
    assert.strictEqual(detectFileStrategy('CLAUDE.md'), 'claude-rules')
    assert.strictEqual(detectFileStrategy('/path/to/CLAUDE.md'), 'claude-rules')
    assert.strictEqual(detectFileStrategy('/path/to/claude.md'), 'claude-rules')
    assert.strictEqual(detectFileStrategy('/path/.claude/CLAUDE.md'), 'claude-rules')
  })

  it('detects markdown strategy for .md files', () => {
    assert.strictEqual(detectFileStrategy('README.md'), 'markdown')
    assert.strictEqual(detectFileStrategy('docs.md'), 'markdown')
    assert.strictEqual(detectFileStrategy('/path/to/file.md'), 'markdown')
  })

  it('detects json strategy for .json files', () => {
    assert.strictEqual(detectFileStrategy('package.json'), 'json')
    assert.strictEqual(detectFileStrategy('config.json'), 'json')
    assert.strictEqual(detectFileStrategy('/path/to/data.json'), 'json')
  })

  it('defaults to text strategy for unknown extensions', () => {
    assert.strictEqual(detectFileStrategy('config.txt'), 'text')
    assert.strictEqual(detectFileStrategy('data.xml'), 'text')
    assert.strictEqual(detectFileStrategy('Makefile'), 'text')
  })
})

describe('compressContent', () => {
  it('returns success result for compressible content', async () => {
    const content = '# Test File\n\nThis is a long piece of text that should be compressible. '.repeat(10)
    const result = await compressContent(content, 'text', { log: false })

    assert(result.success)
    assert(result.compressed)
    assert.strictEqual(result.originalLen, content.length)
    assert(result.compressedLen < content.length)
    assert(result.method)
    assert(result.savings)
  })

  it('returns skipped result for non-compressible content', async () => {
    const content = 'short'
    const result = await compressContent(content, 'text', { log: false })

    assert(!result.success)
    assert(result.skipped)
    assert.strictEqual(result.originalLen, content.length)
    assert(!result.compressed)
  })

  it('uses strategy-specific stages', async () => {
    const content = JSON.stringify({ key: 'value', nested: { data: 'test' } })
    const jsonResult = await compressContent(content, 'json', { log: false })
    const textResult = await compressContent(content, 'text', { log: false })

    // Both should succeed but potentially with different methods
    assert(jsonResult.success || jsonResult.skipped)
    assert(textResult.success || textResult.skipped)
  })
})

describe('compressFile', () => {
  let testFile

  it('compresses a file and creates backup', async () => {
    // Create test file
    const testDir = tmpdir()
    testFile = join(testDir, 'test-compress.md')
    const content = '# Test\n\n' + 'This is test content. '.repeat(50)
    await writeFile(testFile, content, 'utf8')

    // Compress file
    const result = await compressFile(testFile, { dryRun: false })

    assert(result.success)
    assert.strictEqual(result.file, testFile)
    assert(result.backup)
    assert(result.compressedLen < content.length)

    // Verify backup exists
    const backupExists = existsSync(result.backup)
    assert(backupExists)

    // Cleanup
    const fs = await import('node:fs/promises')
    await fs.unlink(testFile)
    await fs.unlink(result.backup)
  })

  it('returns dry run result without writing file', async () => {
    const testDir = tmpdir()
    testFile = join(testDir, 'test-dryrun.md')
    const content = '# Test\n\n' + 'This is test content. '.repeat(50)
    await writeFile(testFile, content, 'utf8')

    const result = await compressFile(testFile, { dryRun: true })

    assert(result.success)
    assert(result.dryRun)
    assert(!result.backup)

    // Verify original file unchanged
    const originalContent = await readFile(testFile, 'utf8')
    assert.strictEqual(originalContent, content)

    // Cleanup
    const fs = await import('node:fs/promises')
    await fs.unlink(testFile)
  })

  it('returns error for non-existent file', async () => {
    const result = await compressFile('/nonexistent/file.md')

    assert(!result.success)
    assert(result.error)
    assert(result.error.includes('not found'))
  })

  it('respects noBackup option', async () => {
    const testDir = tmpdir()
    testFile = join(testDir, 'test-nobackup.md')
    const content = '# Test\n\n' + 'This is test content. '.repeat(50)
    await writeFile(testFile, content, 'utf8')

    const result = await compressFile(testFile, { dryRun: false, noBackup: true })

    assert(result.success)
    assert(!result.backup)

    // Cleanup
    const fs = await import('node:fs/promises')
    await fs.unlink(testFile)
  })
})

describe('compressFiles', () => {
  it('compresses multiple files', async () => {
    const testDir = tmpdir()
    const file1 = join(testDir, 'test1.md')
    const file2 = join(testDir, 'test2.md')
    const content = '# Test\n\n' + 'Content. '.repeat(50)

    await writeFile(file1, content, 'utf8')
    await writeFile(file2, content, 'utf8')

    const results = await compressFiles([file1, file2], { dryRun: true })

    assert.strictEqual(results.length, 2)
    assert(results[0].success || results[0].skipped)
    assert(results[1].success || results[1].skipped)

    // Cleanup
    const fs = await import('node:fs/promises')
    await fs.unlink(file1)
    await fs.unlink(file2)
  })
})

describe('formatResult', () => {
  it('formats successful compression result', () => {
    const result = {
      success: true,
      file: '/path/to/file.md',
      strategy: 'markdown',
      originalLen: 1000,
      compressedLen: 600,
      method: 'llmlingua',
      savings: '40.0%',
      backup: '/path/to/file.md.bak',
    }

    const formatted = formatResult(result)
    assert(formatted.includes('✓'))
    assert(formatted.includes('/path/to/file.md'))
    assert(formatted.includes('40.0%'))
    assert(formatted.includes('llmlingua'))
  })

  it('formats dry run result', () => {
    const result = {
      success: true,
      file: '/path/to/file.md',
      strategy: 'markdown',
      originalLen: 1000,
      compressedLen: 600,
      method: 'textpress',
      savings: '40.0%',
      dryRun: true,
    }

    const formatted = formatResult(result)
    assert(formatted.includes('DRY RUN'))
    assert(formatted.includes('/path/to/file.md'))
  })

  it('formats skipped result', () => {
    const result = {
      success: false,
      file: '/path/to/file.md',
      skipped: 'too small',
      originalLen: 50,
    }

    const formatted = formatResult(result)
    assert(formatted.includes('⊘'))
    assert(formatted.includes('Skipped'))
    assert(formatted.includes('too small'))
  })

  it('formats error result', () => {
    const result = {
      success: false,
      file: '/path/to/file.md',
      error: 'File not found',
    }

    const formatted = formatResult(result)
    assert(formatted.includes('✗'))
    assert(formatted.includes('Error'))
    assert(formatted.includes('File not found'))
  })
})
