import { NextRequest, NextResponse } from 'next/server';
import { SandboxManager } from '@/lib/sandbox-manager';
import { E2BSandbox } from '@/lib/e2b-sandbox';
import { ToolResult, FileInfo as AppFileInfo } from '@/types';

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

async function listFilesRecursive(sandbox: E2BSandbox, path: string): Promise<FileTreeNode[]> {
  const result: ToolResult<{ files: AppFileInfo[] }> = await sandbox.callTool('list_files', { path, recursive: true });

  if (!result.success || !result.data || !result.data.files) {
    // Return an empty array if there are no files, but don't throw an error
    return [];
  }

  const files = result.data.files;
  const tree: FileTreeNode[] = [];
  const map: { [key: string]: FileTreeNode } = {};

  files.forEach(file => {
    const parts = file.path.split('/');
    parts.reduce((currentPath, part, index) => {
      const newPath = currentPath ? `${currentPath}/${part}` : part;
      if (!map[newPath]) {
        const isDir = index < parts.length - 1;
        map[newPath] = {
          name: part,
          path: newPath,
          type: isDir ? 'directory' : 'file',
          children: isDir ? [] : undefined,
        };

        if (currentPath) {
          map[currentPath].children?.push(map[newPath]);
        } else {
          tree.push(map[newPath]);
        }
      }
      return newPath;
    }, '');
  });

  return tree;
}

export async function POST(request: NextRequest) {
    const { sessionId, action, filePath, content } = await request.json();

  if (!sessionId || !action) {
    return NextResponse.json({ error: 'Session ID and action are required' }, { status: 400 });
  }

  try {
    const sandbox = await SandboxManager.getInstance().getSandbox(sessionId);

    if (action === 'saveFile') {
      if (!filePath || content === undefined) {
        return NextResponse.json({ error: 'File path and content are required' }, { status: 400 });
      }
      const result = await sandbox.callTool('write_file', { path: filePath, content });
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const sessionId = searchParams.get('sessionId')
  const action = searchParams.get('action')
  const filePath = searchParams.get('filePath')

  if (!sessionId) {
    return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
  }

  try {
    const sandbox = await SandboxManager.getInstance().getSandbox(sessionId);

    if (action === 'listFiles') {
      const files = await listFilesRecursive(sandbox, '.');
      return NextResponse.json({ files });
    }

    if (action === 'readFile') {
      if (!filePath) {
        return NextResponse.json({ error: 'File path is required' }, { status: 400 });
      }
      const result = await sandbox.callTool('read_file', { path: filePath });
      if (!result.success || !result.data) {
        return NextResponse.json({ error: result.error || 'No content returned' }, { status: 500 });
      }
      return NextResponse.json({ content: result.data.content });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
} 