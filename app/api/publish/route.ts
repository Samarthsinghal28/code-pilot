import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { McpAgent } from '@/lib/mcp-agent';
import { StreamEvent } from '@/types';

// Use a global variable to store active agents to survive hot reloads in dev
declare global {
  var activeAgents: Map<string, McpAgent>;
}

const activeAgents = global.activeAgents || (global.activeAgents = new Map<string, McpAgent>());

const PublishRequestSchema = z.object({
  sessionId: z.string(),
  branchName: z.string().optional(),
});

async function runContinuation(
  agent: McpAgent,
  branchName: string,
  sendEvent: (event: StreamEvent) => void,
  controller: ReadableStreamDefaultController<any>
) {
  let isStreamClosed = false;

  const closeStream = () => {
    if (isStreamClosed) return;
    isStreamClosed = true;
    const sessionId = agent.getVerificationSessionId();
    if (sessionId) {
      console.log(`[PUBLISH_API] Cleaned up agent for session: ${sessionId}`);
      cleanupAgentSession(sessionId);
    }
    try {
      controller.close();
    } catch (e) {
      // Ignore errors if controller is already closed
    }
  };

  try {
    const stream = agent.continueAfterVerification(branchName);
    for await (const event of stream) {
      if (!isStreamClosed) {
        sendEvent(event);
      }
      // Stop listening after completion or critical error
      if (event.type === 'error' || event.type === 'complete') {
        break;
      }
    }
  } catch (error: any) {
    console.error('[PUBLISH API] Error during continuation:', error);
    if (!isStreamClosed) {
      sendEvent({
        type: 'error',
        message: `An unexpected error occurred during publish: ${error.message}`,
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    closeStream();
  }
}

export async function POST(req: Request) {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const sendEvent = (event: StreamEvent) => {
        if (controller.desiredSize === null || controller.desiredSize <= 0) {
          console.warn('[PUBLISH_API] Stream controller is not ready or has been closed, cannot send event:', event.type);
          return;
        }
        const eventData = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(eventData));
        } catch (e) {
          console.error('[PUBLISH_API] Failed to enqueue data, controller likely closed', e);
        }
      };

      try {
        const body = await req.json();
        const validation = PublishRequestSchema.safeParse(body);

        if (!validation.success) {
          sendEvent({ type: 'error', message: `Invalid request body: ${validation.error.message}`, timestamp: new Date().toISOString() });
          controller.close();
          return;
        }

        const { sessionId } = validation.data;
        console.log(`[PUBLISH_API] Received POST request with body:`, body);

        const agent = getAgentForSession(sessionId);

        if (!agent) {
          sendEvent({ type: 'error', message: `Agent for session ${sessionId} not found.`, timestamp: new Date().toISOString() });
          controller.close();
          return;
        }
        
        const verificationSession = await agent.getVerificationSession();
        const branchName = validation.data.branchName || verificationSession.branchName;

        if (!branchName) {
          sendEvent({ type: 'error', message: `Could not determine branch name for session ${sessionId}.`, timestamp: new Date().toISOString() });
          controller.close();
          return;
        }

        console.log(`[PUBLISH_API] Starting continuation for session: ${sessionId} on branch: ${branchName}`);
        await runContinuation(agent, branchName, sendEvent, controller);

      } catch (error: any) {
        console.error('[PUBLISH_API] Top-level error in POST handler:', error);
        sendEvent({ type: 'error', message: `An unexpected error occurred: ${error.message}`, timestamp: new Date().toISOString() });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Helper functions for session management
export function registerAgentForSession(sessionId: string, agent: McpAgent) {
  console.log(`[AGENT_SESSION] Registering agent for session: ${sessionId}`);
  activeAgents.set(sessionId, agent);

  setTimeout(() => {
    if (activeAgents.has(sessionId)) {
      console.log(`[AGENT_SESSION] Auto-cleaning up agent for session ${sessionId}`);
      activeAgents.delete(sessionId);
    }
  }, 10 * 60 * 1000); // 10 minute timeout
}

export function getAgentForSession(sessionId: string): McpAgent | undefined {
  console.log(`[AGENT_SESSION] Attempting to get agent for session: ${sessionId}`);
  const agent = activeAgents.get(sessionId);
  if (!agent) {
    console.log(`[AGENT_SESSION] Agent not found for session: ${sessionId}. Active sessions:`, Array.from(activeAgents.keys()));
  } else {
    console.log(`[AGENT_SESSION] Agent found for session: ${sessionId}`);
  }
  return agent;
}

export function hasActiveAgent(sessionId: string): boolean {
  return activeAgents.has(sessionId);
}

export function cleanupAgentSession(sessionId: string) {
  if (activeAgents.has(sessionId)) {
    console.log(`[AGENT_SESSION] Cleaning up agent for session ${sessionId}`);
    activeAgents.delete(sessionId);
    return true;
  }
  return false;
} 