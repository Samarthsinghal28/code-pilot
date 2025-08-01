import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { TerminalSessionManager } from '@/lib/terminal/session-manager'

const CreateSessionSchema = z.object({
  sessionId: z.string(),
  workingDir: z.string(),
  verificationData: z.object({
    sessionId: z.string(),
    sandboxId: z.string(),
    repoPath: z.string(),
    branchName: z.string(),
    status: z.enum(['pending', 'active', 'completed', 'expired']),
    createdAt: z.string().transform(str => new Date(str)),
    expiresAt: z.string().transform(str => new Date(str)),
    filesChanged: z.array(z.string())
  }).optional()
})

const WriteSchema = z.object({
  sessionId: z.string(),
  data: z.string()
})

const ResizeSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number()
})

const sessionManager = TerminalSessionManager.getInstance()

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const action = body.action

    switch (action) {
      case 'create': {
        const validation = CreateSessionSchema.safeParse(body)
        if (!validation.success) {
          return NextResponse.json(
            { error: 'Invalid request body', details: validation.error.format() },
            { status: 400 }
          )
        }

        const { sessionId, workingDir, verificationData } = validation.data
        const session = sessionManager.createSession(sessionId, workingDir, verificationData)

        return NextResponse.json({
          success: true,
          session
        })
      }

      case 'write': {
        const validation = WriteSchema.safeParse(body)
        if (!validation.success) {
          return NextResponse.json(
            { error: 'Invalid request body', details: validation.error.format() },
            { status: 400 }
          )
        }

        const { sessionId, data } = validation.data
        const success = sessionManager.writeToSession(sessionId, data)

        if (!success) {
          return NextResponse.json(
            { error: 'Session not found or inactive' },
            { status: 404 }
          )
        }

        return NextResponse.json({ success: true })
      }

      case 'resize': {
        const validation = ResizeSchema.safeParse(body)
        if (!validation.success) {
          return NextResponse.json(
            { error: 'Invalid request body', details: validation.error.format() },
            { status: 400 }
          )
        }

        const { sessionId, cols, rows } = validation.data
        const success = sessionManager.resizeSession(sessionId, cols, rows)

        if (!success) {
          return NextResponse.json(
            { error: 'Session not found or inactive' },
            { status: 404 }
          )
        }

        return NextResponse.json({ success: true })
      }

      case 'close': {
        const { sessionId } = body
        if (!sessionId) {
          return NextResponse.json(
            { error: 'Session ID required' },
            { status: 400 }
          )
        }

        const success = sessionManager.closeSession(sessionId)
        return NextResponse.json({ success })
      }

      case 'list': {
        const sessions = sessionManager.listSessions()
        return NextResponse.json({ sessions })
      }

      default:
        return NextResponse.json(
          { error: 'Invalid action' },
          { status: 400 }
        )
    }
  } catch (error: any) {
    console.error('[TERMINAL API] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')

    if (!sessionId) {
      // List all sessions
      const sessions = sessionManager.listSessions()
      return NextResponse.json({ sessions })
    }

    // Get specific session info
    const session = sessionManager.getSession(sessionId)
    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      )
    }

    const verificationData = sessionManager.getVerificationData(sessionId)

    return NextResponse.json({
      session: {
        sessionId: session.sessionId,
        pid: session.pid,
        status: session.status,
        workingDir: session.workingDir
      },
      verificationData
    })
  } catch (error: any) {
    console.error('[TERMINAL API] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Session ID required' },
        { status: 400 }
      )
    }

    const success = sessionManager.closeSession(sessionId)
    return NextResponse.json({ success })
  } catch (error: any) {
    console.error('[TERMINAL API] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
} 