import { NextRequest } from 'next/server'
import { WebSocketServer } from 'ws'
import { TerminalSessionManager } from '@/lib/terminal/session-manager'

const sessionManager = TerminalSessionManager.getInstance()

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')

  if (!sessionId) {
    return new Response('Session ID required', { status: 400 })
  }

  const session = sessionManager.getSession(sessionId)
  if (!session) {
    return new Response('Session not found', { status: 404 })
  }

  // For Next.js API routes, we need to handle WebSocket upgrades differently
  // This is a simplified approach - in production you might want to use a separate WebSocket server
  return new Response('WebSocket upgrade required', {
    status: 426,
    headers: {
      'Upgrade': 'websocket'
    }
  })
}

// For development, we'll create a separate WebSocket server
// This would typically be handled by your server infrastructure
export const websocketHandler = (sessionId: string) => {
  const session = sessionManager.getSession(sessionId)
  if (!session) {
    throw new Error('Session not found')
  }

  return {
    onConnection: (ws: any) => {
      console.log(`[TERMINAL WS] Client connected to session ${sessionId}`)

      // Set up data flow from terminal to client
      session.ptyProcess.on('data', (data: string) => {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(JSON.stringify({
            type: 'data',
            data: data
          }))
        }
      })

      // Set up data flow from client to terminal
      ws.on('message', (message: string) => {
        try {
          const parsed = JSON.parse(message)
          
          switch (parsed.type) {
            case 'data':
              sessionManager.writeToSession(sessionId, parsed.data)
              break
              
            case 'resize':
              sessionManager.resizeSession(sessionId, parsed.cols, parsed.rows)
              break
              
            default:
              console.warn(`[TERMINAL WS] Unknown message type: ${parsed.type}`)
          }
        } catch (error) {
          console.error('[TERMINAL WS] Error parsing message:', error)
        }
      })

      // Handle terminal exit
      session.ptyProcess.on('exit', (code: number) => {
        console.log(`[TERMINAL WS] Terminal exited with code ${code}`)
        ws.send(JSON.stringify({
          type: 'exit',
          code
        }))
        ws.close()
      })

      // Handle client disconnect
      ws.on('close', () => {
        console.log(`[TERMINAL WS] Client disconnected from session ${sessionId}`)
      })

      // Send initial connection success
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId,
        message: 'Terminal connected successfully'
      }))
    }
  }
} 