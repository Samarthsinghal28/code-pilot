"use client"

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

export default function VerificationPage() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('sessionId')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstance = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    // Load terminal dynamically to avoid SSR issues
    import('xterm').then(({ Terminal }) => {
      import('xterm-addon-fit').then(({ FitAddon }) => {
        if (!sessionId) {
          setError('No session ID provided')
          return
        }

        if (!terminalRef.current) return

        // Initialize terminal
        const term = new Terminal({
          cursorBlink: true,
          fontSize: 14,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          theme: {
            background: '#1e1e2e',
            foreground: '#f8f8f2',
            cursor: '#f8f8f2',
            selection: 'rgba(248, 248, 242, 0.3)',
            black: '#21222c',
            red: '#ff5555',
            green: '#50fa7b',
            yellow: '#f1fa8c',
            blue: '#bd93f9',
            magenta: '#ff79c6',
            cyan: '#8be9fd',
            white: '#f8f8f2',
            brightBlack: '#6272a4',
            brightRed: '#ff6e6e',
            brightGreen: '#69ff94',
            brightYellow: '#ffffa5',
            brightBlue: '#d6acff',
            brightMagenta: '#ff92df',
            brightCyan: '#a4ffff',
            brightWhite: '#ffffff'
          }
        })
        
        const fit = new FitAddon()
        term.loadAddon(fit)
        
        terminalInstance.current = term
        fitAddon.current = fit
        
        term.open(terminalRef.current)
        fit.fit()
        
        term.writeln('\x1b[1;32mConnecting to verification session...\x1b[0m')
        
        // Create WebSocket connection
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal/ws?sessionId=${sessionId}`)
        
        ws.onopen = () => {
          term.writeln('\x1b[1;32mConnected to terminal session!\x1b[0m')
          term.writeln('\x1b[1;33mYou can now review and modify the code before creating a PR.\x1b[0m')
          term.writeln('\x1b[1;33mType "ls" to see the files in the repository.\x1b[0m')
          term.writeln('')
          setConnected(true)
          socket.current = ws
        }
        
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'data') {
              term.write(data.data)
            } else if (data.type === 'connected') {
              term.writeln(`\x1b[1;32m${data.message}\x1b[0m`)
            } else if (data.type === 'exit') {
              term.writeln(`\x1b[1;31mTerminal session exited with code ${data.code}\x1b[0m`)
              ws.close()
            }
          } catch (e) {
            console.error('Failed to parse message:', e)
            term.writeln(`\x1b[1;31mError: ${e}\x1b[0m`)
          }
        }
        
        ws.onclose = () => {
          term.writeln('\x1b[1;31mDisconnected from terminal session\x1b[0m')
          setConnected(false)
        }
        
        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          term.writeln(`\x1b[1;31mWebSocket error: ${error}\x1b[0m`)
          setError('Failed to connect to terminal session')
        }
        
        // Handle terminal input
        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', data }))
          }
        })
        
        // Handle terminal resize
        term.onResize(({ cols, rows }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }))
          }
        })
        
        // Handle window resize
        const handleResize = () => {
          if (fitAddon.current) {
            fitAddon.current.fit()
          }
        }
        
        window.addEventListener('resize', handleResize)
        
        // Initialize terminal size
        setTimeout(() => {
          if (fitAddon.current) {
            fitAddon.current.fit()
          }
        }, 100)
        
        return () => {
          window.removeEventListener('resize', handleResize)
          if (ws.readyState === WebSocket.OPEN) {
            ws.close()
          }
          term.dispose()
        }
      })
    })
  }, [sessionId])

  const handlePublishPR = async () => {
    if (!sessionId) return
    
    try {
      const response = await fetch('/api/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionId,
          // We don't need to provide branchName as the server will get it from the session
        })
      })
      
      if (!response.ok) {
        const error = await response.text()
        throw new Error(error)
      }
      
      // Redirect to the main page
      window.location.href = '/'
    } catch (error) {
      console.error('Failed to publish PR:', error)
      setError(`Failed to publish PR: ${error}`)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Terminal Verification</h1>
          <div className="flex gap-2">
            <button
              onClick={() => window.open(`/diff?sessionId=${sessionId}`, '_blank')}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white"
            >
              View Diff
            </button>
            <button
              onClick={handlePublishPR}
              disabled={!connected}
              className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded text-white"
            >
              Publish PR
            </button>
          </div>
        </div>
        
        {error && (
          <div className="bg-red-900/50 border border-red-700 p-4 rounded mb-4">
            <p className="text-red-300">{error}</p>
          </div>
        )}
        
        <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
          <div className="bg-gray-900 p-2 border-b border-gray-700 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
            </div>
            <div className="text-xs text-gray-400">
              {connected ? 'Connected' : 'Disconnected'}
            </div>
          </div>
          <div 
            ref={terminalRef} 
            className="h-[500px] w-full"
          />
        </div>
        
        <div className="mt-4 text-sm text-gray-400">
          <p>Session ID: {sessionId || 'Not provided'}</p>
          <p>Use this terminal to review and modify the code before publishing the PR.</p>
        </div>
      </div>
    </div>
  )
} 