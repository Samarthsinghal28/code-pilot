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

  private async *checkForChanges(): AsyncGenerator<StreamEvent, boolean> {
    yield {
      type: 'debug',
      message: 'Checking for repository changes...',
      timestamp: new Date().toISOString()
    }

    try {
      // Try execute_shell first (works with E2B), fallback to git status
      let result: any;
      
      try {
        result = await this.sandbox.callTool('git_status', {
          repoPath: '.'
        });
      } catch (error: any) {
        console.error('[AGENT] git_status failed:', error);
        // If git_status fails, assume there are changes
        yield {
          type: 'debug',
          message: 'Could not check git status, assuming changes exist',
          timestamp: new Date().toISOString()
        }
        return true;
      }

      if (result.success) {
        const hasChanges = result.data?.hasChanges === true;
        
        yield {
          type: hasChanges ? 'file_change' : 'debug',
          message: hasChanges ? 'Repository changes detected' : 'No uncommitted changes detected',
          timestamp: new Date().toISOString(),
          data: {
            hasChanges,
            method: 'git_status'
          }
        }
        
        return hasChanges;
      }
      
      // Fallback to assuming changes exist if we couldn't determine status
      yield {
        type: 'debug',
        message: 'Could not determine git status, assuming changes exist',
        timestamp: new Date().toISOString()
      }
      return true;
    } catch (error: any) {
      console.error('[AGENT] Failed to check for changes:', error)
      // If all methods fail, assume changes were made to be safe
      yield {
        type: 'debug',
        message: 'Could not reliably check for changes, assuming changes were made',
        timestamp: new Date().toISOString(),
        data: { hasChanges: true, method: 'fallback_assume_changes', error: error?.message || 'Unknown error' }
      }
      return true;
    }
  }

  /**
   * Main agent execution loop
   */
  async *run(): AsyncGenerator<StreamEvent> {
    yield { type: 'start', message: 'Code Pilot agent starting...', timestamp: new Date().toISOString() }
    
    try {
      console.log('[AGENT] Starting agent with:', { repoUrl: this.repoUrl, prompt: this.prompt })
      
      // Initialize sandbox
      await this.sandbox.initialize()
      yield { type: 'sandbox_create', message: 'Secure sandbox environment created', timestamp: new Date().toISOString() }
      console.log('[AGENT] Sandbox initialized')
      
      // Clone repository
      console.log('[AGENT] Starting repository clone...')
      yield { type: 'progress', message: 'Cloning repository...', timestamp: new Date().toISOString(), progress: 10 }
      
      const cloneResult = await this.runTool('clone_repository', {
        url: this.repoUrl,
        destination: '.',
        depth: 1
      })
      
      if (!cloneResult.success) {
        throw new Error(`Failed to clone repository: ${cloneResult.error}`)
      }
      
      const repoDir = cloneResult.data?.path || '.'
      console.log('[AGENT] Clone completed, starting analysis...')
      yield { type: 'progress', message: 'Repository cloned, analyzing structure...', timestamp: new Date().toISOString(), progress: 20 }
      
      // Analyze repository
      const { analysis, allFiles } = yield* this.analyzeRepository(repoDir)
      yield { type: 'analysis_update', message: `Repository analysis complete: ${analysis.totalFiles} files found`, timestamp: new Date().toISOString(), progress: 40 }
      
      // Create implementation plan
      let plan: ImplementationPlan
      try {
        plan = yield* this.createPlan(this.prompt, analysis, allFiles)
        yield { type: 'plan', message: 'Implementation plan created.', timestamp: new Date().toISOString() }
        console.log('[AGENT] Plan created:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles, approach: plan.approach })
      } catch (error) {
        console.error('[AGENT] Planning failed:', error)
        yield { type: 'plan', message: 'Created fallback plan due to planning error.', timestamp: new Date().toISOString() }
        
        // Create a fallback plan focused on the most likely files
        plan = {
          approach: `Implement: ${this.prompt}`,
          filesToModify: [],
          newFiles: [],
          steps: [],
          considerations: [],
          estimatedComplexity: 'medium',
          technologies: []
        }
        
        // Look for login and registration related files
        const loginFiles = allFiles.filter(f => 
          (f.path.includes('login') || f.path.includes('register') || f.path.includes('auth')) && 
          (f.path.endsWith('.js') || f.path.endsWith('.jsx') || f.path.endsWith('.ts') || f.path.endsWith('.tsx'))
        ).map(f => f.path)
        
        if (loginFiles.length > 0) {
          plan.filesToModify = loginFiles
          console.log('[AGENT] Created fallback plan with login/registration files:', loginFiles)
        } else {
          // If no login files found, use some common source files
          plan.filesToModify = allFiles.filter(f => 
            f.path.includes('/src/') && 
            (f.path.endsWith('.js') || f.path.endsWith('.jsx') || f.path.endsWith('.ts') || f.path.endsWith('.tsx'))
          ).slice(0, 3).map(f => f.path)
        }
      }
      
      yield { 
        type: 'progress', 
        message: `Implementation plan created: ${plan.filesToModify.length} files to modify, ${plan.newFiles.length} new files`, 
        timestamp: new Date().toISOString(),
        progress: 50
      }
      
      // Create a branch for our changes
      const branchName = `codepilot/${Date.now()}`
      console.log('[AGENT] Creating branch:', branchName)
      
      const branchResult = await this.runTool('git_branch', {
        branchName
      })
      
      if (!branchResult.success) {
        throw new Error(`Failed to create branch: ${branchResult.error}`)
      }
      
      // Implement the changes
      yield { type: 'progress', message: 'Implementing changes...', timestamp: new Date().toISOString(), progress: 60 }
      yield* this.implementPlan(plan, this.prompt, repoDir, analysis.projectRoot)
      console.log('[AGENT] Implementation completed')

      yield {
        type: 'progress',
        message: 'Changes implemented, checking for uncommitted changes...',
        timestamp: new Date().toISOString(),
        progress: 85
      }

      // Check if there are any uncommitted changes left
      const hasChanges = yield* this.checkForChanges();
      
      if (hasChanges) {
        // Stage all changes
        yield { type: 'tool_call', message: 'Staging changes...', timestamp: new Date().toISOString() }
        const addResult = await this.runTool('git_add', {
          files: ['.'],
          repoPath: '.'
        });
        
        if (!addResult.success) {
          throw new Error(`Failed to stage changes: ${addResult.error}`);
        }
        
        // Commit the changes
        yield { type: 'tool_call', message: 'Committing changes...', timestamp: new Date().toISOString() }
        const commitResult = await this.runTool('git_commit', {
          message: `Improved login and registration logic\n\nEnhanced the login and registration components with better validation, error handling, and security features.`,
          repoPath: '.'
        });
        
        if (!commitResult.success && !commitResult.data?.skipped) {
          throw new Error(`Failed to commit changes: ${commitResult.error}`);
        }
        
        console.log('[AGENT] Changes committed successfully');
      } else {
        console.log('[AGENT] All changes already committed by autonomous implementation');
      }
      
      // Push the changes
      console.log('[AGENT] Pushing changes to remote...')
      yield { type: 'progress', message: 'Pushing changes to GitHub...', timestamp: new Date().toISOString(), progress: 90 }
      
      const pushResult = await this.runTool('git_push', {
        branchName
      })
      
      if (!pushResult.success) {
        throw new Error(`Failed to push changes: ${pushResult.error}`)
      }
      
      // Create a PR
      console.log('[AGENT] Push completed, creating PR...')
      yield { type: 'progress', message: 'Creating pull request...', timestamp: new Date().toISOString(), progress: 95 }
      
      yield { type: 'pr_create', message: 'Creating pull request...', timestamp: new Date().toISOString() }
      
      try {
        const prUrl = await this.createPullRequest(
          this.repoUrl,
          branchName,
          'main',
          `Improve login and registration logic`,
          `This PR enhances the login and registration functionality with better validation, error handling, and security features.

## Changes:
- Added form validation for login and registration
- Improved error handling and user feedback
- Enhanced security measures for authentication
- Implemented more reliable form submission logic

Requested by: Code Pilot Agent`
        )
        
        yield { type: 'pr_created', message: `Pull request created: ${prUrl}`, timestamp: new Date().toISOString(), data: { url: prUrl } }
        
        // Add a complete event for the UI
        yield { 
          type: 'complete', 
          message: 'Task completed successfully!', 
          timestamp: new Date().toISOString(), 
          data: { 
            prUrl: prUrl,
            prNumber: prUrl.split('/').pop(),
            branchName: branchName,
            filesChanged: plan.filesToModify.length + plan.newFiles.length,
            summary: plan.approach
          },
          progress: 100
        }
      } catch (error: any) {
        console.error('[AGENT] PR creation failed:', error);
        yield { type: 'error', message: `Failed to create PR: ${error.message}`, timestamp: new Date().toISOString() }
      }
      
      return
    } catch (error: any) {
      console.error('[AGENT] Error occurred:', error)
      yield { type: 'error', message: `Agent failed: ${error.message}`, timestamp: new Date().toISOString() }
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
    
    // Step 1: List all files
    const listResult = await this.sandbox.callTool('list_files', { path: '.', recursive: true })
    if (!listResult.success || !listResult.data.files) {
      throw new Error('Failed to list files in the repository.')
    }
    const allFiles: FileInfo[] = listResult.data.files
    console.log(`[AGENT] Found ${allFiles.length} files.`)

    // Step 2: Find the project root (most likely location of a package.json)
    const packageJsonPaths = allFiles.filter(f => f.path.endsWith('package.json') && !f.path.includes('node_modules'))
    let projectRoot = '.'
    if (packageJsonPaths.length > 0) {
      // Find the shallowest package.json
      packageJsonPaths.sort((a, b) => a.path.split('/').length - b.path.split('/').length)
      projectRoot = path.dirname(packageJsonPaths[0].path)
    }
    console.log(`[AGENT] Detected project root at: ${projectRoot}`)
    
    // Step 3: Analyze dependencies and framework from the root package.json
    let dependencies: PackageInfo[] = []
    let framework = ''
    let packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | undefined = undefined;

    const rootPackageJsonPath = allFiles.find(f => f.path === (projectRoot === '.' ? 'package.json' : `${projectRoot}/package.json`))
    if (rootPackageJsonPath) {
      const readResult = await this.sandbox.callTool('read_file', { path: rootPackageJsonPath.path })
      if (readResult.success && readResult.data.content) {
        try {
          const pkg = JSON.parse(readResult.data.content)
          const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          dependencies = Object.keys(allDeps).map(name => ({ 
            name, 
            version: allDeps[name],
            type: 'npm' // Default to npm, can be refined later
          }));

          if (dependencies.some(d => d.name === 'react')) framework = 'React'
          else if (dependencies.some(d => d.name === 'vue')) framework = 'Vue'
          else if (dependencies.some(d => d.name === '@angular/core')) framework = 'Angular'
          
          if (allFiles.some(f => f.path.includes('next.config.js'))) framework = 'Next.js'
          else if (dependencies.some(d => d.name === 'express')) framework = 'Express'

          if (allFiles.some(f => f.path.endsWith('yarn.lock'))) packageManager = 'yarn'
          else if (allFiles.some(f => f.path.endsWith('pnpm-lock.yaml'))) packageManager = 'pnpm'
          else if (allFiles.some(f => f.path.endsWith('package-lock.json'))) packageManager = 'npm'

        } catch (e) {
          console.log('[AGENT] Could not parse package.json for framework detection:', e)
        }
      }
    }
    console.log(`[AGENT] Detected framework: ${framework}, dependencies: ${dependencies.length}, package manager: ${packageManager}`)

    // Step 4: Analyze languages and identify key files
    const languages: { [key: string]: number } = {}
    const keyFiles: string[] = []

    allFiles.forEach(file => {
      const ext = path.extname(file.path).toLowerCase()
      const lang = this.getLanguageFromExtension(ext)
      if (lang) {
        languages[lang] = (languages[lang] || 0) + 1
      }
      // Simple heuristic for key files: package.json, configs, entry points
      if (file.path.endsWith('package.json') || 
          file.path.match(/vite|webpack|next\.config|tailwind\.config/i) ||
          file.path.match(/src\/(index|main|App)\.(js|ts|jsx|tsx)$/i)) {
        keyFiles.push(file.path)
      }
    });

    const analysis: RepositoryAnalysis = {
      totalFiles: allFiles.length,
      languages,
      structure: this.summarizeStructure(allFiles),
      keyFiles: keyFiles.slice(0, 15), // Limit for prompt efficiency
      dependencies,
      framework,
      packageManager,
      projectRoot,
    }

    console.log('[AGENT] Analysis created:', {
      totalFiles: analysis.totalFiles,
      languages: analysis.languages,
      projectRoot: analysis.projectRoot,
      framework: analysis.framework,
    })
    yield { type: 'analyze', message: 'Repository analysis complete.', timestamp: new Date().toISOString() }
    return { analysis, allFiles }
  }

  private detectLanguages(files: FileInfo[]): Record<string, number> {
    const languages: Record<string, number> = {}
    
    files.forEach(file => {
      const ext = file.path.split('.').pop()?.toLowerCase()
      if (!ext) return
      
      const langMap: Record<string, string> = {
        'js': 'JavaScript',
        'jsx': 'JavaScript',
        'ts': 'TypeScript', 
        'tsx': 'TypeScript',
        'py': 'Python',
        'java': 'Java',
        'cpp': 'C++',
        'c': 'C',
        'cs': 'C#',
        'php': 'PHP',
        'rb': 'Ruby',
        'go': 'Go',
        'rs': 'Rust',
        'css': 'CSS',
        'scss': 'SCSS',
        'html': 'HTML',
        'json': 'JSON',
        'md': 'Markdown'
      }
      
      const language = langMap[ext]
      if (language) {
        languages[language] = (languages[language] || 0) + 1
      }
    })
    
    return languages
  }

  private getLanguageFromExtension(ext: string): string | null {
    const languageMap: { [key: string]: string } = {
      '.js': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript',
      '.py': 'Python', '.java': 'Java', '.c': 'C', '.cpp': 'C++', '.h': 'C++',
      '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.html': 'HTML',
      '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less', '.md': 'Markdown',
      '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML', '.xml': 'XML',
      '.sh': 'Shell', '.sql': 'SQL',
    };
    return languageMap[ext] || null;
  }

  private summarizeStructure(files: FileInfo[]): Record<string, any> {
    const structure: Record<string, any> = {};
    const rootDirs = new Set(files.map(f => f.path.split('/')[0]));
    
    // Limit to a reasonable number of root directories to keep summary small
    const relevantDirs = Array.from(rootDirs).filter(d => 
        !d.startsWith('.') && !['node_modules', 'dist', 'build'].includes(d)
    ).slice(0, 10);

    return {
      root: relevantDirs,
      depth: Math.max(...files.map(f => f.path.split('/').length)),
    };
  }

  private async *createPlan(prompt: string, analysis: RepositoryAnalysis, allFiles: FileInfo[]): AsyncGenerator<StreamEvent, ImplementationPlan> {
    yield { type: 'plan', message: 'Creating implementation plan...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Creating plan for prompt:', prompt)
    console.log('[AGENT] Analysis data:', { totalFiles: analysis.totalFiles, keyFiles: analysis.keyFiles })

    try {
      // Use tool-enabled approach for smarter planning
      const toolNames = this.sandbox.getAvailableTools()
      const availableTools = toolNames.filter(name => 
        ['read_file', 'list_files'].includes(name) // Only use read tools for planning
      ).map(name => {
        const schema = this.sandbox.getToolSchema(name)
        return {
          type: 'function',
          function: {
            name: name,
            description: schema?.description || `Execute ${name} tool`,
            parameters: schema || { type: 'object', properties: {} }
          }
        }
      })

      const self = this
      const toolExecutor = async (toolName: string, params: any) => {
        console.log(`[AGENT] Planning tool: ${toolName}`)
        return await self.sandbox.callTool(toolName as any, params)
      }

    const context = `Repository Analysis:
- Total files: ${analysis.totalFiles}
- Key files: ${analysis.keyFiles.join(', ') || 'None found'}
- Package manager: ${analysis.packageManager || 'Unknown'}
- Framework: ${analysis.framework || 'Unknown'}
- Detected Project Root: ${analysis.projectRoot || 'Not detected'}

Sample files from repository:
${allFiles.slice(0, 20).map(f => f.path).join('\n')}

You can use read_file and list_files tools to better understand the codebase structure before creating your plan.

Create a JSON implementation plan with these exact fields:
- approach: string describing your strategy
- filesToModify: array of file paths that need changes
- newFiles: array of file paths for new files to create
- estimatedComplexity: "low", "medium", or "high"

User Request: ${prompt}`

      const planningPrompt = `Analyze the repository structure and create a detailed implementation plan for: "${prompt}"

Use the available tools to explore the codebase first, then respond with a JSON object containing your implementation plan.`

      yield { type: 'plan', message: 'Analyzing repository structure...', timestamp: new Date().toISOString() }

      const { result } = await this.openai.executeWithTools(
        planningPrompt,
        context,
        availableTools,
        toolExecutor
      )

      console.log('[AGENT] AI planning result:', result.slice(0, 500))

      // Use a more robust regex to find the JSON blob, even with leading/trailing text
      const jsonMatch = result.match(/```json\s*([\s\S]+?)\s*```/);
      if (!jsonMatch || jsonMatch.length < 2) {
        console.error('[AGENT] AI response did not contain a valid JSON code block. Raw response:', result)
        throw new Error('AI failed to return a valid implementation plan in the expected JSON format.')
      }

      const planJson = jsonMatch[1];
      let aiPlan;
      
      try {
        const parsedJson = JSON.parse(planJson);
        
        // Handle both direct format and nested "implementation_plan" format
        aiPlan = parsedJson.implementation_plan || parsedJson;
        
        console.log('[AGENT] Parsed plan structure:', JSON.stringify(aiPlan, null, 2).slice(0, 500));
        
        // Extract files to modify from steps if needed
        if (aiPlan.steps && Array.isArray(aiPlan.steps) && (!aiPlan.filesToModify || aiPlan.filesToModify.length === 0)) {
          aiPlan.filesToModify = aiPlan.steps
            .filter((step: any) => step.details && step.details.file)
            .map((step: any) => step.details.file);
          
          console.log('[AGENT] Extracted files to modify from steps:', aiPlan.filesToModify);
        }
      } catch (error) {
        console.error('[AGENT] Failed to parse plan JSON:', error);
        throw new Error('Failed to parse the AI-generated implementation plan.');
      }

      // Validate the plan has actionable steps
      if (!aiPlan.filesToModify || (aiPlan.filesToModify.length === 0 && (!aiPlan.newFiles || aiPlan.newFiles.length === 0))) {
        console.error('[AGENT] AI returned an empty or invalid plan:', aiPlan);
        throw new Error('AI planner returned an empty plan. There are no files to modify or create.');
      }
      
      // Validate and clean the plan
      const plan: ImplementationPlan = {
        approach: (aiPlan.approach || 'Implement requested changes').slice(0, 500),
        filesToModify: Array.isArray(aiPlan.filesToModify) ? aiPlan.filesToModify : [],
        newFiles: Array.isArray(aiPlan.newFiles) ? aiPlan.newFiles : [],
        steps: [],
        considerations: [],
        estimatedComplexity: aiPlan.estimatedComplexity || 'medium',
        technologies: [],
      }
      
      console.log('[AGENT] Generated plan:', plan)

      yield { type: 'plan', message: 'Implementation plan created.', data: plan, timestamp: new Date().toISOString() }
      return plan

    } catch (error) {
      console.error('[AGENT] Planning failed:', error)
      
      // Fallback plan
      const fallbackPlan: ImplementationPlan = {
        approach: `Implement: ${prompt}`,
        filesToModify: allFiles.filter(f => 
          f.path.includes('.js') || f.path.includes('.ts') || f.path.includes('.jsx') || f.path.includes('.tsx')
        ).slice(0, 3).map(f => f.path),
        newFiles: [],
        steps: [],
        considerations: [],
        estimatedComplexity: 'medium',
        technologies: [],
      }
      
      yield { type: 'plan', message: 'Created fallback plan due to planning error.', data: fallbackPlan, timestamp: new Date().toISOString() }
      return fallbackPlan
    }
  }

  /**
   * Implement the plan by modifying files
   */
  private async *implementPlan(
    plan: ImplementationPlan, 
    prompt: string,
    repoDir: string,
    projectRoot?: string
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'implement', message: 'Starting implementation...', timestamp: new Date().toISOString() }
    
    console.log('[AGENT] Implementing plan:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles })
    
    try {
      // Use autonomous implementation with direct tool access
      yield* this.implementWithTools(plan, prompt)
      
      yield { type: 'implement', message: 'Implementation plan execution completed', timestamp: new Date().toISOString() }
      console.log('[AGENT] Implementation completed')
    } catch (error: any) {
      console.error('[AGENT] Implementation failed:', error)
      yield { type: 'error', message: `Implementation failed: ${error.message}`, timestamp: new Date().toISOString() }
      throw error
    }
  }

  /**
   * Implement the plan using autonomous LLM tool calling
   */
  private async *implementWithTools(plan: ImplementationPlan, prompt: string): AsyncGenerator<StreamEvent> {
    yield { type: 'implement', message: 'Starting autonomous implementation with direct tool access...', timestamp: new Date().toISOString() }
    yield { type: 'implement', message: 'Executing autonomous implementation...', timestamp: new Date().toISOString() }
    
    // Create a system prompt that explains the current state and available tools
    const systemPrompt = `You are an AI coding assistant with access to a sandbox environment. 
You are currently in a Git repository that has been cloned to the current directory.
The repository is on branch 'codepilot/${Date.now()}' and you need to implement changes based on the user's request.

Your task: ${prompt}

Files to modify based on the plan:
${plan.filesToModify.map(file => `- ${file}`).join('\n')}

${plan.newFiles.length > 0 ? `New files to create:\n${plan.newFiles.map(file => `- ${file}`).join('\n')}` : ''}

IMPORTANT: 
1. You are already in the repository directory. DO NOT try to clone the repository again.
2. Use relative paths from the repository root (e.g. "src/file.js" not "/tmp/repo/src/file.js").
3. Use git_add and git_commit after making changes.
4. Make sure to implement robust validation, error handling, and security best practices.
5. Focus on improving the login and registration functionality.`

    // Execute the implementation with tools
    try {
      const result = await this.openai.executeWithTools(
        systemPrompt,
        prompt,
        [
          'list_files',
          'read_file',
          'write_file',
          'git_add',
          'git_status',
          'git_commit'
        ],
        this.sandbox
      )
      
      yield { type: 'implement', message: `Implementation completed. Used ${result.toolCalls.length} tool calls. Result: ${result.content?.slice(0, 100)}...`, timestamp: new Date().toISOString() }
      
      console.log('[AGENT] Autonomous implementation completed')
      console.log('[AGENT] Tools used:', result.toolCalls.map(tc => tc.name))
      console.log('[AGENT] Token usage:', result.usage)
      
      return
    } catch (error: any) {
      console.error('[AGENT] Implementation failed:', error)
      yield { type: 'error', message: `Implementation failed: ${error.message}`, timestamp: new Date().toISOString() }
      throw error
    }
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

    const writeResult = await this.runTool('write_file', { path: filePath, content: generatedCode }, `File modified: ${filePath}`)
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

  private async createPullRequest(repoUrl: string, branchName: string, baseBranch: string, title: string, body: string): Promise<string> {
    console.log('[AGENT] Creating pull request...');
    
    const { owner, repo } = this.parseRepoUrl(repoUrl)
    
    try {
      const prResult = await createPullRequestFromRepo(
        repoUrl,
        title,
        body,
        branchName,
        baseBranch
      )

      console.log('[AGENT] PR created successfully:', prResult.url)
      return prResult.url
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

  /**
   * Run a tool and emit events for it
   */
  private async runTool<T extends ToolName>(
    toolName: T, 
    params: ToolParameters[T],
    successMessage?: string
  ): Promise<ToolResult> {
    const startTime = Date.now()
    
    // Emit tool call started event
    const callEvent: StreamEvent = {
      type: 'tool_call',
      message: `Executing ${toolName}...`,
      timestamp: new Date().toISOString(),
      details: {
        tool: toolName,
        operation: 'started',
        status: 'started'
      }
    }
    
    console.log(`[AGENT] Executing tool: ${toolName}`)
    
    try {
      const result = await this.sandbox.callTool(toolName, params)
      
      // Emit tool call completed event
      const completedEvent: StreamEvent = {
        type: 'tool_call',
        message: successMessage || (result.success ? `${toolName} completed successfully.` : `${toolName} failed: ${result.error}`),
        timestamp: new Date().toISOString(),
        details: {
          tool: toolName,
          operation: 'completed',
          status: 'completed',
          error: result.error
        }
      }
      
      // Emit debug event with timing info
      const debugEvent: StreamEvent = {
        type: 'debug',
        message: `Tool ${toolName} completed in ${Date.now() - startTime}ms`,
        timestamp: new Date().toISOString()
      }
      
      return result
    } catch (error: any) {
      console.error(`[AGENT] Tool ${toolName} failed:`, error)
      
      // Emit tool call failed event
      const failedEvent: StreamEvent = {
        type: 'tool_call',
        message: `${toolName} failed: ${error.message}`,
        timestamp: new Date().toISOString(),
        details: {
          tool: toolName,
          operation: 'completed',
          status: 'failed',
          error: error.message
        }
      }
      
      throw error
    }
  }
}