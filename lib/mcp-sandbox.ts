import { exec, execFile, ChildProcess, ExecOptions } from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { getGitHubToken, getExecutionLimits, getFileLimits } from '@/lib/config/env'
import { McpTool, FileInfo, ToolResult, ToolName, ToolParameters } from '@/types'
import { parseGitHubUrl, getDirectorySize, formatFileSize } from '@/lib/utils/file-ops'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

export class VirtualSandbox {
  private workDir: string
  private tools: Map<string, McpTool> = new Map()
  private isInitialized = false
  private activeProcesses: Set<ChildProcess> = new Set()

  constructor(workDir: string) {
    this.workDir = workDir
    this.initializeTools()
  }

  private exec(command: string, options: ExecOptions & { encoding?: BufferEncoding }): ChildProcess {
    const process = exec(command, options)
    this.activeProcesses.add(process)
    process.on('exit', () => this.activeProcesses.delete(process))
    return process
  }

  private async execAsync(command: string, options: ExecOptions): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const process = this.exec(command, options)
      let stdout = ''
      let stderr = ''
      process.stdout?.on('data', (data) => (stdout += data))
      process.stderr?.on('data', (data) => (stderr += data))
      process.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`))
        }
      })
      process.on('error', reject)
    })
  }

  private async createGitAskPassScript(): Promise<string> {
    const token = getGitHubToken()
    if (!token) return ''

    const scriptPath = path.join(os.tmpdir(), `codepilot-askpass-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.sh`)
    const scriptContent = `#!/bin/sh\necho "${token}"\n`
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o700 })
    return scriptPath
  }

  private async withGitAuth<T>(operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const askPassScript = await this.createGitAskPassScript()
    if (!askPassScript) {
      return operation(process.env)
    }

    const execEnv = {
      ...process.env,
      GIT_ASKPASS: askPassScript,
      GIT_TERMINAL_PROMPT: '0',
    }

    try {
      return await operation(execEnv)
    } finally {
      try {
        await fs.unlink(askPassScript)
      } catch {}
    }
  }

  private initializeTools() {
    const { commandTimeout } = getExecutionLimits()

    // Repository Operations
    this.tools.set('clone_repository', {
      name: 'clone_repository',
      description: 'Clone a Git repository with shallow depth',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          destination: { type: 'string' },
          depth: { type: 'number', default: 1 }
        },
        required: ['url', 'destination']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { url, destination, depth = 1 } = params as ToolParameters['clone_repository']
        const fullPath = path.join(this.workDir, destination)
        const { maxRepoSize } = getFileLimits()
        
        await fs.mkdir(path.dirname(fullPath), { recursive: true })
        
        try {
          const result = await this.withGitAuth(async (env) => {
            const { stdout, stderr } = await this.execAsync(
              `git clone --depth ${depth} --progress "${url}" "${fullPath}"`,
              { maxBuffer: 1024 * 1024 * 10, timeout: commandTimeout, env }
            )
            
            const repoSize = await getDirectorySize(fullPath)
            if (repoSize > maxRepoSize) {
                throw new Error(`Repository size (${formatFileSize(repoSize)}) exceeds the limit of ${formatFileSize(maxRepoSize)}.`)
            }

            const token = getGitHubToken()
            const parsedUrl = parseGitHubUrl(url)
            if(token && parsedUrl) {
                const authedUrl = `https://${token}@github.com/${parsedUrl.owner}/${parsedUrl.repo}.git`
                await execAsync(`git remote set-url origin "${authedUrl}"`, { cwd: fullPath, env })
            }

            return { stdout, stderr }
          })
          
          return {
            success: true,
            data: { path: fullPath },
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            toolName: 'clone_repository',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Clone failed: ${error.message}`,
            toolName: 'clone_repository',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    // File System Operations
    this.tools.set('read_file', {
      name: 'read_file',
      description: 'Read contents of a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string', default: 'utf-8' }
        },
        required: ['path']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path: filePath, encoding = 'utf-8' } = params as ToolParameters['read_file']
        const fullPath = this.getSecurePath(filePath)
        
        try {
          const content = await fs.readFile(fullPath, encoding as BufferEncoding)
          const stats = await fs.stat(fullPath)
          
          return {
            success: true,
            data: {
              content,
              size: stats.size,
              modified: stats.mtime,
              path: filePath
            },
            toolName: 'read_file',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to read file ${filePath}: ${error.message}`,
            toolName: 'read_file',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('write_file', {
      name: 'write_file',
      description: 'Write content to a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          encoding: { type: 'string', default: 'utf-8' }
        },
        required: ['path', 'content']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path: filePath, content, encoding = 'utf-8' } = params as ToolParameters['write_file']
        const fullPath = this.getSecurePath(filePath)
        const { maxFileSize, maxRepoSize } = getFileLimits()
        
        try {
          if (Buffer.from(content).length > maxFileSize) {
            throw new Error(`File content size exceeds the limit of ${formatFileSize(maxFileSize)}.`);
          }

          await fs.mkdir(path.dirname(fullPath), { recursive: true })
          await fs.writeFile(fullPath, content, encoding as BufferEncoding)
          
          const repoSize = await getDirectorySize(this.getSecurePath('repo'))
          if (repoSize > maxRepoSize) {
            throw new Error(`Total repository size (${formatFileSize(repoSize)}) exceeds the limit of ${formatFileSize(maxRepoSize)}.`);
          }

          const stats = await fs.stat(fullPath)
          return {
            success: true,
            data: {
              path: filePath,
              size: stats.size
            },
            toolName: 'write_file',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to write file ${filePath}: ${error.message}`,
            toolName: 'write_file',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('list_files', {
      name: 'list_files',
      description: 'List files and directories in a path',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean', default: false },
          includeHidden: { type: 'boolean', default: false }
        },
        required: ['path']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path: dirPath, recursive = false, includeHidden = false } = params as ToolParameters['list_files']
        const fullPath = this.getSecurePath(dirPath)
        
        try {
          const files: FileInfo[] = []
          
          if (recursive) {
            await this.walkDirectory(fullPath, files, includeHidden)
          } else {
            const entries = await fs.readdir(fullPath, { withFileTypes: true })
            
            for (const entry of entries) {
              if (!includeHidden && entry.name.startsWith('.')) continue
              
              const entryPath = path.join(fullPath, entry.name)
              const stats = await fs.stat(entryPath)
              const relativePath = path.relative(this.workDir, entryPath)
              
              files.push({
                path: relativePath.split(path.sep).join('/'), // Always use forward slashes
                size: stats.size,
                modified: stats.mtime,
                type: entry.isDirectory() ? 'directory' : 'file',
                extension: entry.isFile() ? path.extname(entry.name) : undefined
              })
            }
          }
          
          return {
            success: true,
            data: { files },
            toolName: 'list_files',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to list files in ${dirPath}: ${error.message}`,
            toolName: 'list_files',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('delete_file', {
      name: 'delete_file',
      description: 'Delete a file or directory',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean', default: false }
        },
        required: ['path']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path: filePath, recursive = false } = params as ToolParameters['delete_file']
        const fullPath = this.getSecurePath(filePath)
        
        try {
          if (recursive) {
            await fs.rm(fullPath, { recursive: true, force: true })
          } else {
            await fs.unlink(fullPath)
          }
          
          return {
            success: true,
            data: { path: filePath },
            toolName: 'delete_file',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to delete ${filePath}: ${error.message}`,
            toolName: 'delete_file',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    // Git Operations
    this.tools.set('git_status', {
      name: 'git_status',
      description: 'Get Git repository status',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' }
        },
        required: ['repoPath']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath } = params as ToolParameters['git_status']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const { stdout } = await execAsync('git status --porcelain', {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          const changes = stdout.trim().split('\n').filter(line => line.length > 0)
          return {
            success: true,
            data: {
              hasChanges: changes.length > 0,
              changes,
              summary: `${changes.length} files changed`
            },
            toolName: 'git_status',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git status failed: ${error.message}`,
            toolName: 'git_status',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('git_add', {
      name: 'git_add',
      description: 'Stage files for Git commit',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, default: ['.'] }
        },
        required: ['repoPath']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath, files = ['.'] } = params as ToolParameters['git_add']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const fileArgs = files.join(' ')
          const { stdout, stderr } = await execAsync(`git add ${fileArgs}`, {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          return {
            success: true,
            data: { files },
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            toolName: 'git_add',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git add failed: ${error.message}`,
            toolName: 'git_add',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('git_commit', {
      name: 'git_commit',
      description: 'Create a Git commit',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          message: { type: 'string' },
          author: { type: 'string', default: 'Code Pilot Bot <codepilot@example.com>' }
        },
        required: ['repoPath', 'message']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath, message, author = 'Code Pilot Bot <codepilot@example.com>' } = params as ToolParameters['git_commit']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          // Configure git user if not set
          await execAsync(`git config user.name "Code Pilot Bot" && git config user.email "codepilot@example.com"`, {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          const { stdout, stderr } = await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          return {
            success: true,
            data: { message },
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            toolName: 'git_commit',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git commit failed: ${error.message}`,
            toolName: 'git_commit',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('git_branch', {
      name: 'git_branch',
      description: 'Create and switch to a new Git branch',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' },
          fromBranch: { type: 'string', default: 'main' }
        },
        required: ['repoPath', 'branchName']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath, branchName, fromBranch = 'main' } = params as ToolParameters['git_branch']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const { stdout, stderr } = await execAsync(`git checkout -b ${branchName} ${fromBranch}`, {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          return {
            success: true,
            data: {
              branchName,
              fromBranch
            },
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            toolName: 'git_branch',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git branch creation failed: ${error.message}`,
            toolName: 'git_branch',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('git_push', {
      name: 'git_push',
      description: 'Push a branch to the remote repository',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          branchName: { type: 'string' }
        },
        required: ['repoPath', 'branchName']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath, branchName } = params as ToolParameters['git_push']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const result = await this.withGitAuth(async (env) => {
            const { stdout, stderr } = await execAsync(`git push origin ${branchName}`, {
              cwd: fullPath,
              timeout: commandTimeout,
              env
            })
            return { stdout, stderr }
          })
          
          return {
            success: true,
            data: { branchName },
            stdout: result.stdout.trim(),
            stderr: result.stderr.trim(),
            toolName: 'git_push',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git push failed: ${error.message}`,
            toolName: 'git_push',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('git_apply_patch', {
      name: 'git_apply_patch',
      description: 'Apply a patch to the repository',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          patch: { type: 'string' }
        },
        required: ['repoPath', 'patch']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath, patch } = params as ToolParameters['git_apply_patch']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const patchFile = path.join(fullPath, '.git', 'temp.patch')
          await fs.writeFile(patchFile, patch)
          
          const { stdout, stderr } = await execAsync(`git apply ${patchFile}`, {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          await fs.unlink(patchFile)
          
          return {
            success: true,
            data: { applied: true },
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            toolName: 'git_apply_patch',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git apply patch failed: ${error.message}`,
            toolName: 'git_apply_patch',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('git_revert', {
      name: 'git_revert',
      description: 'Revert a commit',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' },
          commitHash: { type: 'string' }
        },
        required: ['repoPath', 'commitHash']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath, commitHash } = params as ToolParameters['git_revert']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const { stdout, stderr } = await execAsync(`git revert --no-edit ${commitHash}`, {
            cwd: fullPath,
            timeout: commandTimeout
          })
          
          return {
            success: true,
            data: { commitHash },
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            toolName: 'git_revert',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Git revert failed: ${error.message}`,
            toolName: 'git_revert',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('execute_shell', {
      name: 'execute_shell',
      description: 'Execute a shell command (development only)',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          workingDir: { type: 'string' }
        },
        required: ['command']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { command, workingDir } = params as ToolParameters['execute_shell']
        
        // Only allow in development
        if (process.env.NODE_ENV === 'production') {
          return {
            success: false,
            error: 'Shell execution disabled in production',
            toolName: 'execute_shell',
            executionTime: Date.now() - startTime
          }
        }
        
        try {
          const cwd = workingDir ? this.getSecurePath(workingDir) : this.workDir
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: commandTimeout
          })
          
          return {
            success: true,
            data: { command },
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            toolName: 'execute_shell',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Shell command failed: ${error.message}`,
            toolName: 'execute_shell',
            executionTime: Date.now() - startTime
          }
        }
      }
    })

    this.tools.set('get_package_info', {
      name: 'get_package_info',
      description: 'Extract package information from common manifest files',
      inputSchema: {
        type: 'object',
        properties: {
          repoPath: { type: 'string' }
        },
        required: ['repoPath']
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { repoPath } = params as ToolParameters['get_package_info']
        const fullPath = this.getSecurePath(repoPath)
        
        try {
          const packages: any[] = []
          
          // Check for package.json
          const packageJsonPath = path.join(fullPath, 'package.json')
          try {
            const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
            packages.push({
              type: 'npm',
              name: packageJson.name,
              version: packageJson.version,
              dependencies: Object.keys(packageJson.dependencies || {}),
              devDependencies: Object.keys(packageJson.devDependencies || {}),
              scripts: Object.keys(packageJson.scripts || {})
            })
          } catch {}

          // Check for requirements.txt
          const requirementsPath = path.join(fullPath, 'requirements.txt')
          try {
            const requirements = await fs.readFile(requirementsPath, 'utf-8')
            const deps = requirements.split('\n')
              .filter(line => line.trim() && !line.startsWith('#'))
              .map(line => line.split('==')[0])
            
            packages.push({
              type: 'python',
              dependencies: deps
            })
          } catch {}
          
          return {
            success: true,
            data: { packages },
            toolName: 'get_package_info',
            executionTime: Date.now() - startTime
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to get package info: ${error.message}`,
            toolName: 'get_package_info',
            executionTime: Date.now() - startTime
          }
        }
      }
    })
  }

  private async walkDirectory(dirPath: string, files: FileInfo[], includeHidden: boolean) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue
      
      const entryPath = path.join(dirPath, entry.name)
      const stats = await fs.stat(entryPath)
      const relativePath = path.relative(this.workDir, entryPath)
      
      files.push({
        path: relativePath.split(path.sep).join('/'), // Always use forward slashes
        size: stats.size,
        modified: stats.mtime,
        type: entry.isDirectory() ? 'directory' : 'file',
        extension: entry.isFile() ? path.extname(entry.name) : undefined
      })
      
      if (entry.isDirectory()) {
        await this.walkDirectory(entryPath, files, includeHidden)
      }
    }
  }

  private getSecurePath(relativePath: string): string {
    const fullPath = path.resolve(this.workDir, relativePath)
    
    // Ensure the path is within the working directory (prevent path traversal)
    if (!fullPath.startsWith(path.resolve(this.workDir))) {
      throw new Error(`Path traversal detected: ${relativePath}`)
    }
    
    return fullPath
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return
    
    try {
      await fs.mkdir(this.workDir, { recursive: true })
      this.isInitialized = true
    } catch (error: any) {
      throw new Error(`Failed to initialize sandbox: ${error.message}`)
    }
  }

  async callTool<T extends ToolName>(toolName: T, params: ToolParameters[T]): Promise<ToolResult> {
    if (!this.isInitialized) {
      await this.initialize()
    }
    
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`)
    }
    
    try {
      return await tool.execute(params)
    } catch (error: any) {
      return {
        success: false,
        error: `Tool ${toolName} failed: ${error.message}`,
        toolName,
        executionTime: 0
      }
    }
  }

  getAvailableTools(): string[] {
    return Array.from(this.tools.keys())
  }

  getToolSchema(toolName: string): Record<string, any> | undefined {
    const tool = this.tools.get(toolName)
    return tool?.inputSchema
  }

  async cleanup(): Promise<void> {
    this.activeProcesses.forEach(p => p.kill('SIGKILL'))
    try {
      if (await this.directoryExists(this.workDir)) {
        await fs.rm(this.workDir, { recursive: true, force: true, maxRetries: 3 })
      }
      this.isInitialized = false
    } catch (error: any) {
      console.error('Sandbox cleanup error:', error.message)
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath)
      return stats.isDirectory()
    } catch {
      return false
    }
  }

  getWorkingDirectory(): string {
    return this.workDir
  }
} 