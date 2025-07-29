import OpenAI from 'openai'
import { getLLMConfig } from '@/lib/config/env'
import { TokenUsage } from '@/types'

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

  private calculateCost(totalTokens: number, promptTokens: number, completionTokens: number, model: string): number {
    if (!totalTokens) return 0

    const { costPer1kTokens } = getLLMConfig()
    const pricing = (costPer1kTokens as any)[model] || { input: 0, output: 0 }
    
    const inputCost = (promptTokens / 1000) * pricing.input
    const outputCost = (completionTokens / 1000) * pricing.output
    
    return inputCost + outputCost
  }
} 