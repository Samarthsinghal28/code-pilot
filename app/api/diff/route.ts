import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { DiffInfo, FileDiff } from '@/types'
import { hasActiveAgent } from '@/app/api/publish/route'

const DiffRequestSchema = z.object({
  sessionId: z.string()
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')

    console.log(`[DIFF_API] Received GET request for session: ${sessionId}`);

    if (!sessionId) {
      console.log('[DIFF_API] No session ID provided');
      return NextResponse.json(
        { error: 'Session ID required' },
        { status: 400 }
      )
    }

    // Get the agent instance from the publish API
    const { getAgentForSession } = await import('@/app/api/publish/route')
    const agent = getAgentForSession(sessionId)

    if (!agent) {
      console.log(`[DIFF_API] No active agent found for session: ${sessionId}`);
      return NextResponse.json(
        { error: 'No active agent found for session' },
        { status: 404 }
      )
    }

    // Get the verification session
    const verificationSession = await agent.getVerificationSession()
    if (!verificationSession || !verificationSession.isActive) {
      console.log(`[DIFF_API] No active verification session for: ${sessionId}`);
      return NextResponse.json(
        { error: 'No verification session found' },
        { status: 404 }
      )
    }

    // Get the diff information
    const diffText = await agent.getDiff()
    console.log(`[DIFF_API] Raw diff text for session ${sessionId}:\n---\n${diffText}\n---`);
    
    // Parse the diff text into structured format
    const diffInfo = parseDiffOutput(diffText, verificationSession.workDir)
    console.log(`[DIFF_API] Parsed diff info for session ${sessionId}:`, JSON.stringify(diffInfo, null, 2));

    return NextResponse.json({
      success: true,
      diff: diffInfo,
      sessionInfo: {
        sessionId,
        branchName: verificationSession.branchName || 'unknown',
        filesChanged: diffInfo.files.map(f => f.path)
      }
    })
  } catch (error: any) {
    console.error('[DIFF API] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error.message },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const validation = DiffRequestSchema.safeParse(body)
    
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: validation.error.format() },
        { status: 400 }
      )
    }

    const { sessionId } = validation.data
    
    // Get the agent instance from the publish API
    const { getAgentForSession } = await import('@/app/api/publish/route')
    const agent = getAgentForSession(sessionId)

    if (!agent) {
      return NextResponse.json(
        { error: 'No active agent found for session' },
        { status: 404 }
      )
    }

    // Get the verification session
    const verificationSession = await agent.getVerificationSession()
    if (!verificationSession || !verificationSession.isActive) {
      return NextResponse.json(
        { error: 'No verification session found' },
        { status: 404 }
      )
    }

    // Get the diff information
    const diffText = await agent.getDiff()
    
    // Parse the diff text into structured format
    const diffInfo = parseDiffOutput(diffText, verificationSession.workDir)

    return NextResponse.json({
      success: true,
      diff: diffInfo,
      sessionInfo: {
        sessionId,
        branchName: verificationSession.branchName || 'unknown',
        filesChanged: diffInfo.files.map(f => f.path)
      }
    })
  } catch (error: any) {
    console.error('[DIFF API] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error', details: error.message },
      { status: 500 }
    )
  }
}

/**
 * Parse git diff output into structured format
 */
function parseDiffOutput(diffText: string, repoPath: string): DiffInfo {
  const files: FileDiff[] = []
  let addedCount = 0
  let modifiedCount = 0
  let deletedCount = 0

  // If the diff is empty, return empty result
  if (!diffText || diffText.trim() === 'No changes detected') {
    return {
      files,
      summary: {
        added: addedCount,
        modified: modifiedCount,
        deleted: deletedCount
      }
    }
  }

  // Check if this is a git status output instead of a diff
  if (diffText.includes('On branch') && !diffText.includes('diff --git')) {
    // Try to parse git status output
    const changedFiles = diffText.match(/modified:\s+([^\n]+)/g) || []
    
    changedFiles.forEach(match => {
      const filePath = match.replace('modified:', '').trim()
      files.push({
        path: filePath,
        status: 'modified',
        diff: `File ${filePath} was modified`
      })
      modifiedCount++
    })

    return {
      files,
      summary: {
        added: addedCount,
        modified: modifiedCount,
        deleted: deletedCount
      }
    }
  }

  // Split the diff by file sections (each starting with "diff --git")
  const fileSections = diffText.split(/diff --git /g)
  
  // The first element might be empty or contain header info
  const sections = fileSections[0].trim() ? fileSections : fileSections.slice(1)

  for (const section of sections) {
    try {
      if (!section.trim()) continue

      // Add back the "diff --git" prefix that was removed by the split
      const fullSection = section.startsWith('diff --git') ? section : `diff --git ${section}`
      
      // Extract file path
      const pathMatch = section.match(/a\/(.*) b\/(.*)/)
      if (!pathMatch) continue

      const filePath = pathMatch[2]
      
      // Determine file status
      let status: 'added' | 'modified' | 'deleted' = 'modified'
      if (section.includes('new file mode')) {
        status = 'added'
        addedCount++
      } else if (section.includes('deleted file mode')) {
        status = 'deleted'
        deletedCount++
      } else {
        modifiedCount++
      }

      files.push({
        path: filePath,
        status,
        diff: fullSection,
      })
    } catch (error) {
      console.error('[DIFF] Error parsing file section:', error)
    }
  }

  return {
    files,
    summary: {
      added: addedCount,
      modified: modifiedCount,
      deleted: deletedCount
    }
  }
} 