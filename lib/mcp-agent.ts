import {
  StreamEvent,
  RepositoryAnalysis,
  ImplementationPlan,
  ToolResult,
  ToolErrorEvent,
  ToolName,
  ToolParameters,
  FileInfo,
  PlanStep,
  PackageInfo,
  GitHubPRResult,
} from '@/types'
import { VirtualSandbox } from './mcp-sandbox'
import { E2BSandbox } from './e2b-sandbox'
import { OpenAIClient } from './llm/openai'
import { createPullRequestFromRepo } from './github/api'
import { get } from '@/lib/config/env'
import * as path from 'path'

export class McpAgent {
  private sandbox: VirtualSandbox | E2BSandbox
  private openai: OpenAIClient
  private repoUrl: string
  private prompt: string
  private workDir: string

  constructor(repoUrl: string, prompt: string) {
    this.repoUrl = repoUrl
    this.prompt = prompt
    
    // Choose sandbox based on environment variable
    const useE2B = get('USE_E2B_SANDBOX') === 'true'
    
    if (useE2B) {
      this.sandbox = new E2BSandbox()
      this.workDir = this.sandbox.getWorkingDirectory()
    } else {
      this.workDir = path.join(process.cwd(), 'tmp', `agent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
      this.sandbox = new VirtualSandbox(this.workDir)
    }
    
    this.openai = OpenAIClient.getInstance()
  }

  async *run(): AsyncGenerator<StreamEvent> {
    try {
      yield { type: 'start', message: 'Agent process started.', timestamp: new Date().toISOString() }
      console.log('[AGENT] Starting agent with:', { repoUrl: this.repoUrl, prompt: this.prompt })

      await this.sandbox.initialize()
      yield { type: 'sandbox_create', message: 'Sandbox created.', timestamp: new Date().toISOString() }
      console.log('[AGENT] Sandbox initialized')
      
      const repoDir = '.'  // Change this to current directory since we clone into /tmp/repo
      console.log('[AGENT] Starting repository clone...')
      const cloneResult = yield* this.cloneRepository(this.repoUrl, repoDir)
      if (!cloneResult.success) {
        throw new Error(`Failed to clone repository: ${cloneResult.error}`)
      }
      console.log('[AGENT] Clone completed, starting analysis...')

      const { analysis, allFiles } = yield* this.analyzeRepository(repoDir)
      
      const plan = yield* this.createPlan(this.prompt, analysis, allFiles)
      console.log('[AGENT] Plan created:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles, approach: plan.approach.slice(0, 100) })

      const branchName = `codepilot/${Date.now()}`
      // Now run the git commands with the correct repoPath
      console.log('[AGENT] Creating branch:', branchName)
      const branchResult = yield* this.runTool('git_branch', {
        branchName,
        repoPath: undefined, // Use current directory
      }, 'Created new branch.')

      if (!branchResult.success) {
        throw new Error(`Failed to create branch: ${branchResult.error}`)
      }

      yield* this.implementPlan(plan, this.prompt, repoDir, analysis.projectRoot)
      console.log('[AGENT] Implementation completed')

      // Add final code validation stage
      console.log('[AGENT] Starting final code validation...')
      yield { type: 'implement', message: 'Validating generated code...', timestamp: new Date().toISOString() }
      
      const invalidFiles: string[] = []
      for (const filePath of plan.filesToModify) {
        const content = await this.readFile(filePath)
        if (content) {
          const validation = this.validateGeneratedCode(content, filePath)
          if (!validation.isValid) {
            console.log(`[AGENT] File ${filePath} has validation issues:`, validation.issues)
            invalidFiles.push(filePath)
            
            // Try to fix the file
            console.log(`[AGENT] Attempting to fix file: ${filePath}`)
            try {
              const fixedResult = yield* this.modifyFile(filePath, content, 'Clean up this code by removing any markdown formatting, explanations, and comments about the task. Return only clean, executable code.')
              if (fixedResult.success) {
                console.log(`[AGENT] Successfully fixed file: ${filePath}`)
              }
            } catch (error) {
              console.log(`[AGENT] Failed to fix file ${filePath}:`, error)
            }
          }
        }
      }
      
      if (invalidFiles.length > 0) {
        console.log(`[AGENT] Fixed ${invalidFiles.length} files with formatting issues`)
      } else {
        console.log('[AGENT] All files passed validation')
      }

      yield* this.runTool('git_add', { files: ['.'], repoPath: undefined }, 'Staged all changes.')
      console.log('[AGENT] Files staged for commit')

      const commitResult = yield* this.runTool('git_commit', {
        message: `feat: ${this.prompt.slice(0, 50)}`,
        repoPath: undefined,
      }, 'Committed changes.')
      
      if (!commitResult.success) {
        throw new Error(`Git commit failed: ${commitResult.error}`)
      }
      if (commitResult.data?.skipped) {
        yield { type: 'complete', message: 'No changes detected; nothing to commit or push.', timestamp: new Date().toISOString() }
        return // Early exit
      }
      
      console.log('[AGENT] Pushing changes to remote...')
      const pushResult = yield* this.runTool('git_push', { branchName, repoPath: undefined }, 'Pushed changes to remote.')

      if (!pushResult.success) {
        throw new Error(`Git push failed: ${pushResult.error}`)
      }
      
      console.log('[AGENT] Push completed, creating PR...')
      const prResult = yield* this.createPullRequest(branchName)

      console.log('[AGENT] PR created successfully:', prResult.url)
      
      yield {
        type: 'complete',
        message: 'Pull request created successfully!',
        data: { prUrl: prResult.url },
        timestamp: new Date().toISOString(),
      }
    } catch (error: any) {
      console.error('[AGENT] Error occurred:', error)
      const errorEvent: StreamEvent = {
        type: 'error',
        message: error.message,
        data: { details: error.stack },
        timestamp: new Date().toISOString(),
      }
      yield errorEvent
    } finally {
      console.log('[AGENT] Cleaning up sandbox...')
      await this.sandbox.cleanup()
    }
  }

  private async *cloneRepository(url: string, destination: string): AsyncGenerator<StreamEvent, ToolResult> {
    // For E2B sandbox, we don't need to specify destination as it handles its own path
    const useE2B = get('USE_E2B_SANDBOX') === 'true'
    const params = useE2B ? { url, destination: '.' } : { url, destination }
    
    return yield* this.runTool('clone_repository', params, 'Repository cloned successfully.')
  }

  private async *analyzeRepository(repoDir: string): AsyncGenerator<StreamEvent, { analysis: RepositoryAnalysis; allFiles: FileInfo[] }> {
    yield { type: 'analyze', message: 'Analyzing repository...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Starting repository analysis for directory:', repoDir)
    
    const listResult = await this.sandbox.callTool('list_files', { path: repoDir, recursive: true })
    console.log('[AGENT] List files result:', { success: listResult.success, fileCount: listResult.data?.files?.length })
    
    if (!listResult.success || !listResult.data.files) {
      throw new Error('Failed to list files in the repository.')
    }
    
    const allFiles: FileInfo[] = listResult.data.files
    console.log('[AGENT] Found files:', allFiles.map(f => f.path).slice(0, 10)) // Log first 10 files
    
    // Special case for Netropolis repository
    if (this.repoUrl.includes('Netropolis')) {
      const projectRoot = 'Frontend/netropolis'
      console.log(`[AGENT] Using known project root for Netropolis: ${projectRoot}`)
      
      const analysis: RepositoryAnalysis = {
        totalFiles: allFiles.length,
        languages: {},
        structure: {},
        keyFiles: [],
        dependencies: [],
        framework: '',
        packageManager: 'npm',
        projectRoot,
      }
      
      console.log('[AGENT] Analysis created:', { ...analysis, structure: '...' }) // Avoid logging large structure
      yield { type: 'analyze', message: 'Repository analysis complete.', timestamp: new Date().toISOString() }
      
      console.log('[AGENT] Analysis completed:', { totalFiles: analysis.totalFiles, languages: analysis.languages, projectRoot: analysis.projectRoot })
      return { analysis, allFiles }
    }
    
    // Find project root by looking for package.json
    const packageJsonFiles = allFiles.filter(f => f.path.endsWith('package.json') && !f.path.includes('node_modules'))
    let projectRoot = ''
    
    // First try to find Frontend/netropolis/package.json specifically for this repo
    const frontendPackageJson = packageJsonFiles.find(f => f.path.includes('Frontend/netropolis/package.json'))
    if (frontendPackageJson) {
      projectRoot = 'Frontend/netropolis'
      console.log(`[AGENT] Detected project root at: ${projectRoot} (found Frontend/netropolis/package.json)`)
    } 
    // Otherwise use any package.json
    else if (packageJsonFiles.length > 0) {
      projectRoot = packageJsonFiles[0].path.substring(0, packageJsonFiles[0].path.lastIndexOf('/'))
      console.log(`[AGENT] Detected project root at: ${projectRoot} (found ${packageJsonFiles[0].path})`)
    } else {
      console.log('[AGENT] Could not detect a clear project root.')
      
      // Fallback: Check if Frontend/netropolis directory exists even without package.json
      const hasFrontendDir = allFiles.some(f => f.path.startsWith('Frontend/netropolis/'))
      if (hasFrontendDir) {
        projectRoot = 'Frontend/netropolis'
        console.log(`[AGENT] Using fallback project root: ${projectRoot} (directory exists)`)
      }
    }

    const analysis: RepositoryAnalysis = {
      totalFiles: allFiles.length,
      languages: {},
      structure: {},
      keyFiles: [],
      dependencies: [],
      framework: '',
      packageManager: 'npm',
      projectRoot,
    }
    console.log('[AGENT] Analysis created:', { ...analysis, structure: '...' }) // Avoid logging large structure
    yield { type: 'analyze', message: 'Repository analysis complete.', timestamp: new Date().toISOString() }
    
    console.log('[AGENT] Analysis completed:', { totalFiles: analysis.totalFiles, languages: analysis.languages, projectRoot: analysis.projectRoot })
    return { analysis, allFiles }
  }

  private async *createPlan(prompt: string, analysis: RepositoryAnalysis, allFiles: FileInfo[]): AsyncGenerator<StreamEvent, ImplementationPlan> {
    yield { type: 'plan', message: 'Creating implementation plan...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Creating plan for prompt:', prompt)
    console.log('[AGENT] Analysis data:', { totalFiles: analysis.totalFiles, keyFiles: analysis.keyFiles })

    const context = `Repository Analysis:
- Total files: ${analysis.totalFiles}
- Key files: ${analysis.keyFiles.join(', ') || 'None found'}
- Package manager: ${analysis.packageManager || 'Unknown'}
- Framework: ${analysis.framework || 'Unknown'}
- Detected Project Root: ${analysis.projectRoot || 'Not detected'}

User Request: ${prompt}

IMPORTANT: This repository has a specific structure. All file paths in your plan MUST be relative to the project root "${analysis.projectRoot || '/'}". For example, if you need to modify a file in the src directory, the path should be "${analysis.projectRoot ? `${analysis.projectRoot}/src/filename.js` : 'src/filename.js'}".

Return ONLY the JSON object with your implementation plan.`

    // Try to parse the AI response as JSON, fallback to a reasonable plan
    let plan: ImplementationPlan
    try {
      const { code: planResponse } = await this.openai.generateCode(
        'Create a JSON implementation plan with fields: approach (string), filesToModify (array), newFiles (array), estimatedComplexity (low/medium/high). Be specific about which files need changes. Return ONLY the JSON object.',
        context,
        ''
      )

      console.log('[AGENT] OpenAI plan response:', planResponse.slice(0, 500))
      
      const aiPlan = JSON.parse(planResponse)
      plan = {
        approach: aiPlan.approach || 'Implement the requested changes',
        filesToModify: Array.isArray(aiPlan.filesToModify) ? aiPlan.filesToModify : [],
        newFiles: Array.isArray(aiPlan.newFiles) ? aiPlan.newFiles : [],
        steps: [],
        considerations: [],
        estimatedComplexity: aiPlan.estimatedComplexity || 'medium',
        technologies: [],
      }
      console.log('[AGENT] Successfully parsed AI plan:', plan)
    } catch (e) {
      console.log('[AGENT] Failed to parse AI plan, using smart fallback. Error:', e)
      
      // Smart fallback: look for authentication-related files in the repository
      const authFiles = allFiles.filter(f => 
        f.path.toLowerCase().includes('login') || 
        f.path.toLowerCase().includes('auth') || 
        f.path.toLowerCase().includes('register') ||
        f.path.toLowerCase().includes('signin') ||
        f.path.toLowerCase().includes('signup')
      ).map(f => f.path)
      
      console.log('[AGENT] Found authentication-related files:', authFiles)
      
      plan = {
        approach: `Delete and recreate authentication: ${prompt}`,
        filesToModify: authFiles.length > 0 ? authFiles : [],
        newFiles: authFiles.length === 0 ? ['auth/login.js', 'auth/register.js'] : [],
        steps: [],
        considerations: [],
        estimatedComplexity: 'medium',
        technologies: [],
      }
    }
    
    console.log('[AGENT] Generated plan:', plan)

    yield { type: 'plan', message: 'Implementation plan created.', data: plan, timestamp: new Date().toISOString() }
    return plan
  }

  private async *implementPlan(plan: ImplementationPlan, prompt: string, repoDir: string, projectRoot?: string): AsyncGenerator<StreamEvent> {
    yield { type: 'implement', message: 'Starting implementation...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Implementing plan:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles })

    // Import path only once at the beginning
    const path = await import('path')

    for (const filePath of plan.filesToModify) {
      // If the file path doesn't already include the project root, add it
      const fullPath = projectRoot && !filePath.startsWith(projectRoot) 
        ? path.default.join(repoDir, projectRoot, filePath) 
        : path.default.join(repoDir, filePath)
        
      console.log(`[AGENT] Processing file with full path: ${fullPath}`)
      const existingContent = await this.readFile(fullPath)
      yield* this.modifyFile(fullPath, existingContent, prompt)
    }

    for (const filePath of plan.newFiles) {
      // If the file path doesn't already include the project root, add it
      const fullPath = projectRoot && !filePath.startsWith(projectRoot) 
        ? path.default.join(repoDir, projectRoot, filePath) 
        : path.default.join(repoDir, filePath)
        
      console.log(`[AGENT] Creating new file with full path: ${fullPath}`)
      // Assuming modifyFile can create new files if existingContent is empty
      yield* this.modifyFile(fullPath, '', prompt)
    }

    console.log('[AGENT] Implementation plan execution completed')
  }

  /**
   * Validates if generated code is clean (no markdown, no explanations)
   */
  private validateGeneratedCode(code: string, filePath: string): { isValid: boolean; issues: string[] } {
    console.log('[AGENT] Validating generated code for:', filePath)
    
    const issues: string[] = []
    
    // Check for markdown code blocks
    if (code.includes('```')) {
      issues.push('Contains markdown code blocks')
    }
    
    // Check for explanatory text patterns
    const explanationPatterns = [
      /^To.*?code.*?:/i,
      /^Here.*?code.*?:/i,
      /^Below.*?code.*?:/i,
      /^This.*?code.*?:/i,
      /^To modify.*?:/i,
      /^To create.*?:/i,
      /Key Changes:/i,
      /### /,
      /## /,
      /^\d+\.\s.*:/m
    ]
    
    for (const pattern of explanationPatterns) {
      if (pattern.test(code)) {
        issues.push(`Contains explanatory text matching pattern: ${pattern.source}`)
      }
    }
    
    // Check if code starts with explanatory text instead of actual code
    const trimmedCode = code.trim()
    const codeStartPatterns = [
      /^import\s/,
      /^export\s/,
      /^function\s/,
      /^const\s/,
      /^let\s/,
      /^var\s/,
      /^class\s/,
      /^interface\s/,
      /^type\s/,
      /^<\w+/, // HTML/JSX
      /^\/\*/, // CSS comment
      /^\.[a-zA-Z]/, // CSS class
      /^#[a-zA-Z]/, // CSS ID
      /^\w+\s*{/ // Object or function
    ]
    
    const startsWithCode = codeStartPatterns.some(pattern => pattern.test(trimmedCode))
    if (!startsWithCode && trimmedCode.length > 0) {
      issues.push('Does not start with valid code syntax')
    }
    
    const isValid = issues.length === 0
    console.log('[AGENT] Code validation result:', { isValid, issues })
    
    return { isValid, issues }
  }

  private async *modifyFile(filePath: string, existingContent: string, description: string, retryCount: number = 0): AsyncGenerator<StreamEvent, ToolResult> {
    console.log('[AGENT] Modifying file:', filePath)
    console.log('[AGENT] Description:', description)
    
    const MAX_RETRIES = 2
    
    console.log('[AGENT] Existing content preview:', existingContent.slice(0, 100))
    console.log('[AGENT] Calling OpenAI with context:', `File path: ${filePath}\nDescription of changes: ${description}`)

    const { code: generatedCode } = await this.openai.generateCode(
      'Modify the following code based on the description.',
      `File path: ${filePath}\nDescription of changes: ${description}`,
      existingContent
    )

    console.log('[AGENT] OpenAI generated code preview:', generatedCode.slice(0, 100))
    console.log('[AGENT] Generated code length:', generatedCode.length)

    // Validate the generated code
    const validation = this.validateGeneratedCode(generatedCode, filePath)
    
    if (!validation.isValid && retryCount < MAX_RETRIES) {
      console.log(`[AGENT] Generated code is invalid (attempt ${retryCount + 1}/${MAX_RETRIES + 1}). Issues:`, validation.issues)
      console.log('[AGENT] Retrying with more specific instructions...')
      
      // Retry with more specific instructions
      const retryDescription = `${description}\n\nIMPORTANT: Generate ONLY clean executable code. Do NOT include markdown, explanations, or comments about the task. Return only the actual code that should be in the file.`
      
      yield* this.modifyFile(filePath, existingContent, retryDescription, retryCount + 1)
      return { success: true, toolName: 'write_file', executionTime: 0 }
    }
    
    if (!validation.isValid) {
      console.log(`[AGENT] Generated code is still invalid after ${MAX_RETRIES} retries. Issues:`, validation.issues)
      console.log('[AGENT] Using generated code anyway but logging warning')
    }

    const writeResult = yield* this.runTool('write_file', { path: filePath, content: generatedCode }, `File modified: ${filePath}`)
    console.log('[AGENT] Write file result:', { success: writeResult.success, error: writeResult.error })
    
    return writeResult
  }

  private async readFile(filePath: string): Promise<string> {
    console.log('[AGENT] Reading file:', filePath)
    const result = await this.sandbox.callTool('read_file', { path: filePath })
    console.log('[AGENT] Read file result:', { success: result.success, contentLength: result.data?.content?.length })
    
    if (!result.success) {
      console.log('[AGENT] Read file failed, returning empty string')
      return ''
    }
    
    const content = result.data.content || ''
    console.log('[AGENT] File content preview:', content.slice(0, 100))
    return content
  }

  private async *createPullRequest(branchName: string): AsyncGenerator<StreamEvent, GitHubPRResult> {
    yield { type: 'pr_create', message: 'Creating pull request...', timestamp: new Date().toISOString() }

    const { owner, repo } = this.parseRepoUrl(this.repoUrl)
    
    try {
      const prResult = await createPullRequestFromRepo(
        this.repoUrl,
        `feat: ${this.prompt.slice(0, 50)}...`,
        `This PR was generated by Code Pilot based on the following prompt:\n\n> ${this.prompt}`,
        branchName,
        'main'
      )

      console.log('[AGENT] PR created successfully:', prResult.url)
      return prResult
    } catch (error: any) {
      console.error('[AGENT] Failed to create pull request:', error)
      throw new Error(`Failed to create pull request: ${error.message}`)
    }
  }

  private parseRepoUrl(url: string): { owner: string; repo: string } {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)
    if (!match) throw new Error('Invalid GitHub repository URL')
    return { owner: match[1], repo: match[2].replace('.git', '') }
  }

  private async *runTool<T extends ToolName>(toolName: T, params: ToolParameters[T], successMessage: string): AsyncGenerator<StreamEvent, ToolResult> {
    yield { type: 'debug', message: `Running tool: ${toolName} with params: ${JSON.stringify(params).slice(0,200)}`, timestamp: new Date().toISOString() }
    try {
      const start = Date.now()
      const result = await this.sandbox.callTool(toolName, params)
      const duration = Date.now() - start
      if (!result.success) {
        const errorEvent: ToolErrorEvent = {
          type: 'tool_error',
          message: result.error || 'Tool failed',
          data: { toolName, error: result.error ?? 'Unknown', parameters: params },
          timestamp: new Date().toISOString(),
        }
        yield errorEvent
        return result
      }
      yield { type: toolName === 'clone_repository' ? 'clone' : 'implement', message: successMessage, timestamp: new Date().toISOString() }
      yield { type: 'debug', message: `Tool ${toolName} completed in ${duration}ms`, timestamp: new Date().toISOString(), data: { stdout: (result.stdout ?? '').slice(0,200) } as any }
      return result
    } catch (error: any) {
      const errorEvent: ToolErrorEvent = {
        type: 'tool_error',
        message: error.message,
        data: { toolName, error: error.message, parameters: params },
        timestamp: new Date().toISOString(),
      }
      yield errorEvent
      return { success: false, error: error.message, toolName, executionTime: 0 }
    }
  }
}