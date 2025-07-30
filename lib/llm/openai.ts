import OpenAI from 'openai'
import { getLLMConfig } from '@/lib/config/env'
import { TokenUsage, ToolName, ToolParameters } from '@/types'

export class OpenAIClient {
  private static instance: OpenAIClient;
  private client: OpenAI | null = null;
  private isInitialized = false

  private constructor() {
    this.initialize();
  }

  private initialize(): void {
    if (this.isInitialized) return;

    const { apiKey } = getLLMConfig()
    if (apiKey) {
      try {
        this.client = new OpenAI({
          apiKey: apiKey,
          maxRetries: 3,
          timeout: 30000,
        })
        this.isInitialized = true
      } catch (error) {
        // Handle initialization error
      }
    }
  }

  public static getInstance(): OpenAIClient {
    if (!OpenAIClient.instance) {
      OpenAIClient.instance = new OpenAIClient();
    }
    return OpenAIClient.instance;
  }

  public getClient(): OpenAI | null {
    return this.client;
  }

  public isEnabled(): boolean {
    return this.isInitialized && this.client !== null
  }

  /**
   * Convert sandbox tools to OpenAI function calling format
   */
  public convertToolsToFunctions(tools: Map<string, any>): any[] {
    const functions: any[] = []
    
    for (const [name, tool] of tools) {
      functions.push({
        type: 'function',
        function: {
          name: name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      })
    }
    
    return functions
  }

  /**
   * Execute a task with direct access to sandbox tools via function calling
   * Simplified version that takes tool names and uses the sandbox directly
   */
  async executeWithTools(
    systemPrompt: string,
    userPrompt: string,
    toolNames: string[],
    sandbox?: any
  ): Promise<{ content: string; toolCalls: any[]; usage: TokenUsage }>;

  /**
   * Execute a task with direct access to sandbox tools via function calling
   * Full version with custom tool definitions and executor
   */
  async executeWithTools(
    instruction: string, 
    context: string, 
    availableTools: any[],
    toolExecutor: (toolName: string, params: any) => Promise<any>,
    budget?: { tokensRemaining: number; secondsRemaining: number }
  ): Promise<{ result: string; toolCalls: any[]; usage: TokenUsage }>;

  /**
   * Implementation of executeWithTools that handles both overloads
   */
  async executeWithTools(
    instructionOrSystem: string,
    contextOrUser: string,
    toolsOrNames: any[] | string[],
    executorOrSandbox?: ((toolName: string, params: any) => Promise<any>) | any,
    budget?: { tokensRemaining: number; secondsRemaining: number }
  ): Promise<{ result?: string; content?: string; toolCalls: any[]; usage: TokenUsage }> {
    console.log('[OPENAI] Starting tool-enabled execution...')
    
    // Handle simplified overload
    if (Array.isArray(toolsOrNames) && toolsOrNames.length > 0 && typeof toolsOrNames[0] === 'string') {
      const toolNames = toolsOrNames as string[];
      const sandbox = executorOrSandbox;
      
      console.log('[OPENAI] Using simplified tool names interface')
      console.log('[OPENAI] Available tools:', toolNames)
      
      // Convert tool names to function definitions
      const availableTools: any[] = [];
      for (const name of toolNames) {
        try {
          const schema = sandbox?.getToolSchema(name);
          if (schema) {
            availableTools.push({
              type: 'function',
              function: {
                name,
                description: schema.description || `Execute ${name} tool`,
                parameters: schema
              }
            });
          }
        } catch (error) {
          console.error(`[OPENAI] Error getting schema for tool ${name}:`, error);
        }
      }
      
      // Create tool executor that calls sandbox tools
      const toolExecutor = async (toolName: string, params: any) => {
        console.log(`[OPENAI] Executing tool: ${toolName}`);
        const result = await sandbox.callTool(toolName, params);
        return result;
      };
      
      // Call the full version with the constructed tools and executor
      const result = await this.executeWithTools(
        contextOrUser, // User prompt becomes the instruction
        instructionOrSystem, // System prompt becomes the context
        availableTools,
        toolExecutor,
        budget
      );
      
      // Rename result to content for the simplified interface
      return {
        content: result.result,
        toolCalls: result.toolCalls,
        usage: result.usage
      };
    }
    
    // Original implementation for the full version
    const instruction = instructionOrSystem;
    const context = contextOrUser;
    const availableTools = toolsOrNames as any[];
    const toolExecutor = executorOrSandbox as (toolName: string, params: any) => Promise<any>;
    
    console.log('[OPENAI] Instruction:', instruction.slice(0, 100))
    console.log('[OPENAI] Available tools:', availableTools.map(t => t.function.name))
    console.log('[OPENAI] Budget:', budget)

    await this.initialize()
    const { model, maxTokens } = getLLMConfig()

    // Improved, concise system prompt
    const systemPrompt = `You are Code-Pilot, an autonomous coding agent.

CORE RULES:
- Use ONLY the provided tools via function calls
- Make changes incrementally and verify your work
- Stop when the task is complete or pull request is created
- Be efficient with token usage

WORKFLOW:
1. Explore repository structure (list_files)
2. Read relevant files to understand context
3. Make necessary changes (write_file)
4. Verify changes and commit (git operations)

${budget ? `BUDGET: ${budget.tokensRemaining} tokens, ${budget.secondsRemaining}s remaining` : ''}

TASK: ${instruction}`

    // Concise context with key information only
    const contextPrompt = context.length > 1000 ? 
      context.substring(0, 1000) + '...[truncated]' : 
      context

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextPrompt }
    ]

    const toolCalls: any[] = []
    let result = ''
    let totalUsage = { totalTokens: 0, promptTokens: 0, completionTokens: 0, cost: 0 }

    // Reduced rounds for efficiency, with budget awareness
    const maxRounds = budget && budget.tokensRemaining < 5000 ? 5 : 16
    
    for (let round = 0; round < maxRounds; round++) {
      console.log(`[OPENAI] Tool calling round ${round + 1}/${maxRounds}`)

      // Budget check
      if (budget && totalUsage.totalTokens > budget.tokensRemaining * 0.8) {
        console.log('[OPENAI] Approaching token budget limit, wrapping up...')
        messages.push({
          role: 'system', 
          content: 'TOKEN BUDGET LOW: Complete current task and summarize progress.'
        })
      }

      const response = await this.client!.chat.completions.create({
        model,
        messages,
        tools: availableTools,
        tool_choice: 'auto',
        temperature: 0.1,
        max_tokens: Math.min(maxTokens, budget?.tokensRemaining ? Math.floor(budget.tokensRemaining * 0.3) : maxTokens),
      })

      const usage = this.calculateUsageFromResponse(response, model)
      totalUsage.totalTokens += usage.totalTokens
      totalUsage.promptTokens += usage.promptTokens
      totalUsage.completionTokens += usage.completionTokens
      totalUsage.cost += usage.cost

      const message = response.choices[0]?.message
      if (!message) break

      messages.push(message)

      if (message.tool_calls) {
        console.log(`[OPENAI] Executing ${message.tool_calls.length} tool calls`)
        
        for (const toolCall of message.tool_calls) {
          console.log(`[OPENAI] Calling tool: ${toolCall.function.name}`)
          
          try {
            const params = JSON.parse(toolCall.function.arguments)
            const toolResult = await toolExecutor(toolCall.function.name, params)
            
            toolCalls.push({
              name: toolCall.function.name,
              params,
              result: toolResult,
              round: round + 1
            })

            // Truncate large tool results to save tokens
            const resultContent = JSON.stringify(toolResult)
            const truncatedResult = resultContent.length > 500 ? 
              resultContent.substring(0, 500) + '...[truncated]' : 
              resultContent

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: truncatedResult
            })
            
          } catch (error) {
            console.error(`[OPENAI] Tool call failed:`, error)
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ error: (error as Error).message })
            })
          }
        }
      } else {
        // No more tool calls, this is the final response
        result = message.content || ''
        break
      }

      // Budget exhaustion check
      if (budget && totalUsage.totalTokens >= budget.tokensRemaining) {
        console.log('[OPENAI] Token budget exhausted, stopping execution')
        break
      }
    }

    console.log('[OPENAI] Tool execution completed')
    console.log('[OPENAI] Total tool calls:', toolCalls.length)
    console.log('[OPENAI] Total usage:', totalUsage)

    return { result, toolCalls, usage: totalUsage }
  }

  /**
   * Cleans up generated code by removing markdown formatting and explanations
   */
  private cleanupGeneratedCode(code: string): string {
    console.log('[OPENAI] Cleaning up generated code...')
    
    let cleaned = code.trim()
    
    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[\w]*\n?/g, '')
    cleaned = cleaned.replace(/```\n?/g, '')
    
    // Remove common explanation patterns at the beginning
    const explanationPatterns = [
      /^To.*?code.*?:\s*/i,
      /^Here.*?code.*?:\s*/i,
      /^Below.*?code.*?:\s*/i,
      /^This.*?code.*?:\s*/i,
      /^In order to.*?:\s*/i,
      /^To modify.*?:\s*/i,
      /^To create.*?:\s*/i,
      /^The following.*?:\s*/i,
      /^You can.*?:\s*/i
    ]
    
    for (const pattern of explanationPatterns) {
      cleaned = cleaned.replace(pattern, '')
    }
    
    // Remove step-by-step numbered lists at the beginning
    cleaned = cleaned.replace(/^(\d+\.\s.*?\n)+/m, '')
    
    // Remove explanatory text after code (common patterns)
    const lines = cleaned.split('\n')
    let codeStarted = false
    let codeEnded = false
    const cleanedLines: string[] = []
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      
      // Skip empty lines at the beginning
      if (!codeStarted && line === '') continue
      
      // Detect code start (import, export, function, class, etc.)
      if (!codeStarted && (
        line.startsWith('import ') ||
        line.startsWith('export ') ||
        line.startsWith('function ') ||
        line.startsWith('const ') ||
        line.startsWith('let ') ||
        line.startsWith('var ') ||
        line.startsWith('class ') ||
        line.startsWith('interface ') ||
        line.startsWith('type ') ||
        line.startsWith('<') || // HTML/JSX
        line.startsWith('/* ') || // CSS
        line.startsWith('.') || // CSS classes
        line.startsWith('#') || // CSS IDs
        line.includes('{') ||
        line.includes('}')
      )) {
        codeStarted = true
      }
      
      if (codeStarted && !codeEnded) {
        // Check for explanatory text after code
        if (line.startsWith('This ') || 
            line.startsWith('The ') || 
            line.startsWith('Note:') ||
            line.startsWith('Key ') ||
            line.startsWith('###') ||
            line.startsWith('##') ||
            line.startsWith('*')) {
          codeEnded = true
          break
        }
        
        cleanedLines.push(lines[i])
      }
    }
    
    cleaned = cleanedLines.join('\n').trim()
    
    console.log('[OPENAI] Code cleanup completed. Original length:', code.length, 'Cleaned length:', cleaned.length)
    
    return cleaned
  }

  async generateCode(instruction: string, context: string, existingCode?: string): Promise<{ code: string; usage: TokenUsage }> {
    console.log('[OPENAI] Starting code generation...')
    console.log('[OPENAI] Instruction:', instruction.slice(0, 100))
    console.log('[OPENAI] Context:', context.slice(0, 100))
    console.log('[OPENAI] Existing code length:', existingCode?.length || 0)

    await this.initialize()

    const { model, maxTokens } = getLLMConfig()

    const systemPrompt = `You are a code generation assistant. Your task is to generate ONLY clean, executable code based on the given instructions.

CRITICAL REQUIREMENTS:
- Generate ONLY the actual code - no markdown, no explanations, no comments about the task
- Do NOT wrap code in \`\`\`markdown blocks\`\`\`
- Do NOT include phrases like "Here's the code" or "To modify the code"
- Do NOT include step-by-step explanations
- Generate complete, working code that can be directly written to a file
- If modifying existing code, replace it entirely with the new version
- Keep any necessary imports, exports, and proper syntax
- Focus on the core functionality requested

Example of GOOD output (just the code):
import React from 'react';
function MyComponent() {
  return <div>Hello World</div>;
}
export default MyComponent;

Example of BAD output (contains explanations):
To create a new component, here's the code:
\`\`\`javascript
import React from 'react';
// ... code
\`\`\`
This component does...`

    const userPrompt = existingCode 
      ? `${instruction}\n\nContext:\n${context}\n\nExisting code:\n${existingCode}\n\nGenerate the complete replacement code:`
      : `${instruction}\n\nContext:\n${context}\n\nGenerate the complete code:`

    const modelConfig = {
      model: model,
      temperature: 0.1,
      max_tokens: maxTokens,
    }

    console.log('[OPENAI] Using model config:', modelConfig)
    console.log('[OPENAI] Full prompt length:', systemPrompt.length + userPrompt.length)
    console.log('[OPENAI] Full prompt preview:', userPrompt.slice(0, 100))

    const response = await this.client!.chat.completions.create({
      model: modelConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: modelConfig.temperature,
      max_tokens: modelConfig.max_tokens,
    })

    console.log('[OPENAI] Response received')
    console.log('[OPENAI] Usage:', response.usage)

    const content = response.choices[0]?.message?.content || ''
    console.log('[OPENAI] Response content preview:', content.slice(0, 100))

    // Clean up the generated code
    const cleanedCode = this.cleanupGeneratedCode(content)

    const usage: TokenUsage = {
      totalTokens: response.usage?.total_tokens || 0,
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      cost: this.calculateCost(response.usage?.total_tokens || 0, response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, model)
    }

    console.log('[OPENAI] Generated code length:', cleanedCode.length)
    console.log('[OPENAI] Token usage:', usage)

    return { code: cleanedCode, usage }
  }

  public estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  public truncateContext(text: string, maxTokens: number): string {
    const tokens = this.estimateTokens(text)
    if (tokens <= maxTokens) {
      return text
    }
    const estimatedChars = maxTokens * 3;
    return text.slice(0, estimatedChars)
  }

  /**
   * Ensure prompt stays within budget, leaving headroom for response
   */
  public ensurePromptBudget(
    systemPrompt: string, 
    userPrompt: string, 
    responseTokens: number = 1000
  ): { systemPrompt: string; userPrompt: string; budgetUsed: number } {
    const { maxTokens } = getLLMConfig()
    const budget = maxTokens - responseTokens
    
    const systemTokens = this.estimateTokens(systemPrompt)
    const userTokens = this.estimateTokens(userPrompt)
    const totalTokens = systemTokens + userTokens
    
    if (totalTokens <= budget) {
      return { systemPrompt, userPrompt, budgetUsed: totalTokens }
    }
    
    console.log(`[OPENAI] Prompt budget exceeded: ${totalTokens} > ${budget}, truncating...`)
    
    // If system prompt is too long, truncate it first
    if (systemTokens > budget * 0.3) {
      systemPrompt = this.truncateContext(systemPrompt, Math.floor(budget * 0.3))
    }
    
    // Then truncate user prompt with remaining budget
    const remainingBudget = budget - this.estimateTokens(systemPrompt)
    if (this.estimateTokens(userPrompt) > remainingBudget) {
      userPrompt = this.truncateContext(userPrompt, remainingBudget)
    }
    
    const finalTokens = this.estimateTokens(systemPrompt) + this.estimateTokens(userPrompt)
    console.log(`[OPENAI] Prompt truncated to ${finalTokens} tokens`)
    
    return { systemPrompt, userPrompt, budgetUsed: finalTokens }
  }

  private calculateUsageFromResponse(response: OpenAI.Chat.Completions.ChatCompletion, model: string): TokenUsage {
    return {
      totalTokens: response.usage?.total_tokens || 0,
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      cost: this.calculateCost(response.usage?.total_tokens || 0, response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0, model)
    }
  }

  private calculateCost(totalTokens: number, promptTokens: number, completionTokens: number, model: string): number {
    if (!totalTokens) return 0

    const { costPer1kTokens } = getLLMConfig()
    const pricing = (costPer1kTokens as any)[model] || { input: 0, output: 0 }
    
    const inputCost = (promptTokens / 1000) * pricing.input
    const outputCost = (completionTokens / 1000) * pricing.output
    
    return inputCost + outputCost
  }
} 