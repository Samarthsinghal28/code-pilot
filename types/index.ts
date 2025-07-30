// Core request/response types
export interface CodeRequest {
  repoUrl: string
  prompt: string
}

// Stream event types for real-time updates
export const EventTypes = [
  'start',
  'sandbox_create',
  'clone',
  'analyze',
  'plan',
  'implement',
  'pr_create',
  'complete',
  'error',
  'tool_error',
  'debug',
  'ping',
  'tool_call',
  'file_change',
  'progress',
  'analysis_update'
]

export type EventType = (typeof EventTypes)[number]

export interface StreamEvent {
  type: EventType
  message: string
  data?: any
  timestamp: string
  progress?: number // 0-100 for progress tracking
  details?: {
    tool?: string
    file?: string
    operation?: string
    status?: 'started' | 'completed' | 'failed'
  }
}

// Repository analysis types
export interface FileInfo {
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: Date
  extension?: string
}

export interface PackageInfo {
  name: string
  version?: string
  type: 'npm' | 'python' | 'other'
}

export interface RepositoryAnalysis {
  totalFiles: number;
  languages: Record<string, number>;
  structure: Record<string, any>;
  keyFiles: string[];
  dependencies?: PackageInfo[];
  framework?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  projectRoot?: string;
  // New intelligent analysis fields
  projectType?: string;
  primaryLanguages?: string[];
  backendFiles?: string[];
  frontendFiles?: string[];
  analysisNotes?: string;
}

// Implementation planning types
export interface PlanStep {
  id: string
  description: string
  type: 'create' | 'modify' | 'delete' | 'command'
  files: string[]
  order: number
}

export interface ImplementationPlan {
  approach: string
  filesToModify: string[]
  newFiles: string[]
  steps: PlanStep[]
  considerations: string[]
  estimatedComplexity: 'low' | 'medium' | 'high'
  technologies: string[]
}

// Code generation types
export interface CodeChange {
  file: string
  type: 'create' | 'modify' | 'delete'
  content?: string
  reason: string
}

// Git/GitHub types
export interface GitOperation {
  type: 'clone' | 'branch' | 'commit' | 'push'
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  details?: Record<string, any>
}

export interface GitHubPRResult {
  url: string
  number: number
  title: string
  body: string
  branch: string
  commits: number
}

// Tool system types
export type ToolName =
  | 'clone_repository'
  | 'read_file'
  | 'write_file'
  | 'list_files'
  | 'delete_file'
  | 'git_status'
  | 'git_add'
  | 'git_commit'
  | 'git_branch'
  | 'git_push'
  | 'git_apply_patch'
  | 'git_revert'
  | 'execute_shell'
  | 'get_package_info';

export interface ToolParameters {
  clone_repository: { url: string; destination: string; depth?: number };
  read_file: { path: string; encoding?: string };
  write_file: { path: string; content: string; encoding?: string };
  list_files: { path: string; recursive?: boolean; includeHidden?: boolean };
  delete_file: { path: string; recursive?: boolean };
  git_status: { repoPath: string };
  git_add: { files?: string[]; repoPath?: string };
  git_commit: {
    message: string
    author?: { name: string; email: string }
    repoPath?: string
  };
  git_branch: { branchName: string; fromBranch?: string; repoPath?: string };
  git_push: { branchName: string; repoPath?: string };
  git_apply_patch: { patch: string };
  git_revert: { commitHash: string };
  execute_shell: { command: string; workingDir?: string };
  get_package_info: { repoPath: string };
}

export interface ToolResult<T = any> {
  success: boolean
  data?: T
  error?: string
  stdout?: string
  stderr?: string
  toolName: ToolName
  executionTime: number
}

export interface ToolErrorEvent extends StreamEvent {
  type: 'tool_error'
  data: {
    toolName: string
    error: string
    parameters?: Record<string, any>
  }
}

export interface TokenUsage {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, any>
  execute: (params: any) => Promise<ToolResult>
}

// Sandbox types
export type SandboxResult = {
  success: boolean
  error?: string
  data?: any
}

// Error types
export interface CodePilotError extends Error {
  isOperational?: boolean
  details?: any
} 