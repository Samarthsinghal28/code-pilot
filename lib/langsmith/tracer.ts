import { McpAgent } from '@/lib/mcp-agent'
import { StreamEvent } from '@/types'
import { RunTree } from 'langsmith'
import { getLangSmithConfig } from '@/lib/config/env'

export async function wrapAgent(
  agent: McpAgent
): Promise<AsyncGenerator<StreamEvent>> {
  const { project } = getLangSmithConfig()
  const runTree = new RunTree({
    name: 'Code Pilot Agent',
    run_type: 'chain',
    project_name: project,
    inputs: {
      repoUrl: (agent as any).repoUrl,
      prompt: (agent as any).prompt,
      sandboxType: 'E2B', // Add sandbox type for tracing
    },
  })

  const originalRun = agent.run.bind(agent)

  async function* tracedRun(): AsyncGenerator<StreamEvent> {
    try {
      const generator = originalRun()
      for await (const event of generator) {
        // Create more detailed child runs for different event types
        const child = await runTree.createChild({
          name: `${event.type.toUpperCase()}: ${event.message}`,
          run_type: getRunTypeForEvent(event.type),
          inputs: { 
            eventType: event.type,
            message: event.message,
            data: event.data,
            sandboxType: event.type === 'sandbox_create' ? 'E2B CodeInterpreter' : undefined
          },
        })
        
        child.end({ outputs: { event } })
        yield event
      }
      await runTree.end()
    } catch (e: any) {
      await runTree.end(e)
      throw e
    }
  }

  return tracedRun()
}

function getRunTypeForEvent(eventType: string): 'tool' | 'chain' | 'llm' {
  switch (eventType) {
    case 'clone':
    case 'implement':
    case 'pr_create':
      return 'tool'
    case 'analyze':
    case 'plan':
      return 'chain'
    default:
      return 'tool'
  }
} 