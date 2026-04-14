/**
 * File compression utilities for Tamp config and CLAUDE.md files
 * Inspired by JuliusBrussee/caveman-compress
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { compressText } from '../compress.js'

/**
 * Compression strategies for different file types
 */
const STRATEGIES = Object.freeze({
  'claude-rules': {
    stages: ['textpress', 'strip-comments', 'whitespace'],
    preserveStructure: true,
    minSize: 100,
  },
  markdown: {
    stages: ['textpress', 'whitespace'],
    preserveStructure: true,
    minSize: 200,
  },
  json: {
    stages: ['minify', 'toon', 'prune'],
    preserveStructure: false,
    minSize: 100,
  },
  text: {
    stages: ['textpress', 'whitespace'],
    preserveStructure: true,
    minSize: 200,
  },
})

/**
 * Detect file strategy based on path and content
 * @param {string} filePath - Path to file
 * @returns {string} - Strategy name
 */
export function detectFileStrategy(filePath) {
  const filename = basename(filePath).toLowerCase()

  // CLAUDE.md files get special treatment
  if (filename.includes('claude.md')) {
    return 'claude-rules'
  }

  const ext = extname(filePath).toLowerCase()

  if (ext === '.md') return 'markdown'
  if (ext === '.json') return 'json'
  return 'text'
}

/**
 * Compress a file's content
 * @param {string} content - File content
 * @param {string} strategy - Strategy name
 * @param {object} options - Compression options
 * @returns {Promise<{success: boolean, compressed?: string, originalLen?: number, compressedLen?: number, method?: string, skipped?: string}>}
 */
export async function compressContent(content, strategy, options = {}) {
  const strategyConfig = STRATEGIES[strategy] || STRATEGIES.text

  // Build compression config
  const compressConfig = {
    minSize: strategyConfig.minSize,
    stages: strategyConfig.stages,
    log: options.log || false,
    ...options.compressionConfig,
  }

  try {
    const result = compressText(content, compressConfig)

    if (!result) {
      return {
        success: false,
        skipped: 'not-compressible',
        originalLen: content.length,
      }
    }

    return {
      success: true,
      compressed: result.text,
      originalLen: content.length,
      compressedLen: result.text.length,
      method: result.method || 'unknown',
      savings: ((content.length - result.text.length) / content.length * 100).toFixed(1) + '%',
    }
  } catch (error) {
    return {
      success: false,
      skipped: error.message,
      originalLen: content.length,
    }
  }
}

/**
 * Compress a file with backup
 * @param {string} filePath - Path to file
 * @param {object} options - Options
 * @returns {Promise<object>} - Result object
 */
export async function compressFile(filePath, options = {}) {
  // Validate file exists
  if (!existsSync(filePath)) {
    return {
      success: false,
      error: `File not found: ${filePath}`,
    }
  }

  // Read file
  const content = await readFile(filePath, 'utf8')
  const originalLen = content.length

  // Detect strategy
  const strategy = options.strategy || detectFileStrategy(filePath)

  // Compress content
  const result = await compressContent(content, strategy, options)

  if (!result.success) {
    return {
      ...result,
      file: filePath,
      strategy,
      originalLen,
    }
  }

  // Dry run mode - don't write file
  if (options.dryRun) {
    return {
      ...result,
      file: filePath,
      strategy,
      dryRun: true,
    }
  }

  // Create backup
  const backupPath = filePath + '.bak'
  if (!options.noBackup) {
    try {
      await copyFile(filePath, backupPath)
    } catch (error) {
      return {
        success: false,
        error: `Failed to create backup: ${error.message}`,
        file: filePath,
      }
    }
  }

  // Write compressed content
  const outputPath = options.output || filePath
  try {
    await writeFile(outputPath, result.compressed, 'utf8')
  } catch (error) {
    return {
      success: false,
      error: `Failed to write file: ${error.message}`,
      file: filePath,
    }
  }

  return {
    ...result,
    file: filePath,
    output: outputPath,
    strategy,
    backup: options.noBackup ? null : backupPath,
    dryRun: false,
  }
}

/**
 * Compress multiple files
 * @param {string[]} filePaths - Array of file paths
 * @param {object} options - Options
 * @returns {Promise<object[]>} - Array of results
 */
export async function compressFiles(filePaths, options = {}) {
  const results = []

  for (const filePath of filePaths) {
    const result = await compressFile(filePath, options)
    results.push(result)
  }

  return results
}

/**
 * Format compression result for CLI output
 * @param {object} result - Result object
 * @returns {string} - Formatted output
 */
export function formatResult(result) {
  if (result.dryRun) {
    return `DRY RUN: ${result.file}\n` +
           `  Strategy: ${result.strategy}\n` +
           `  Original: ${result.originalLen} chars\n` +
           `  Compressed: ${result.compressedLen} chars\n` +
           `  Savings: ${result.savings}\n` +
           `  Method: ${result.method}`
  }

  if (result.success) {
    let output = `✓ ${result.file}\n` +
           `  Strategy: ${result.strategy}\n` +
           `  Original: ${result.originalLen} chars\n` +
           `  Compressed: ${result.compressedLen} chars\n` +
           `  Savings: ${result.savings}\n` +
           `  Method: ${result.method}`

    if (result.backup) {
      output += `\n  Backup: ${result.backup}`
    }

    if (result.output !== result.file) {
      output += `\n  Output: ${result.output}`
    }

    return output
  }

  if (result.skipped) {
    return `⊘ ${result.file || 'N/A'}\n` +
           `  Skipped: ${result.skipped}`
  }

  return `✗ ${result.file || 'N/A'}\n` +
         `  Error: ${result.error || 'Unknown error'}`
}
