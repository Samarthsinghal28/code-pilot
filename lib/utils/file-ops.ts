import { promises as fs } from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface FileValidationResult {
  isValid: boolean
  error?: string
  suggestions?: string[]
}

export interface GitInfo {
  hasGit: boolean
  branch?: string
  remote?: string
  commits?: number
  status?: string
}

/**
 * Validates if a file path is safe for operations
 * Prevents path traversal attacks and ensures files are within allowed directories
 */
export function validateFilePath(filePath: string, baseDir: string): FileValidationResult {
  try {
    const normalizedPath = path.normalize(filePath)
    const fullPath = path.resolve(baseDir, normalizedPath)
    const normalizedBase = path.resolve(baseDir)
    
    // Check for path traversal
    if (!fullPath.startsWith(normalizedBase)) {
      return {
        isValid: false,
        error: 'Path traversal detected',
        suggestions: ['Use relative paths within the project directory']
      }
    }
    
    // Check for dangerous file patterns
    const dangerousPatterns = [
      /node_modules/,
      /\.git/,
      /\.env/,
      /\.ssh/,
      /\.aws/,
      /package-lock\.json$/,
      /yarn\.lock$/
    ]
    
    const isDangerous = dangerousPatterns.some(pattern => pattern.test(normalizedPath))
    if (isDangerous) {
      return {
        isValid: false,
        error: 'Cannot modify system or configuration files',
        suggestions: ['Target application source files instead']
      }
    }
    
    return { isValid: true }
  } catch (error) {
    return {
      isValid: false,
      error: `Path validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    }
  }
}

/**
 * Safely reads a file with size limits and encoding detection
 */
export async function safeReadFile(filePath: string, maxSize: number = 1024 * 1024): Promise<string> {
  try {
    const stats = await fs.stat(filePath)
    
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize})`)
    }
    
    const content = await fs.readFile(filePath, 'utf-8')
    return content
  } catch (error) {
    throw new Error(`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Safely writes a file with backup creation
 */
export async function safeWriteFile(filePath: string, content: string, createBackup: boolean = true): Promise<void> {
  try {
    // Create backup if file exists
    if (createBackup && await fileExists(filePath)) {
      const backupPath = `${filePath}.backup.${Date.now()}`
      await fs.copyFile(filePath, backupPath)
    }
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    
    // Write file atomically
    const tempPath = `${filePath}.tmp.${Date.now()}`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  } catch (error) {
    throw new Error(`Failed to write file: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Checks if a file or directory exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Gets file metadata safely
 */
export async function getFileMetadata(filePath: string) {
  try {
    const stats = await fs.stat(filePath)
    return {
      size: stats.size,
      modified: stats.mtime,
      created: stats.birthtime,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      permissions: stats.mode
    }
  } catch (error) {
    throw new Error(`Failed to get file metadata: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Creates a directory structure recursively
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (error) {
    throw new Error(`Failed to create directory: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Removes a directory and all its contents
 */
export async function removeDirectory(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true })
  } catch (error) {
    throw new Error(`Failed to remove directory: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Gets information about a Git repository
 */
export async function getGitInfo(repoPath: string): Promise<GitInfo> {
  try {
    const gitDir = path.join(repoPath, '.git')
    const hasGit = await fileExists(gitDir)
    
    if (!hasGit) {
      return { hasGit: false }
    }
    
    // Get current branch
    const branchResult = await execAsync('git branch --show-current', { cwd: repoPath })
    const branch = branchResult.stdout.trim()
    
    // Get remote URL
    const remoteResult = await execAsync('git remote get-url origin', { cwd: repoPath })
    const remote = remoteResult.stdout.trim()
    
    // Get commit count
    const countResult = await execAsync('git rev-list --count HEAD', { cwd: repoPath })
    const commits = parseInt(countResult.stdout.trim())
    
    // Get status
    const statusResult = await execAsync('git status --porcelain', { cwd: repoPath })
    const hasChanges = statusResult.stdout.trim().length > 0
    const status = hasChanges ? 'modified' : 'clean'
    
    return {
      hasGit: true,
      branch,
      remote,
      commits,
      status
    }
  } catch (error) {
    return { 
      hasGit: true,
      status: 'error'
    }
  }
}

/**
 * Validates that a URL is a valid GitHub repository
 */
export function validateGitHubUrl(url: string): FileValidationResult {
  try {
    const urlObj = new URL(url)
    
    if (urlObj.hostname !== 'github.com') {
      return {
        isValid: false,
        error: 'Only GitHub repositories are supported',
        suggestions: ['Use a github.com URL']
      }
    }
    
    const pathParts = urlObj.pathname.split('/').filter(Boolean)
    if (pathParts.length < 2) {
      return {
        isValid: false,
        error: 'Invalid repository URL format',
        suggestions: ['Use format: https://github.com/owner/repo']
      }
    }
    
    const [owner, repo] = pathParts
    if (!owner || !repo) {
      return {
        isValid: false,
        error: 'Missing owner or repository name',
        suggestions: ['Ensure URL includes both owner and repository name']
      }
    }
    
    // Check for common URL suffixes
    const cleanRepo = repo.replace(/\.git$/, '')
    if (cleanRepo.length === 0) {
      return {
        isValid: false,
        error: 'Invalid repository name'
      }
    }
    
    return { isValid: true }
  } catch (error) {
    return {
      isValid: false,
      error: 'Invalid URL format',
      suggestions: ['Ensure URL is properly formatted']
    }
  }
}

/**
 * Sanitizes a string for use in file names or Git commands
 */
export function sanitizeForFilename(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9\-_\.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 50)
}

/**
 * Generates a unique temporary directory name
 */
export function generateTempDirName(prefix: string = 'codepilot'): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  return `${prefix}-${timestamp}-${random}`
}

/**
 * Checks if a directory is empty
 */
export async function isDirectoryEmpty(dirPath: string): Promise<boolean> {
  try {
    const files = await fs.readdir(dirPath)
    return files.length === 0
  } catch {
    return true // Directory doesn't exist, consider it empty
  }
}

/**
 * Gets the size of a directory recursively
 */
export async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    let totalSize = 0
    const files = await fs.readdir(dirPath, { withFileTypes: true })
    
    for (const file of files) {
      const filePath = path.join(dirPath, file.name)
      
      if (file.isDirectory()) {
        totalSize += await getDirectorySize(filePath)
      } else {
        const stats = await fs.stat(filePath)
        totalSize += stats.size
      }
    }
    
    return totalSize
  } catch {
    return 0
  }
}

/**
 * Formats file size in human readable format
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unitIndex = 0
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

/**
 * Extracts repository owner and name from GitHub URL
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split('/').filter(Boolean)
    
    if (pathParts.length >= 2) {
      const [owner, repoWithSuffix] = pathParts
      const repo = repoWithSuffix.replace(/\.git$/, '')
      return { owner, repo }
    }
    
    return null
  } catch {
    return null
  }
} 