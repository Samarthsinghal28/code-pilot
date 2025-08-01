"use client"

import { Suspense } from 'react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { DiffInfo, FileDiff } from '@/types'

function DiffPageContent() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('sessionId')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffInfo, setDiffInfo] = useState<DiffInfo | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  useEffect(() => {
    if (!sessionId) {
      setError('No session ID provided')
      setLoading(false)
      return
    }

    const fetchDiff = async () => {
      try {
        const response = await fetch(`/api/diff?sessionId=${sessionId}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch diff: ${response.statusText}`)
        }
        
        const data = await response.json()
        if (data.error) {
          throw new Error(data.error)
        }
        
        setDiffInfo(data.diff)
        if (data.diff.files.length > 0) {
          setSelectedFile(data.diff.files[0].path)
        }
      } catch (err: any) {
        setError(err.message || 'Failed to fetch diff')
      } finally {
        setLoading(false)
      }
    }

    fetchDiff()
  }, [sessionId])

  const handlePublishPR = async () => {
    if (!sessionId) return
    
    try {
      setLoading(true)
      const response = await fetch('/api/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionId
        })
      })
      
      if (!response.ok) {
        const errorData = await response.text()
        throw new Error(errorData)
      }
      
      // Redirect to the main page
      window.location.href = '/'
    } catch (err: any) {
      setError(err.message || 'Failed to publish PR')
      setLoading(false)
    }
  }

  const handleOpenTerminal = () => {
    if (!sessionId) return
    window.open(`/verification?sessionId=${sessionId}`, '_blank')
  }

  const getFileStatusColor = (status: string) => {
    switch (status) {
      case 'added':
        return 'bg-green-500'
      case 'modified':
        return 'bg-yellow-500'
      case 'deleted':
        return 'bg-red-500'
      default:
        return 'bg-gray-500'
    }
  }

  const renderDiff = (diff: string) => {
    return diff.split('\n').map((line, index) => {
      let className = 'pl-2'
      
      if (line.startsWith('+')) {
        className += ' bg-green-900/30 text-green-300'
      } else if (line.startsWith('-')) {
        className += ' bg-red-900/30 text-red-300'
      } else if (line.startsWith('@@ ')) {
        className += ' bg-blue-900/30 text-blue-300'
      }
      
      return (
        <div key={index} className={className}>
          <pre className="font-mono text-sm whitespace-pre-wrap">{line}</pre>
        </div>
      )
    })
  }

  const getCurrentFile = (): FileDiff | undefined => {
    if (!diffInfo || !selectedFile) return undefined
    return diffInfo.files.find(file => file.path === selectedFile)
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Code Changes</h1>
        </div>
        
        {error && (
          <div className="bg-red-900/50 border border-red-700 p-4 rounded mb-4">
            <p className="text-red-300">{error}</p>
          </div>
        )}
        
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
          </div>
        ) : diffInfo ? (
          <div className="grid grid-cols-4 gap-4">
            <div className="col-span-1 bg-gray-800 rounded-lg border border-gray-700 p-4">
              <h2 className="text-lg font-semibold mb-2">Changed Files</h2>
              <div className="text-sm mb-4">
                <span className="inline-block px-2 py-1 bg-green-900/30 text-green-300 rounded mr-2">
                  {diffInfo.summary.added} added
                </span>
                <span className="inline-block px-2 py-1 bg-yellow-900/30 text-yellow-300 rounded mr-2">
                  {diffInfo.summary.modified} modified
                </span>
                <span className="inline-block px-2 py-1 bg-red-900/30 text-red-300 rounded">
                  {diffInfo.summary.deleted} deleted
                </span>
              </div>
              <div className="space-y-1 max-h-[500px] overflow-y-auto">
                {diffInfo.files.map((file) => (
                  <div
                    key={file.path}
                    className={`flex items-center p-2 rounded cursor-pointer hover:bg-gray-700 ${
                      selectedFile === file.path ? 'bg-gray-700' : ''
                    }`}
                    onClick={() => setSelectedFile(file.path)}
                  >
                    <div className={`w-2 h-2 rounded-full mr-2 ${getFileStatusColor(file.status)}`}></div>
                    <span className="text-sm truncate">{file.path}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="col-span-3 bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
              {selectedFile && getCurrentFile() ? (
                <>
                  <div className="bg-gray-900 p-2 border-b border-gray-700">
                    <div className="flex items-center">
                      <div className={`w-2 h-2 rounded-full mr-2 ${getFileStatusColor(getCurrentFile()?.status || '')}`}></div>
                      <span className="font-mono text-sm">{selectedFile}</span>
                    </div>
                  </div>
                  <div className="overflow-auto max-h-[600px]">
                    {renderDiff(getCurrentFile()?.diff || '')}
                  </div>
                </>
              ) : (
                <div className="p-4 text-gray-400">
                  No file selected or no changes found.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
            <p className="text-gray-400">No diff information available.</p>
          </div>
        )}
        
        <div className="mt-4 text-sm text-gray-400">
          <p>Session ID: {sessionId || 'Not provided'}</p>
        </div>
      </div>
    </div>
  )
}

export default function DiffPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900 text-white flex justify-center items-center"><div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div></div>}>
      <DiffPageContent />
    </Suspense>
  )
} 