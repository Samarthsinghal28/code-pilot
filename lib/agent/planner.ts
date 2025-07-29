// lib/agent/Planner.ts
import { McpAgent } from "@/lib/mcp-agent";
import { ImplementationPlan, RepositoryAnalysis, FileInfo, StreamEvent } from "@/types";
import { OpenAIClient } from "../llm/openai";

export class Planner {
  private agent: McpAgent;
  private openai: OpenAIClient;

  constructor(agent: McpAgent) {
    this.agent = agent;
    this.openai = agent.openai;
  }

  public async *createPlan(prompt: string, analysis: RepositoryAnalysis, allFiles: FileInfo[]): AsyncGenerator<StreamEvent, ImplementationPlan> {
    yield { type: 'plan', message: 'Creating implementation plan...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Creating plan for prompt:', prompt)

    const context = `Repository Analysis:
- Total files: ${analysis.totalFiles}
- Key files: ${analysis.keyFiles.join(', ') || 'None found'}
Return ONLY the JSON object with your implementation plan.`

    const { code: planJson } = await this.openai.generateCode(
      `Create a JSON implementation plan with fields: approach (string), filesToModify (array of strings), newFiles (array of objects with path and content).`,
      context
    )

    try {
      const plan: ImplementationPlan = JSON.parse(planJson)
      // ...
      return plan
    } catch (error) {
      // ...
    }
  }
}
