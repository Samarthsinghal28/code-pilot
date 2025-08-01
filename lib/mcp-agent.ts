import {
  StreamEvent,
  EventType,
  ToolParameters,
  ToolName,
  ToolResult,
  RepositoryAnalysis,
  ImplementationPlan,
  FileInfo,
  PackageInfo
} from '@/types'
import { VirtualSandbox } from './mcp-sandbox'
import { E2BSandbox } from './e2b-sandbox'
import { SandboxManager } from './sandbox-manager'
import { OpenAIClient } from './llm/openai'
import { createPullRequestFromRepo } from './github/api'
import { get } from '@/lib/config/env'
import * as path from 'path'
import { githubAPI } from './github/api'
import { CodePilotError, ValidationError } from '@/lib/errors'

export class McpAgent {
  private sandbox: VirtualSandbox | E2BSandbox
  public openai: OpenAIClient
  private repoUrl: string
  private prompt: string
  private workDir: string
  private defaultBranch: string = 'main'
  private verificationMode: boolean = false
  private verificationSessionId?: string
  private plan?: ImplementationPlan
  private sessionId: string

  constructor(repoUrl: string, prompt: string, verificationMode: boolean = false) {
    this.repoUrl = repoUrl
    this.prompt = prompt
    this.verificationMode = verificationMode
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    
    const useE2B = get('USE_E2B_SANDBOX') === 'true'
    
    if (useE2B) {
      this.sandbox = new E2BSandbox()
      SandboxManager.getInstance().registerSandbox(this.sessionId, this.sandbox as E2BSandbox)
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
      let result: any;
      
      try {
        result = await this.sandbox.callTool('git_status', {
          repoPath: '.'
        });
      } catch (error: any) {
        console.error('[AGENT] git_status failed:', error);
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
      
      yield {
        type: 'debug',
        message: 'Could not determine git status, assuming changes exist',
        timestamp: new Date().toISOString()
      }
      return true;
    } catch (error: any) {
      console.error('[AGENT] Failed to check for changes:', error)
      yield {
        type: 'debug',
        message: 'Could not reliably check for changes, assuming changes were made',
        timestamp: new Date().toISOString(),
        data: { hasChanges: true, method: 'fallback_assume_changes', error: error?.message || 'Unknown error' }
      }
      return true;
    }
  }

  async *run(): AsyncGenerator<StreamEvent> {
    yield { type: 'start', message: 'Code Pilot agent starting...', timestamp: new Date().toISOString() }
    
    try {
      console.log('[AGENT] Starting agent with:', { repoUrl: this.repoUrl, prompt: this.prompt })

      await this.sandbox.initialize()
      yield { type: 'sandbox_create', message: 'Secure sandbox environment created', timestamp: new Date().toISOString() }
      console.log('[AGENT] Sandbox initialized')
      
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

      const { analysis, allFiles } = yield* this.analyzeRepository(repoDir)
      yield { type: 'analysis_update', message: `Repository analysis complete: ${analysis.totalFiles} files found`, timestamp: new Date().toISOString(), progress: 40 }
      
      let plan: ImplementationPlan
      try {
        plan = yield* this.createPlan(this.prompt, analysis, allFiles)
        this.plan = plan 
        yield { type: 'plan', message: 'Implementation plan created.', timestamp: new Date().toISOString() }
        console.log('[AGENT] Plan created:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles, approach: plan.approach })
      } catch (error) {
        console.error('[AGENT] Planning failed:', error)
        yield { type: 'plan', message: 'Created fallback plan due to planning error.', timestamp: new Date().toISOString() }
        
        plan = {
          approach: `Implement: ${this.prompt}`,
          filesToModify: [],
          newFiles: [],
          steps: [],
          considerations: [],
          estimatedComplexity: 'medium',
          technologies: []
        }
        
        const loginFiles = allFiles.filter(f => 
          (f.path.includes('login') || f.path.includes('register') || f.path.includes('auth')) && 
          (f.path.endsWith('.js') || f.path.endsWith('.jsx') || f.path.endsWith('.ts') || f.path.endsWith('.tsx'))
        ).map(f => f.path)
        
        if (loginFiles.length > 0) {
          plan.filesToModify = loginFiles
          console.log('[AGENT] Created fallback plan with login/registration files:', loginFiles)
        } else {
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
      
      const branchName = `codepilot/${Date.now()}`
      console.log('[AGENT] Creating branch:', branchName)
      
      console.log('[AGENT] Creating branch:', branchName)
      yield { type: 'progress', message: 'Creating feature branch...', timestamp: new Date().toISOString(), progress: 80 }

      const branchResult = await this.runTool('git_branch', {
          branchName
        })

      if (!branchResult.success) {
        throw new Error(`Failed to create branch: ${branchResult.error}`)
      }

      if (typeof branchResult.data === 'string' && branchResult.data.includes('CURRENT_BRANCH:')) {
          const branchMatch = branchResult.data.match(/CURRENT_BRANCH:\s*(\w+)/);
          if (branchMatch) {
            this.defaultBranch = branchMatch[1];
            console.log(`[AGENT] Detected default branch from git operation: ${this.defaultBranch}`);
          }
        }

      yield { type: 'progress', message: 'Implementing changes...', timestamp: new Date().toISOString(), progress: 60 }
      yield* this.implementPlan(plan, this.prompt, repoDir, analysis.projectRoot)
      console.log('[AGENT] Implementation completed')

      yield {
        type: 'progress',
        message: 'Changes implemented, checking for uncommitted changes...',
        timestamp: new Date().toISOString(),
        progress: 85
      }

      const hasChanges = yield* this.checkForChanges();
      
      if (hasChanges) {
        yield { type: 'tool_call', message: 'Staging changes...', timestamp: new Date().toISOString() }
        const addResult = await this.runTool('git_add', {
          files: ['.'],
          repoPath: '.'
        });
        
        if (!addResult.success) {
          throw new Error(`Failed to stage changes: ${addResult.error}`);
        }
        
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
      
      if (this.verificationMode) {
        this.verificationSessionId = this.sessionId;
        
        yield {
          type: 'pause_for_verification',
          message: 'Changes implemented and committed. Pausing for user verification...',
          timestamp: new Date().toISOString(),
          data: {
            sessionId: this.verificationSessionId,
            branchName: branchName,
            filesChanged: plan.filesToModify.concat(plan.newFiles),
            repoPath: this.workDir,
            sandboxId: this.sandbox instanceof E2BSandbox ? (this.sandbox as any).sandboxId : undefined
          },
          progress: 85
        };
        return; 
      }
      
      console.log('[AGENT] Pushing changes to remote...')
      yield { type: 'progress', message: 'Pushing changes to GitHub...', timestamp: new Date().toISOString(), progress: 90 }
      
      const pushResult = await this.runTool('git_push', {
        branchName
      })

      if (!pushResult.success) {
        throw new Error(`Failed to push changes: ${pushResult.error}`)
      }
      
      console.log('[AGENT] Push completed, creating PR...')
      yield { type: 'progress', message: 'Creating pull request...', timestamp: new Date().toISOString(), progress: 95 }
      
      yield { type: 'pr_create', message: 'Creating pull request...', timestamp: new Date().toISOString() }
      
      try {
        const { title, body } = await this.generatePrDetails()
        const prUrl = await this.createPullRequest(
          this.repoUrl,
          branchName,
          this.defaultBranch,
          title,
          body
        )
        
        yield { type: 'pr_created', message: `Pull request created: ${prUrl}`, timestamp: new Date().toISOString(), data: { url: prUrl } }
        
      yield {
        type: 'complete',
          message: 'Task completed successfully!', 
        timestamp: new Date().toISOString(),
          data: { 
            prUrl: prUrl,
            prNumber: prUrl.split('/').pop(),
            branchName: branchName,
            filesChanged: (this.plan?.filesToModify.length ?? 0) + (this.plan?.newFiles.length ?? 0),
            summary: this.plan?.approach ?? 'Changes verified and published by user'
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
      if (!this.verificationMode) {
        console.log('[AGENT] Cleaning up sandbox...')
        await this.sandbox.cleanup()
      } else {
        console.log('[AGENT] Keeping sandbox alive for verification...')
      }
    }
  }

  async *continueAfterVerification(branchName: string): AsyncGenerator<StreamEvent> {
    if (!this.verificationSessionId) {
      throw new Error('No verification session active');
    }
    this.sessionId = this.verificationSessionId

    try {
      const sandbox = await SandboxManager.getInstance().getSandbox(this.sessionId)
      this.sandbox = sandbox

      console.log('[AGENT] Pushing changes to remote...')
      yield { type: 'progress', message: 'Pushing changes to GitHub...', timestamp: new Date().toISOString(), progress: 90 }
      
      const pushResult = await this.runTool('git_push', {
        branchName
      })

      if (!pushResult.success) {
        throw new Error(`Failed to push changes: ${pushResult.error}`)
      }
      
      console.log('[AGENT] Push completed, creating PR...')
      yield { type: 'progress', message: 'Creating pull request...', timestamp: new Date().toISOString(), progress: 95 }
      
      yield { type: 'pr_create', message: 'Creating pull request...', timestamp: new Date().toISOString() }
      
      try {
        const { title, body } = await this.generatePrDetails()
        const prUrl = await this.createPullRequest(
          this.repoUrl,
          branchName,
          this.defaultBranch,
          title,
          body
        )
        
        yield { type: 'pr_created', message: `Pull request created: ${prUrl}`, timestamp: new Date().toISOString(), data: { url: prUrl } }
        
      yield {
        type: 'complete',
          message: 'Task completed successfully!', 
        timestamp: new Date().toISOString(),
          data: { 
            prUrl: prUrl,
            prNumber: prUrl.split('/').pop(),
            branchName: branchName,
            filesChanged: (this.plan?.filesToModify.length ?? 0) + (this.plan?.newFiles.length ?? 0),
            summary: this.plan?.approach ?? 'Changes verified and published by user'
          },
          progress: 100
      }
    } catch (error: any) {
        console.error('[AGENT] PR creation failed:', error);
        yield { type: 'error', message: `Failed to create PR: ${error.message}`, timestamp: new Date().toISOString() }
      }
    } catch (error: any) {
      console.error('[AGENT] Error during verification continuation:', error)
      yield { type: 'error', message: `Failed to continue after verification: ${error.message}`, timestamp: new Date().toISOString() }
    } finally {
      console.log('[AGENT] Cleaning up sandbox after verification...')
      await this.sandbox.cleanup()
      this.verificationSessionId = undefined;
    }
  }

  private async generatePrDetails(): Promise<{ title: string; body: string }> {
    if (!this.plan) {
      throw new Error("Plan is not available to generate PR details.");
    }

    const prPrompt = `
      Based on the user's request and the implementation approach, generate a concise and descriptive Pull Request title and a markdown-formatted body.

      User Request: "${this.prompt}"

      Implementation Approach: "${this.plan.approach}"

      Files Modified:
      ${this.plan.filesToModify.map(f => `- \`${f}\``).join('\n')}
      
      New Files:
      ${this.plan.newFiles.map(f => `- \`${f}\``).join('\n')}

      Return ONLY a JSON object with this structure:
      {
        "title": "A short, descriptive PR title starting with a verb (e.g., 'Feat:', 'Fix:', 'Refactor:')",
        "body": "A markdown-formatted PR body. Include a short summary of the changes and a bulleted list of key modifications. Be professional and clear."
      }
    `;

    try {
      const result = await this.openai.generateCode(prPrompt, '', '');
      if (!result.code) {
        throw new Error("AI did not return any code for the PR details.");
      }
      return JSON.parse(result.code);
    } catch (error) {
      console.error('[AGENT] Failed to generate PR details, using fallback.', error);
      const approach = this.plan?.approach ?? "The AI agent's plan was not available.";
      return {
        title: `Feat: Apply AI-generated changes for task: ${this.prompt.slice(0, 50)}`,
        body: `This pull request was generated by an AI agent based on the following prompt:\n\n> ${this.prompt}\n\n**Implementation Approach:**\n${approach}`
      };
    }
  }

  getVerificationSessionId(): string | undefined {
    return this.verificationSessionId;
  }

  async getVerificationSession() {
    return {
      sessionId: this.verificationSessionId,
      sandbox: this.sandbox,
      workDir: this.workDir,
      isActive: !!this.verificationSessionId,
      branchName: this.sandbox ? await this.getCurrentBranch() : undefined
    }
  }
  
  private async getCurrentBranch(): Promise<string> {
    try {
      const result = await this.executeCommand('git branch --show-current');
      return result.stdout.trim() || 'main';
    } catch (error) {
      console.error('[AGENT] Failed to get current branch:', error);
      return 'main';
    }
  }

  async getDiff(): Promise<string> {
    try {
      const committedResult = await this.executeCommand('git diff HEAD~1');
      if (committedResult.stdout.trim()) {
        return committedResult.stdout;
      }
      
      const stagedResult = await this.executeCommand('git diff --cached');
      if (stagedResult.stdout.trim()) {
        return stagedResult.stdout;
      }
      
      const unstagedResult = await this.executeCommand('git diff');
      if (unstagedResult.stdout.trim()) {
        return unstagedResult.stdout;
      }
      
      const statusResult = await this.executeCommand('git status');
      return statusResult.stdout || 'No changes detected';
    } catch (error: any) {
      console.error('[AGENT] Failed to get diff:', error);
      return `Error getting diff: ${error.message}`;
    }
  }

  async executeCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await this.sandbox.callTool('execute_shell', {
        command
      });
      
      if (result.success) {
        return {
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: 0
        };
      } else {
        return {
          stdout: '',
          stderr: result.error || 'Command failed',
          exitCode: 1
        };
      }
    } catch (error: any) {
      return {
        stdout: '',
        stderr: error.message,
        exitCode: 1
      };
    }
  }

  async cleanupVerification() {
    this.verificationSessionId = undefined;
    await this.sandbox.cleanup();
  }

  private async *cloneRepository(url: string, destination: string): AsyncGenerator<StreamEvent, ToolResult> {
    const useE2B = get('USE_E2B_SANDBOX') === 'true'
    const params = useE2B ? { url, destination: '.' } : { url, destination }
    
    const result = await this.runTool('clone_repository', params, 'Repository cloned successfully.')
    return result
  }

  private async analyzeRepositoryWithLLM(allFiles: FileInfo[]): Promise<{
    projectType: string;
    primaryLanguages: string[];
    keyDirectories: string[];
    keyFiles: string[];
    backendFiles: string[];
    frontendFiles: string[];
    configFiles: string[];
    analysisNotes: string;
  }> {
    const sampleFiles = allFiles
      .filter(f => !f.path.includes('node_modules') && !f.path.includes('.git'))
      .slice(0, 50)
      .map(f => f.path)
      .join('\n');

    const analysisPrompt = `Analyze this repository structure and provide intelligent insights:

FILES (sample of ${allFiles.length} total):
${sampleFiles}

Analyze and return ONLY a JSON object with this structure:
{
  "projectType": "description of what this project is (e.g., 'Full-stack web app with React frontend and Python backend')",
  "primaryLanguages": ["list", "of", "main", "programming", "languages"],
  "keyDirectories": ["most", "important", "directories"],
  "keyFiles": ["most", "important", "files", "for", "development"],
  "backendFiles": ["files", "that", "handle", "server", "logic"],
  "frontendFiles": ["files", "that", "handle", "client", "UI"],
  "configFiles": ["configuration", "and", "build", "files"],
  "analysisNotes": "brief summary of the repository structure and architecture"
}

Focus on:
- Identifying the main application entry points
- Distinguishing between frontend, backend, and configuration code
- Understanding the project's architecture and tech stack
- Highlighting files most likely to contain business logic`;

    try {
      const result = await this.openai.executeWithTools(
        analysisPrompt,
        '',
        ['read_file'],
        this.sandbox
      );

      const jsonMatch = result.content?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.error('[AGENT] LLM repository analysis failed:', error);
    }

    return this.fallbackRepositoryAnalysis(allFiles);
  }

  private fallbackRepositoryAnalysis(allFiles: FileInfo[]): {
    projectType: string;
    primaryLanguages: string[];
    keyDirectories: string[];
    keyFiles: string[];
    backendFiles: string[];
    frontendFiles: string[];
    configFiles: string[];
    analysisNotes: string;
  } {
    const languages: { [key: string]: number } = {};
    const directories = new Set<string>();
    const backendFiles: string[] = [];
    const frontendFiles: string[] = [];
    const configFiles: string[] = [];

    allFiles.forEach(file => {
      const ext = path.extname(file.path).toLowerCase();
      const lang = this.getLanguageFromExtension(ext);
      const dir = path.dirname(file.path);
      
      if (lang) {
        languages[lang] = (languages[lang] || 0) + 1;
      }

      if (dir !== '.' && !dir.includes('node_modules')) {
        directories.add(dir.split('/')[0]);
      }

      if (file.path.match(/\.(py|java|go|rs|php|rb)$/)) {
        backendFiles.push(file.path);
      } else if (file.path.match(/\.(js|jsx|ts|tsx|vue|html|css)$/) && 
                 file.path.match(/(src|components|pages|views)/)) {
        frontendFiles.push(file.path);
      } else if (file.path.match(/(package\.json|requirements\.txt|Cargo\.toml|pom\.xml|Gemfile|composer\.json)$/)) {
        configFiles.push(file.path);
      }
    });

    const primaryLanguages = Object.entries(languages)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([lang]) => lang);

    return {
      projectType: `Multi-language project with ${primaryLanguages.join(', ')}`,
      primaryLanguages,
      keyDirectories: Array.from(directories).slice(0, 5),
      keyFiles: [...configFiles, ...backendFiles.slice(0, 3), ...frontendFiles.slice(0, 3)],
      backendFiles: backendFiles.slice(0, 10),
      frontendFiles: frontendFiles.slice(0, 10),
      configFiles,
      analysisNotes: `Detected ${Object.keys(languages).length} languages across ${directories.size} directories`
    };
  }

  private async *analyzeRepository(repoDir: string): AsyncGenerator<StreamEvent, { analysis: RepositoryAnalysis; allFiles: FileInfo[] }> {
    yield { type: 'analyze', message: 'Analyzing repository...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Starting repository analysis for directory:', repoDir)
    
    const listResult = await this.sandbox.callTool('list_files', { path: '.', recursive: true })
    if (!listResult.success || !listResult.data.files) {
      throw new Error('Failed to list files in the repository.')
    }
    const allFiles: FileInfo[] = listResult.data.files
    console.log(`[AGENT] Found ${allFiles.length} files.`)

    yield { type: 'analyze', message: 'Performing intelligent repository analysis...', timestamp: new Date().toISOString() }
    const intelligentAnalysis = await this.analyzeRepositoryWithLLM(allFiles);
    
    let projectRoot = '.';
    const rootCandidates = intelligentAnalysis.configFiles
      .map(f => path.dirname(f))
      .filter(dir => dir !== '.')
      .sort((a, b) => a.split('/').length - b.split('/').length);
    
    if (rootCandidates.length > 0) {
      projectRoot = rootCandidates[0];
    }
    console.log(`[AGENT] Detected project root at: ${projectRoot}`);

    let dependencies: PackageInfo[] = [];
    let framework = '';
    let packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | undefined = undefined;

    const mainPackageJson = intelligentAnalysis.configFiles.find(f => f.endsWith('package.json') && !f.includes('node_modules'));
    if (mainPackageJson) {
      const readResult = await this.sandbox.callTool('read_file', { path: mainPackageJson });
      if (readResult.success && readResult.data.content) {
        try {
          const pkg = JSON.parse(readResult.data.content);
          const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
          dependencies = Object.keys(allDeps).map(name => ({ 
            name, 
            version: allDeps[name],
            type: 'npm'
          }));

          if (dependencies.some(d => d.name === 'react')) framework = 'React';
          else if (dependencies.some(d => d.name === 'vue')) framework = 'Vue';
          else if (dependencies.some(d => d.name === '@angular/core')) framework = 'Angular';
          else if (dependencies.some(d => d.name === 'next')) framework = 'Next.js';
          else if (dependencies.some(d => d.name === 'express')) framework = 'Express';

          if (allFiles.some(f => f.path.endsWith('yarn.lock'))) packageManager = 'yarn';
          else if (allFiles.some(f => f.path.endsWith('pnpm-lock.yaml'))) packageManager = 'pnpm';
          else if (allFiles.some(f => f.path.endsWith('package-lock.json'))) packageManager = 'npm';
        } catch (e) {
          console.log('[AGENT] Could not parse package.json:', e);
        }
      }
    }

    const languages: Record<string, number> = {}
    allFiles.forEach(file => {
      const ext = path.extname(file.path).toLowerCase()
      const lang = this.getLanguageFromExtension(ext)
      if (lang) {
        languages[lang] = (languages[lang] || 0) + 1
      }
    })

    try {
      const gitStatusResult = await this.sandbox.callTool('git_status', { repoPath: '.' });
      if (gitStatusResult.success && gitStatusResult.data) {
        const output = gitStatusResult.data;
        if (typeof output === 'string') {
          const branchMatch = output.match(/CURRENT_BRANCH:\s*(\w+)/);
          if (branchMatch) {
            this.defaultBranch = branchMatch[1];
            console.log(`[AGENT] Detected default branch: ${this.defaultBranch}`);
          }
        }
      }
    } catch (error) {
      console.log('[AGENT] Could not detect default branch, using "main"');
    }
      
      const analysis: RepositoryAnalysis = {
        totalFiles: allFiles.length,
      languages,
      structure: this.summarizeStructure(allFiles),
      keyFiles: intelligentAnalysis.keyFiles,
      dependencies,
      framework,
      packageManager,
        projectRoot,
      projectType: intelligentAnalysis.projectType,
      backendFiles: intelligentAnalysis.backendFiles,
      frontendFiles: intelligentAnalysis.frontendFiles,
      primaryLanguages: intelligentAnalysis.primaryLanguages,
      analysisNotes: intelligentAnalysis.analysisNotes,
    };

    console.log('[AGENT] Intelligent analysis completed:', {
      projectType: analysis.projectType,
      primaryLanguages: analysis.primaryLanguages,
      backendFiles: analysis.backendFiles?.length || 0,
      frontendFiles: analysis.frontendFiles?.length || 0,
    });

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
    
    const isBackendFocused = prompt.toLowerCase().includes('backend') || 
                           prompt.toLowerCase().includes('server') ||
                           prompt.toLowerCase().includes('api') ||
                           prompt.toLowerCase().includes('database');

    const isFrontendFocused = prompt.toLowerCase().includes('frontend') || 
                             prompt.toLowerCase().includes('ui') ||
                             prompt.toLowerCase().includes('client') ||
                             prompt.toLowerCase().includes('react') ||
                             prompt.toLowerCase().includes('vue');

    const focusHint = isBackendFocused ? '🎯 BACKEND-FOCUSED REQUEST: Prioritize server-side files and logic' : 
                     isFrontendFocused ? '🎯 FRONTEND-FOCUSED REQUEST: Prioritize client-side files and UI' : '';

    const planningPrompt = `You are an AI coding assistant. Analyze the repository and create an implementation plan.

Repository Context:
- Total files: ${analysis.totalFiles}
- Project type: ${analysis.projectType || 'Unknown'}
- Primary languages: ${analysis.primaryLanguages?.join(', ') || 'Unknown'}
- Backend files: ${analysis.backendFiles || 0}
- Frontend files: ${analysis.frontendFiles || 0}

${focusHint}

Task: ${prompt}

CRITICAL: You MUST respond with ONLY a JSON object in this exact format:
\`\`\`json
{
  "approach": "Brief description of your approach",
  "filesToModify": ["Backend/app.py", "other/file.js"],
  "newFiles": ["new/file.py"],
  "estimatedComplexity": "low"
}
\`\`\`

Do NOT include any other text, markdown, or explanations outside the JSON block.
Do NOT use nested objects like "implementation_plan" or "backend"/"frontend" - use flat structure only.`

    try {
      const planResult = await this.openai.executeWithTools(
        planningPrompt,
        `Task: ${prompt}`,
        ['list_files', 'read_file'],
        this.sandbox
      );

      const aiResult = planResult.content || '';
      console.log('[AGENT] AI planning result:', aiResult.slice(0, 500));

      const jsonMatch = aiResult.match(/```json\s*([\s\S]+?)\s*```/) || aiResult.match(/\{[\s\S]*\}/);
      if (!jsonMatch || jsonMatch.length < 1) {
        console.error('[AGENT] AI response did not contain valid JSON. Raw response:', aiResult);
        throw new Error('AI failed to return a valid implementation plan in JSON format.');
      }

      const planJson = jsonMatch[0].replace(/```json|```/g, '').trim();
      let aiPlan: any;
      
      try {
        const parsedJson = JSON.parse(planJson);
        aiPlan = parsedJson.implementation_plan || parsedJson;
        
        console.log('[AGENT] Parsed plan structure:', JSON.stringify(aiPlan, null, 2).slice(0, 500));
        
        if (aiPlan.steps && Array.isArray(aiPlan.steps) && (!aiPlan.filesToModify || aiPlan.filesToModify.length === 0)) {
          aiPlan.filesToModify = [];
          aiPlan.steps.forEach((step: any) => {
            if (step.details?.file) aiPlan.filesToModify.push(step.details.file);
            if (step.file) aiPlan.filesToModify.push(step.file);
            if (step.actions) {
              step.actions.forEach((action: any) => {
                if (action.file) aiPlan.filesToModify.push(action.file);
              });
            }
          });
          console.log('[AGENT] Extracted files from steps:', aiPlan.filesToModify);
        }

        if (!aiPlan.filesToModify || aiPlan.filesToModify.length === 0) {
          if (isBackendFocused && analysis.backendFiles && analysis.backendFiles.length > 0) {
            aiPlan.filesToModify = analysis.backendFiles.slice(0, 3);
            console.log('[AGENT] Using backend files as fallback:', aiPlan.filesToModify);
          } else if (isFrontendFocused && analysis.frontendFiles && analysis.frontendFiles.length > 0) {
            aiPlan.filesToModify = analysis.frontendFiles.slice(0, 3);
            console.log('[AGENT] Using frontend files as fallback:', aiPlan.filesToModify);
          }
        }
        
      } catch (error) {
        console.error('[AGENT] Failed to parse plan JSON:', error);
        throw new Error('Failed to parse the AI-generated implementation plan.');
      }

      if (!aiPlan.filesToModify || (aiPlan.filesToModify.length === 0 && (!aiPlan.newFiles || aiPlan.newFiles.length === 0))) {
        console.error('[AGENT] AI returned an empty or invalid plan:', aiPlan);
        throw new Error('AI planner returned an empty plan. There are no files to modify or create.');
      }

      const plan: ImplementationPlan = {
        approach: aiPlan.approach || 'Implement requested changes',
        filesToModify: aiPlan.filesToModify || [],
        newFiles: aiPlan.newFiles || [],
        steps: [],
        considerations: [],
        estimatedComplexity: aiPlan.estimatedComplexity || 'medium',
        technologies: analysis.primaryLanguages || []
      };

      console.log('[AGENT] Generated plan:', {
        filesToModify: plan.filesToModify,
        newFiles: plan.newFiles,
        approach: plan.approach
      });

      yield { type: 'plan', message: 'Implementation plan created.', timestamp: new Date().toISOString() }
      return plan;

    } catch (error) {
      console.error('[AGENT] Planning failed:', error);
      yield { type: 'plan', message: 'Created fallback plan due to planning error.', timestamp: new Date().toISOString() }
      
      const plan: ImplementationPlan = {
        approach: `Implement: ${prompt}`,
        filesToModify: [],
        newFiles: [],
        steps: [],
        considerations: [],
        estimatedComplexity: 'medium',
        technologies: analysis.primaryLanguages || []
      };
      
      if (isBackendFocused && analysis.backendFiles && analysis.backendFiles.length > 0) {
        plan.filesToModify = analysis.backendFiles.slice(0, 3);
        console.log('[AGENT] Created fallback plan with backend files:', plan.filesToModify);
      } else if (isFrontendFocused && analysis.frontendFiles && analysis.frontendFiles.length > 0) {
        plan.filesToModify = analysis.frontendFiles.slice(0, 3);
        console.log('[AGENT] Created fallback plan with frontend files:', plan.filesToModify);
      } else {
        plan.filesToModify = analysis.keyFiles?.slice(0, 3) || [];
      }
      
      return plan;
    }
  }

  private async *implementPlan(
    plan: ImplementationPlan, 
    prompt: string,
    repoDir: string,
    projectRoot?: string
  ): AsyncGenerator<StreamEvent> {
    yield { type: 'implement', message: 'Starting implementation...', timestamp: new Date().toISOString() }
    
    console.log('[AGENT] Implementing plan:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles })

    try {
      yield* this.implementWithTools(plan, prompt)
      
      yield { type: 'implement', message: 'Implementation plan execution completed', timestamp: new Date().toISOString() }
      console.log('[AGENT] Implementation completed')
    } catch (error: any) {
      console.error('[AGENT] Implementation failed:', error)
      yield { type: 'error', message: `Implementation failed: ${error.message}`, timestamp: new Date().toISOString() }
      throw error
    }
  }

  private async *implementWithTools(plan: ImplementationPlan, prompt: string): AsyncGenerator<StreamEvent> {
    yield { type: 'implement', message: 'Starting autonomous implementation with direct tool access...', timestamp: new Date().toISOString() }
    yield { type: 'implement', message: 'Executing autonomous implementation...', timestamp: new Date().toISOString() }
    
    const systemPrompt = `You are an AI coding assistant with access to a sandbox environment. 
You are currently in a Git repository that has been cloned to the current directory.
The repository is on branch 'codepilot/${Date.now()}' and you need to implement changes based on the user's request.

You have access to these tools: list_files, read_file, write_file, git_add, git_status, git_commit

**Plan:**
-   **Approach:** ${plan.approach}
-   **Files to Modify:** ${plan.filesToModify.join(', ')}

**Workflow Rules:**
1.  **Analyze:** Use \`list_files\` and \`read_file\` to understand the current state of the code you need to modify. You can read each file only once.
2.  **Implement:** Use \`write_file\` to apply the changes to a file.
3.  **Verify & Commit:** After writing, use \`git_add\` to stage your changes, then \`git_commit\` with a descriptive message to save your work. You must commit after each logical change.

**CRITICAL INSTRUCTIONS for the \`write_file\` tool:**
-   The \`write_file\` tool will completely overwrite the target file. 
-   You **MUST** provide the **ENTIRE, UNMODIFIED ORIGINAL FILE CONTENT**, with your new code or changes seamlessly integrated.
-   Any part of the original code you do not include will be **PERMANENTLY DELETED**.
-   For a task like "add comments" or "add a function", your primary goal is to preserve all existing code and logic perfectly, while only adding the requested new content.
-   Review your generated content for \`write_file\` before calling the tool to ensure you have not accidentally removed any part of the original file. This is the most common and most serious error.

**IMPORTANT:**
-   **Adhere strictly to the plan.** Do not modify files not listed in the plan.
-   **Be efficient.** Do not use more tool calls than necessary. A typical flow is: read -> write -> add -> commit.

Start by listing files to understand the structure, then read and modify the relevant files.`

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

  private validateGeneratedCode(code: string, filePath: string): { isValid: boolean; issues: string[] } {
    console.log('[AGENT] Validating generated code for:', filePath)
    
    const issues: string[] = []
    
    if (code.includes('```')) {
      issues.push('Contains markdown code blocks')
    }
    
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
      /^<\w+/, 
      /^\/\*/, 
      /^\.[a-zA-Z]/, 
      /^#[a-zA-Z]/, 
      /^\w+\s*{/ 
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

    const validation = this.validateGeneratedCode(generatedCode, filePath)
    
    if (!validation.isValid && retryCount < MAX_RETRIES) {
      console.log(`[AGENT] Generated code is invalid (attempt ${retryCount + 1}/${MAX_RETRIES + 1}). Issues:`, validation.issues)
      console.log('[AGENT] Retrying with more specific instructions...')
      
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
      let actualBaseBranch = baseBranch
      
      try {
        const repoInfo = await githubAPI.getRepository(owner, repo)
        if (repoInfo && repoInfo.defaultBranch) {
          actualBaseBranch = repoInfo.defaultBranch
          console.log(`[AGENT] Using repository's default branch: ${actualBaseBranch}`)
        }
      } catch (error) {
        console.warn(`[AGENT] Could not get repository info, using provided base branch: ${baseBranch}`)
      }
      
      const prResult = await createPullRequestFromRepo(
        repoUrl,
        title,
        body,
        branchName,
        actualBaseBranch
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

  private async runTool<T extends ToolName>(
    toolName: T, 
    params: ToolParameters[T],
    successMessage?: string
  ): Promise<ToolResult> {
    const startTime = Date.now()
    
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
      
      const debugEvent: StreamEvent = {
        type: 'debug',
        message: `Tool ${toolName} completed in ${Date.now() - startTime}ms`,
        timestamp: new Date().toISOString()
      }
      
      return result
    } catch (error: any) {
      console.error(`[AGENT] Tool ${toolName} failed:`, error)
      
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