import CodeInterpreter from '@e2b/code-interpreter'
import { McpTool, ToolResult, ToolName, ToolParameters, FileInfo } from '@/types'
import { getE2BConfig, getExecutionLimits, getFileLimits, getGitHubToken } from '@/lib/config/env'
import { parseGitHubUrl, formatFileSize } from '@/lib/utils/file-ops'

export class E2BSandbox {
  private sandbox: CodeInterpreter | null = null
  private tools: Map<string, McpTool> = new Map()
  private isInitialized = false
  private readonly workDir = '/tmp/repo'

  constructor() {
    this.initializeTools()
  }

  private initializeTools() {
    const { commandTimeout } = getExecutionLimits()

    // Start with just the clone tool
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
        const { url, depth = 1 } = params as ToolParameters['clone_repository']
        const { maxRepoSize } = getFileLimits()
        
        await this.ensureSandbox()

        try {
          const token = getGitHubToken()
          const parsedUrl = parseGitHubUrl(url)
          let cloneUrl = url
          
          if (token && parsedUrl) {
            cloneUrl = `https://${token}@github.com/${parsedUrl.owner}/${parsedUrl.repo}.git`
          }

          // Use Python code to clone the repository
          const code = `
import subprocess
import os

# Create the target directory
os.makedirs("${this.workDir}", exist_ok=True)

# Clone the repository
result = subprocess.run([
    "git", "clone", "--depth", "${depth}", 
    "${cloneUrl}", "${this.workDir}"
], capture_output=True, text=True)

print("STDOUT:", result.stdout)
print("STDERR:", result.stderr)
print("RETURN_CODE:", result.returncode)

# Check repository size
if result.returncode == 0:
    size_result = subprocess.run([
        "du", "-sb", "${this.workDir}"
    ], capture_output=True, text=True)
    if size_result.returncode == 0:
        size_bytes = int(size_result.stdout.split()[0])
        print("REPO_SIZE:", size_bytes)
`

          const result = await this.sandbox!.runCode(code)
          const output = result.logs.stdout.join('\n')
          const error = result.logs.stderr.join('\n')

          console.log('E2B Clone Output:', output)
          console.log('E2B Clone Error:', error)

          // Parse the output to check if clone was successful
          if (output.includes('RETURN_CODE: 0')) {
            // Extract repo size from output
            const sizeMatch = output.match(/REPO_SIZE: (\d+)/)
            const repoSize = sizeMatch ? parseInt(sizeMatch[1]) : 0

            if (repoSize > maxRepoSize) {
              throw new Error(`Repository size (${formatFileSize(repoSize)}) exceeds the limit of ${formatFileSize(maxRepoSize)}.`)
            }

            return {
              success: true,
              data: { path: this.workDir },
              stdout: output,
              stderr: error,
              toolName: 'clone_repository',
              executionTime: Date.now() - startTime
            }
          } else {
            throw new Error(`Git clone failed: ${error}`)
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

    this.tools.set('list_files', {
      name: 'list_files',
      description: 'List files in a directory recursively',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean', default: false },
        },
        required: ['path'],
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path, recursive = false } = params as ToolParameters['list_files']
        await this.ensureSandbox()

        try {
          const code = `
import os

def list_files(startpath):
    files = []
    for root, dirs, filenames in os.walk(startpath):
        for f in filenames:
            full_path = os.path.join(root, f)
            # Make path relative to startpath
            rel_path = os.path.relpath(full_path, startpath)
            files.append(rel_path)
    
    for f in files:
        print(f)

list_files('${this.workDir}')
`
          const result = await this.sandbox!.runCode(code)
          const files = result.logs.stdout
            .join('\n') // Join all stdout lines first
            .split('\n') // Then split by newlines
            .filter(line => line.trim() !== '') // Remove empty lines
            .map(p => ({
              path: p.trim(),
              size: 0, // E2B doesn't easily provide file size with ls, will implement later
            }))

          console.log('[E2B] list_files raw output:', result.logs.stdout)
          console.log('[E2B] list_files processed files:', files.length, 'files found')
          console.log('[E2B] Sample files:', files.slice(0, 5).map(f => f.path))

          return {
            success: true,
            data: { files },
            stdout: result.logs.stdout.join('\n'),
            stderr: result.logs.stderr.join('\n'),
            toolName: 'list_files',
            executionTime: Date.now() - startTime,
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to list files: ${error.message}`,
            toolName: 'list_files',
            executionTime: Date.now() - startTime,
          }
        }
      },
    })

    this.tools.set('read_file', {
      name: 'read_file',
      description: 'Read the contents of a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string', default: 'utf-8' },
        },
        required: ['path'],
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path } = params as ToolParameters['read_file']
        await this.ensureSandbox()

        try {
          const result = await this.sandbox!.runCode(`
import os
print("CURRENT_DIR:", os.getcwd())
print("WORK_DIR_EXISTS:", os.path.exists('${this.workDir}'))

file_path = '${path}'
print("READING_FILE:", file_path)
print("FILE_EXISTS:", os.path.exists(file_path))

if os.path.exists(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            content = file.read()
            print("FILE_SIZE:", len(content))
            print("CONTENT_PREVIEW:", content[:100] if content else "EMPTY")
            print("CONTENT_START")
            print(content)
            print("CONTENT_END")
    except Exception as e:
        print("READ_ERROR:", str(e))
        print("CONTENT_START")
        print("CONTENT_END")
else:
    print("FILE_NOT_FOUND")
    print("CONTENT_START")
    print("CONTENT_END")
`)
          if (result.logs.stderr.length > 0) {
            throw new Error(result.logs.stderr.join('\\n'))
          }
          const content = result.logs.stdout.join('\\n')
          return {
            success: true,
            data: { content },
            stdout: `Successfully read file: ${path}`,
            toolName: 'read_file',
            executionTime: Date.now() - startTime,
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to read file: ${error.message}`,
            toolName: 'read_file',
            executionTime: Date.now() - startTime,
          }
        }
      },
    })

    this.tools.set('write_file', {
      name: 'write_file',
      description: 'Write content to a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          encoding: { type: 'string', default: 'utf-8' },
        },
        required: ['path', 'content'],
      },
      execute: async (params) => {
        const startTime = Date.now()
        const { path, content } = params as ToolParameters['write_file']
        await this.ensureSandbox()

        try {
          const fullPath = path.startsWith('/') ? path : `${this.workDir}/${path}`
          console.log('[E2B] Writing to file at full path:', fullPath)
          
          // Escape the content properly for Python triple quotes
          const escapedContent = content.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')
          
          const result = await this.sandbox!.runCode(`
import os

file_path = '${fullPath}'
print("CURRENT_DIR:", os.getcwd())
print("WORK_DIR_EXISTS:", os.path.exists('${this.workDir}'))
print("WRITING_TO:", file_path)

# Create directory if it doesn't exist
dir_path = os.path.dirname(file_path)
print("DIR_PATH:", dir_path)
print("DIR_EXISTS:", os.path.exists(dir_path))

if not os.path.exists(dir_path):
    os.makedirs(dir_path, exist_ok=True)
    print("CREATED_DIR:", dir_path)

try:
    with open(file_path, 'w', encoding='utf-8') as file:
        file.write("""${escapedContent}""")
    print("WRITE_SUCCESS")
    print("FILE_EXISTS_AFTER_WRITE:", os.path.exists(file_path))
    
    # Verify the write
    with open(file_path, 'r', encoding='utf-8') as file:
        written_content = file.read()
        print("WRITTEN_SIZE:", len(written_content))
        print("WRITTEN_PREVIEW:", written_content[:100] if written_content else "EMPTY")
except Exception as e:
    print("WRITE_ERROR:", str(e))
`)
          const stdout = result.logs.stdout.join('\n')
          console.log('[E2B] Write file output:', stdout.slice(0, 500))
          
          if (result.logs.stderr.length > 0) {
            throw new Error(result.logs.stderr.join('\\n'))
          }
          
          return {
            success: stdout.includes('WRITE_SUCCESS'),
            stdout: stdout,
            stderr: result.logs.stderr.join('\n'),
            data: { path: fullPath },
            toolName: 'write_file',
            executionTime: Date.now() - startTime,
          }
        } catch (error: any) {
          return {
            success: false,
            error: `Failed to write file: ${error.message}`,
            toolName: 'write_file',
            executionTime: Date.now() - startTime,
          }
        }
      },
    })

    this.tools.set('git_add', {
        name: 'git_add',
        description: 'Stage changes for commit',
        inputSchema: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' } },
                repoPath: { type: 'string', default: '' },
            },
            required: ['paths'],
        },
        execute: async (params) => {
            const startTime = Date.now()
            const { files, repoPath } = params as ToolParameters['git_add']
            await this.ensureSandbox()
            
            const targetDir = repoPath ? `${this.workDir}/${repoPath}` : this.workDir
            const filesToAdd = files?.join(' ') || '.'
            console.log(`[E2B] Staging files in ${targetDir}`)

            try {
                const result = await this.sandbox!.runCode(`
import subprocess
import os
os.chdir('${targetDir}')
subprocess.run(['git', 'add', '${filesToAdd}'], check=True)
                `)
                
                if (result.logs.stderr.length > 0) {
                    throw new Error(result.logs.stderr.join('\n'))
                }
                
                return {
                    success: true,
                    stdout: `Staged: ${filesToAdd}`,
                    toolName: 'git_add',
                    executionTime: Date.now() - startTime,
                }
            } catch (error: any) {
                return {
                    success: false,
                    error: `Git add failed: ${error.message}`,
                    toolName: 'git_add',
                    executionTime: Date.now() - startTime,
                }
            }
        },
    })
    
    this.tools.set('git_commit', {
        name: 'git_commit',
        description: 'Commit staged changes',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string' },
                authorName: { type: 'string' },
                authorEmail: { type: 'string' },
                repoPath: { type: 'string', default: '' },
            },
            required: ['message'],
        },
        execute: async (params) => {
            const startTime = Date.now()
            const { message, author, repoPath } = params as ToolParameters['git_commit']
            await this.ensureSandbox()
            const targetDir = repoPath ? `${this.workDir}/${repoPath}` : this.workDir
            console.log(`[E2B] Committing in ${targetDir}`)

            try {
              // First check if there are any changes to commit
              const statusResult = await this.sandbox!.runCode(`
import subprocess
import os
os.chdir('${targetDir}')
result = subprocess.run(['git', 'status', '--porcelain'], capture_output=True, text=True)
print("STATUS_OUTPUT:", result.stdout)
              `)
              
              const statusOutput = statusResult.logs.stdout.join('\n')
              if (!statusOutput.includes('STATUS_OUTPUT:') || statusOutput.split('STATUS_OUTPUT:')[1]?.trim() === '') {
                return {
                  success: true,
                  stdout: 'No changes to commit',
                  data: { skipped: true },
                  toolName: 'git_commit',
                  executionTime: Date.now() - startTime,
                }
              }

              const authorName = author?.name || 'Code Pilot'
              const authorEmail = author?.email || 'codepilot@example.com'
              const commitCmd = `git -c user.name='${authorName}' -c user.email='${authorEmail}' commit --file=-`
              
              const result = await this.sandbox!.runCode(`
import subprocess
import os
os.chdir('${targetDir}')
p = subprocess.Popen(['bash', '-c', "${commitCmd}"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
stdout, stderr = p.communicate(input="""${message}""")
print("STDOUT:", stdout)
print("STDERR:", stderr)
print("RETURN_CODE:", p.returncode)
              `)
              
              const output = result.logs.stdout.join('\n')
              if (output.includes('RETURN_CODE: 0')) {
                return {
                  success: true,
                  stdout: output,
                  toolName: 'git_commit',
                  executionTime: Date.now() - startTime,
                }
              }
              throw new Error(result.logs.stderr.join('\n') || output)
            } catch (error: any) {
              return {
                success: false,
                error: `Git commit failed: ${error.message}`,
                toolName: 'git_commit',
                executionTime: Date.now() - startTime,
              }
            }
        },
    })

    this.tools.set('git_push', {
        name: 'git_push',
        description: 'Push changes to a remote repository',
        inputSchema: {
            type: 'object',
            properties: {
                branchName: { type: 'string' },
                repoPath: { type: 'string', default: '' },
            },
            required: ['branchName'],
        },
        execute: async (params) => {
            const startTime = Date.now()
            const { branchName, repoPath } = params as ToolParameters['git_push']
            await this.ensureSandbox()
            const targetDir = repoPath ? `${this.workDir}/${repoPath}` : this.workDir
            console.log(`[E2B] Pushing branch '${branchName}' from ${targetDir}`)

            try {
              const result = await this.sandbox!.runCode(`
import subprocess
import os
os.chdir('${targetDir}')
result = subprocess.run(['git', 'push', 'origin', '${branchName}'], capture_output=True, text=True)
print("PUSH_STDOUT:", result.stdout)
print("PUSH_STDERR:", result.stderr)
print("PUSH_RETURN_CODE:", result.returncode)
          `)
          
          const stdout = result.logs.stdout.join('\n')
          const stderr = result.logs.stderr.join('\n')
          console.log('[E2B] Git push output:', stdout)
          
          // Check if push was successful - look for "new branch" or return code 0
          const isSuccessful = stdout.includes('PUSH_RETURN_CODE: 0') || 
                             stderr.includes('* [new branch]') ||
                             stdout.includes('* [new branch]')
          
          if (!isSuccessful) {
            throw new Error(`Git push failed: ${stderr || stdout}`)
          }
          
          return {
            success: true,
            stdout: `Pushed branch ${branchName}`,
            stderr: stderr,
            toolName: 'git_push',
            executionTime: Date.now() - startTime,
          }
            } catch (error: any) {
              return {
                success: false,
                error: `Git push failed: ${error.message}`,
                toolName: 'git_push',
                executionTime: Date.now() - startTime,
              }
            }
        },
    })

    this.tools.set('git_branch', {
        name: 'git_branch',
        description: 'Create a new branch',
        inputSchema: {
            type: 'object',
            properties: {
                branchName: { type: 'string' },
                fromBranch: { type: 'string', default: '' },
                repoPath: { type: 'string', default: '' },
            },
            required: ['branchName'],
        },
        execute: async (params) => {
            const startTime = Date.now()
            const { branchName, fromBranch, repoPath } = params as ToolParameters['git_branch']
            await this.ensureSandbox()
            const targetDir = repoPath ? `${this.workDir}/${repoPath}` : this.workDir
            console.log(`[E2B] Creating branch '${branchName}' in ${targetDir}`)

            try {
              const from = fromBranch || 'main'
              
              // First, let's check the current state and ensure we're in a git repo
              const statusResult = await this.sandbox!.runCode(`
import subprocess
import os

try:
    os.chdir('${targetDir}')
    print(f"WORKING_DIR: {os.getcwd()}")
    
    # Check if this is a git repository
    result = subprocess.run(['git', 'status'], capture_output=True, text=True)
    print(f"GIT_STATUS_CHECK: {result.returncode}")
    if result.returncode != 0:
        print(f"NOT_A_GIT_REPO: {result.stderr}")
        raise Exception("Not a git repository")
    
    # Show current branch
    current_branch = subprocess.run(['git', 'branch', '--show-current'], capture_output=True, text=True)
    print(f"CURRENT_BRANCH: {current_branch.stdout.strip()}")
    
    # Show all branches
    all_branches = subprocess.run(['git', 'branch', '-a'], capture_output=True, text=True)
    print(f"ALL_BRANCHES: {all_branches.stdout}")
    
    print("STATUS_CHECK_SUCCESS")
    
except Exception as e:
    print(f"STATUS_CHECK_ERROR: {e}")
          `)
          
          const statusOutput = statusResult.logs.stdout.join('\n')
          console.log('[E2B] Status check output:', statusOutput)
          
          if (!statusOutput.includes('STATUS_CHECK_SUCCESS')) {
            throw new Error(`Git repository check failed: ${statusOutput}`)
          }
          
          // Now create the branch
          const branchResult = await this.sandbox!.runCode(`
import subprocess
import os

try:
    os.chdir('${targetDir}')
    print(f"CREATING_BRANCH_IN: {os.getcwd()}")
    
    # First checkout the base branch
    print(f"CHECKING_OUT_BASE: ${from}")
    checkout_result = subprocess.run(['git', 'checkout', '${from}'], capture_output=True, text=True)
    print(f"CHECKOUT_RETURNCODE: {checkout_result.returncode}")
    print(f"CHECKOUT_STDOUT: {checkout_result.stdout}")
    print(f"CHECKOUT_STDERR: {checkout_result.stderr}")
    
    if checkout_result.returncode != 0:
        print(f"CHECKOUT_FAILED: {checkout_result.stderr}")
        # Try to create the base branch if it doesn't exist
        fetch_result = subprocess.run(['git', 'fetch', 'origin'], capture_output=True, text=True)
        print(f"FETCH_RESULT: {fetch_result.returncode}")
        checkout_result = subprocess.run(['git', 'checkout', '-b', '${from}', 'origin/${from}'], capture_output=True, text=True)
        print(f"CREATE_BASE_RETURNCODE: {checkout_result.returncode}")
    
    # Create and checkout the new branch
    print(f"CREATING_NEW_BRANCH: ${branchName}")
    branch_result = subprocess.run(['git', 'checkout', '-b', '${branchName}'], capture_output=True, text=True)
    print(f"BRANCH_RETURNCODE: {branch_result.returncode}")
    print(f"BRANCH_STDOUT: {branch_result.stdout}")
    print(f"BRANCH_STDERR: {branch_result.stderr}")
    
    if branch_result.returncode == 0:
        # Verify we're on the new branch
        verify_result = subprocess.run(['git', 'branch', '--show-current'], capture_output=True, text=True)
        current_branch = verify_result.stdout.strip()
        print(f"VERIFIED_BRANCH: {current_branch}")
        
        if current_branch == '${branchName}':
            print("BRANCH_CREATION_SUCCESS")
        else:
            print(f"BRANCH_VERIFICATION_FAILED: Expected ${branchName}, got {current_branch}")
    else:
        print(f"BRANCH_CREATION_FAILED: {branch_result.stderr}")
        
except Exception as e:
    print(f"BRANCH_CREATION_ERROR: {e}")
          `)
          
          const branchOutput = branchResult.logs.stdout.join('\n')
          console.log('[E2B] Branch creation output:', branchOutput)
          
          // Check if branch creation was successful
          if (branchOutput.includes('BRANCH_CREATION_SUCCESS')) {
            return {
              success: true,
              stdout: `Successfully created and switched to branch ${branchName}`,
              toolName: 'git_branch',
              executionTime: Date.now() - startTime,
            }
          } else {
            const errorMsg = branchOutput.includes('BRANCH_CREATION_ERROR') 
              ? branchOutput.split('BRANCH_CREATION_ERROR:')[1]?.trim() 
              : 'Unknown error during branch creation'
            throw new Error(`Branch creation failed: ${errorMsg}`)
          }
        } catch (error: any) {
          console.error('[E2B] Git branch error:', error.message)
          return {
            success: false,
            error: `Git branch failed: ${error.message}`,
            toolName: 'git_branch',
            executionTime: Date.now() - startTime,
          }
        }
      },
    })
  }

  private async ensureSandbox(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize()
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return
    
    try {
      console.log('[E2B] Initializing sandbox...')
      const { apiKey } = getE2BConfig()
      console.log('[E2B] Using API key:', apiKey ? 'PRESENT' : 'MISSING')
      
      this.sandbox = await CodeInterpreter.create({
        apiKey: apiKey,
      })
      this.isInitialized = true
      console.log('[E2B] Sandbox initialized successfully')
    } catch (error: any) {
      console.error('[E2B] Failed to initialize sandbox:', error)
      throw new Error(`Failed to initialize E2B sandbox: ${error.message}`)
    }
  }

  async cleanup(): Promise<void> {
    console.log('[E2B] Cleaning up sandbox...')
    if (this.sandbox) {
      await this.sandbox.kill()
      this.sandbox = null
      console.log('[E2B] Sandbox cleaned up')
    }
    this.isInitialized = false
  }

  async callTool<T extends ToolName>(toolName: T, params: ToolParameters[T]): Promise<ToolResult> {
    console.log('[E2B] Calling tool:', toolName, 'with params:', JSON.stringify(params).slice(0, 200))
    const tool = this.tools.get(toolName)
    if (!tool) {
      console.error('[E2B] Tool not found:', toolName)
      throw new Error(`Tool not found: ${toolName}`)
    }
    const result = await tool.execute(params)
    console.log('[E2B] Tool result:', { success: result.success, error: result.error?.slice(0, 200) })
    return result
  }

  getAvailableTools(): string[] {
    return Array.from(this.tools.keys())
  }
  
  getWorkingDirectory(): string {
    return this.workDir
  }
}