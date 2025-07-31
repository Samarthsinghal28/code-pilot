import { spawn } from 'node-pty'
import { TerminalSession, VerificationSession } from '@/types'

interface ActiveSession extends TerminalSession {
  ptyProcess: any
  lastActivity: Date
  verificationData?: VerificationSession
}

export class TerminalSessionManager {
  private static instance: TerminalSessionManager
  private sessions = new Map<string, ActiveSession>()
  private readonly SESSION_TIMEOUT = 10 * 60 * 1000 // 10 minutes
  private cleanupInterval: NodeJS.Timeout

  private constructor() {
    // Cleanup expired sessions every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions()
    }, 60 * 1000)
  }

  static getInstance(): TerminalSessionManager {
    if (!TerminalSessionManager.instance) {
      TerminalSessionManager.instance = new TerminalSessionManager()
    }
    return TerminalSessionManager.instance
  }

  /**
   * Create a new terminal session for verification
   */
  createSession(
    sessionId: string, 
    workingDir: string, 
    verificationData?: VerificationSession
  ): TerminalSession {
    // Clean up existing session if any
    if (this.sessions.has(sessionId)) {
      this.closeSession(sessionId)
    }

    // Spawn a new shell process
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash'
    const ptyProcess = spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: workingDir,
      env: {
        ...process.env,
        // Hide sensitive environment variables
        GITHUB_TOKEN: '',
        OPENAI_API_KEY: '',
        E2B_API_KEY: '',
        HISTCONTROL: 'ignorespace' // Hide commands starting with space
      }
    })

    const session: ActiveSession = {
      sessionId,
      pid: ptyProcess.pid,
      status: 'active',
      workingDir,
      ptyProcess,
      lastActivity: new Date(),
      verificationData
    }

    this.sessions.set(sessionId, session)

    // Set up automatic cleanup
    setTimeout(() => {
      if (this.sessions.has(sessionId)) {
        console.log(`[TERMINAL] Auto-closing session ${sessionId} after timeout`)
        this.closeSession(sessionId)
      }
    }, this.SESSION_TIMEOUT)

    return {
      sessionId: session.sessionId,
      pid: session.pid,
      status: session.status,
      workingDir: session.workingDir
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): ActiveSession | undefined {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.lastActivity = new Date()
    }
    return session
  }

  /**
   * Write data to terminal session
   */
  writeToSession(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session && session.status === 'active') {
      session.ptyProcess.write(data)
      session.lastActivity = new Date()
      return true
    }
    return false
  }

  /**
   * Resize terminal session
   */
  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId)
    if (session && session.status === 'active') {
      session.ptyProcess.resize(cols, rows)
      session.lastActivity = new Date()
      return true
    }
    return false
  }

  /**
   * Close a terminal session
   */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (session) {
      try {
        session.ptyProcess.kill()
        session.status = 'closed'
      } catch (error) {
        console.error(`[TERMINAL] Error closing session ${sessionId}:`, error)
      }
      this.sessions.delete(sessionId)
      return true
    }
    return false
  }

  /**
   * List all active sessions
   */
  listSessions(): TerminalSession[] {
    return Array.from(this.sessions.values()).map(session => ({
      sessionId: session.sessionId,
      pid: session.pid,
      status: session.status,
      workingDir: session.workingDir
    }))
  }

  /**
   * Get verification data for a session
   */
  getVerificationData(sessionId: string): VerificationSession | undefined {
    const session = this.sessions.get(sessionId)
    return session?.verificationData
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date()
    for (const [sessionId, session] of this.sessions.entries()) {
      const timeSinceLastActivity = now.getTime() - session.lastActivity.getTime()
      if (timeSinceLastActivity > this.SESSION_TIMEOUT) {
        console.log(`[TERMINAL] Cleaning up expired session ${sessionId}`)
        this.closeSession(sessionId)
      }
    }
  }

  /**
   * Cleanup all sessions (for graceful shutdown)
   */
  cleanup(): void {
    clearInterval(this.cleanupInterval)
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId)
    }
  }
} 