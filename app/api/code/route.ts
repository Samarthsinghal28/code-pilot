import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { McpAgent } from '@/lib/mcp-agent'
import { validateRequiredConfig, getExecutionLimits } from '@/lib/config/env'
import { StreamEvent } from '@/types'
import { CodePilotError, ValidationError } from '@/lib/errors'
import pLimit from 'p-limit'
import { wrapAgent } from '@/lib/langsmith/tracer'
import { registerAgentForSession } from '@/app/api/publish/route'

const limit = pLimit(getExecutionLimits().maxConcurrentOperations);

const CodeRequestSchema = z.object({
  repoUrl: z.string().url(),
  prompt: z.string().min(10),
  verificationMode: z.boolean().optional().default(false)
})

export async function POST(request: NextRequest) {
  try {
    console.log('[API] Starting POST request to /api/code')
    validateRequiredConfig()
    console.log('[API] Configuration validated')

    const json = await request.json()
    console.log('[API] Request body received:', { repoUrl: json.repoUrl, promptLength: json.prompt?.length })
    
    const validation = CodeRequestSchema.safeParse(json)
    if (!validation.success) {
      console.error('[API] Validation failed:', validation.error.format())
      throw new ValidationError('Invalid request body', validation.error.format())
    }
    console.log('[API] Request validated successfully')

    const { repoUrl, prompt, verificationMode } = validation.data
    console.log('[API] Creating agent with:', { repoUrl, prompt: prompt.slice(0, 100), verificationMode })

    const agent = new McpAgent(repoUrl, prompt, verificationMode)
    console.log('[API] Agent created, wrapping with LangSmith tracer')
    
    const stream = await wrapAgent(agent)
    console.log('[API] Agent wrapped, creating readable stream')

    const readableStream = new ReadableStream({
      async start(controller) {
        console.log('[API] Starting stream processing')
        try {
          for await (const event of stream) {
            console.log('[API] Streaming event:', event.type, event.message.slice(0, 100))
            
            // If we get a pause_for_verification event, register the agent for later use
            if (event.type === 'pause_for_verification' && verificationMode) {
              const sessionId = event.data?.sessionId
              if (sessionId) {
                console.log(`[API_CODE_ROUTE] Registering agent for verification session: ${sessionId}`)
                registerAgentForSession(sessionId, agent)
              }
            }
            
            controller.enqueue(`data: ${JSON.stringify(event)}\n\n`)
            
            // If verification mode and we get pause, don't close the stream yet
            if (event.type === 'pause_for_verification') {
              console.log('[API] Pausing stream for verification...')
              // Keep the stream open for the verification UI
              return
            }
            
            if (event.type === 'complete' || event.type === 'error') {
              break
            }
          }
          console.log('[API] Stream completed successfully')
        } catch (streamError) {
          console.error('[API] Stream error:', streamError)
          controller.error(streamError)
        } finally {
          console.log('[API] Closing stream')
          controller.close()
        }
      },
    })

    console.log('[API] Returning streaming response')
    return new Response(readableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error: any) {
    console.error('[API] Error in POST handler:', error)
    if (error instanceof CodePilotError) {
      return NextResponse.json({ error: error.message, details: error.details }, { status: error.statusCode })
    }
    return NextResponse.json({ error: 'An unexpected error occurred' }, { status: 500 })
  }
}

// Handle CORS preflight requests
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

// Health check endpoint
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'code-pilot-api',
    version: '1.0.0'
  })
} 