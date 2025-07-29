import { z } from 'zod'

const EnvSchema = z.object({
  // Server Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).pipe(z.number().positive()).optional().default('3000'),

  // API Rate Limiting
  RATE_LIMIT_MAX: z.string().transform(Number).pipe(z.number().positive()).optional().default('100'),
  RATE_LIMIT_WINDOW: z.string().transform(Number).pipe(z.number().positive()).optional().default('900000'), // 15 minutes

  // GitHub App Authentication (Optional)
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_PERSONAL_ACCESS_TOKEN: z.string().optional(),

  // LangSmith Configuration
  LANGCHAIN_TRACING_V2: z.string().optional().default('true'),
  LANGCHAIN_API_KEY: z.string().optional(),
  LANGCHAIN_PROJECT: z.string().optional().default('Code Pilot'),

  // E2B Configuration
  E2B_API_KEY: z.string().optional(),
  USE_E2B_SANDBOX: z.string().optional().default('false'),

  // LLM Configuration
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  MAX_CONTEXT_TOKENS: z.string().transform(Number).pipe(z.number().positive()).optional().default('8000'),
  LLM_MODEL: z.string().optional().default('gpt-4o'),
  LLM_TEMPERATURE: z.string().transform(Number).pipe(z.number().min(0).max(2)).optional().default('0.1'),
  LLM_COST_PER_1K_TOKENS: z
    .string()
    .transform((val) => JSON.parse(val))
    .optional()
    .default('{"gpt-4o":{"input":0.005,"output":0.015}}'),

  // Execution Limits
  COMMAND_TIMEOUT: z.string().transform(Number).pipe(z.number().positive()).optional().default('300000'), // 5 minutes
  MAX_CONCURRENT_OPERATIONS: z.string().transform(Number).pipe(z.number().positive()).optional().default('5'),
  
  // File/Repo Limits
  MAX_FILE_SIZE: z.string().transform(Number).pipe(z.number().positive()).optional().default('10485760'), // 10MB
  MAX_FILES_PER_REQUEST: z.string().transform(Number).pipe(z.number().positive()).optional().default('50'),
  MAX_REPO_SIZE: z.string().transform(Number).pipe(z.number().positive()).optional().default('104857600'), // 100MB
  CLONE_TIMEOUT: z.string().transform(Number).pipe(z.number().positive()).optional().default('300000'), // 5 minutes
})

export type EnvConfig = z.infer<typeof EnvSchema>

class ConfigManager {
  private static instance: ConfigManager
  public readonly env: EnvConfig

  private constructor() {
    this.env = this.loadConfig()
  }
  
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager()
    }
    return ConfigManager.instance
  }

  private loadConfig(): EnvConfig {
    const env = {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW: process.env.RATE_LIMIT_WINDOW,
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
      GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
      LANGCHAIN_TRACING_V2: process.env.LANGCHAIN_TRACING_V2,
      LANGCHAIN_API_KEY: process.env.LANGCHAIN_API_KEY,
      LANGCHAIN_PROJECT: process.env.LANGCHAIN_PROJECT,
      E2B_API_KEY: process.env.E2B_API_KEY,
      USE_E2B_SANDBOX: process.env.USE_E2B_SANDBOX,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      COHERE_API_KEY: process.env.COHERE_API_KEY,
      MAX_CONTEXT_TOKENS: process.env.MAX_CONTEXT_TOKENS,
      LLM_MODEL: process.env.LLM_MODEL,
      LLM_TEMPERATURE: process.env.LLM_TEMPERATURE,
      LLM_COST_PER_1K_TOKENS: process.env.LLM_COST_PER_1K_TOKENS,
      COMMAND_TIMEOUT: process.env.COMMAND_TIMEOUT,
      MAX_CONCURRENT_OPERATIONS: process.env.MAX_CONCURRENT_OPERATIONS,
      MAX_FILE_SIZE: process.env.MAX_FILE_SIZE,
      MAX_FILES_PER_REQUEST: process.env.MAX_FILES_PER_REQUEST,
      MAX_REPO_SIZE: process.env.MAX_REPO_SIZE,
      CLONE_TIMEOUT: process.env.CLONE_TIMEOUT,
    }
    return EnvSchema.parse(env)
  }
}

const config = ConfigManager.getInstance()

export function get<K extends keyof EnvConfig>(key: K): EnvConfig[K] {
  return config.env[key]
}

export function getAll(): EnvConfig {
  return config.env
}

export function getGitHubToken(): string | undefined {
  return config.env.GITHUB_PERSONAL_ACCESS_TOKEN
}

export function getLangSmithConfig() {
  return {
    tracing: config.env.LANGCHAIN_TRACING_V2,
    apiKey: config.env.LANGCHAIN_API_KEY,
    project: config.env.LANGCHAIN_PROJECT,
  }
}

export function getE2BConfig() {
  return {
    apiKey: config.env.E2B_API_KEY,
  }
}

export function getLLMConfig() {
  return {
    apiKey: config.env.OPENAI_API_KEY,
    model: config.env.LLM_MODEL,
    temperature: config.env.LLM_TEMPERATURE,
    maxTokens: config.env.MAX_CONTEXT_TOKENS,
    costPer1kTokens: config.env.LLM_COST_PER_1K_TOKENS,
  }
}

export function getExecutionLimits() {
  return {
    commandTimeout: config.env.COMMAND_TIMEOUT,
    maxConcurrentOperations: config.env.MAX_CONCURRENT_OPERATIONS,
  }
}

export function getFileLimits() {
  return {
      maxFileSize: config.env.MAX_FILE_SIZE,
      maxFilesPerRequest: config.env.MAX_FILES_PER_REQUEST,
      maxRepoSize: config.env.MAX_REPO_SIZE,
      cloneTimeout: config.env.CLONE_TIMEOUT,
  }
}

export function validateRequiredConfig() {
  const requiredKeys: (keyof EnvConfig)[] = [
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'LANGCHAIN_API_KEY',
    'E2B_API_KEY',
  ]
  const missingKeys = requiredKeys.filter(key => !config.env[key])
  if (missingKeys.length > 0) {
    throw new Error(`Missing required environment variables: ${missingKeys.join(', ')}`)
  }
}