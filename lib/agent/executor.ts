// lib/agent/Executor.ts
import { McpAgent } from "@/lib/mcp-agent";
import { ImplementationPlan, StreamEvent, ToolResult } from "@/types";

export class Executor {
  private agent: McpAgent;

  constructor(agent: McpAgent) {
    this.agent = agent;
  }

  public async *execute(plan: ImplementationPlan, prompt: string, repoDir: string, projectRoot?: string): AsyncGenerator<StreamEvent, void> {
    yield { type: 'implement', message: 'Starting implementation...', timestamp: new Date().toISOString() }
    console.log('[AGENT] Implementing plan:', { filesToModify: plan.filesToModify, newFiles: plan.newFiles })

    const path = await import('path')

    for (const filePath of plan.filesToModify) {
      const fullPath = projectRoot && !filePath.startsWith(projectRoot) 
        ? path.default.join(repoDir, projectRoot, filePath) 
        : path.default.join(repoDir, filePath)
        
      console.log(`[AGENT] Processing file with full path: ${fullPath}`)
      const existingContent = await this.agent.readFile(fullPath)
      yield* this.modifyFile(fullPath, existingContent, prompt)
    }

    for (const file of plan.newFiles) {
      const fullPath = projectRoot && !file.path.startsWith(projectRoot)
        ? path.default.join(repoDir, projectRoot, file.path)
        : path.default.join(repoDir, file.path)
        
      console.log(`[AGENT] Creating new file with full path: ${fullPath}`)
      yield* this.modifyFile(fullPath, file.content, prompt)
    }

    console.log('[AGENT] Implementation plan execution completed')
  }

  private async *modifyFile(filePath: string, existingContent: string, description: string, retryCount: number = 0): AsyncGenerator<StreamEvent, ToolResult> {
    // ... (logic from modifyFile in mcp-agent.ts)
  }
}
