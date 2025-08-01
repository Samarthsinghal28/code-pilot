"use client"

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Editor from '@monaco-editor/react'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { FileText, Folder, FolderOpen, Save } from 'lucide-react'

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

const FileTree = ({ node, onFileSelect }: { node: FileTreeNode, onFileSelect: (path: string) => void }) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleToggle = () => {
    if (node.type === 'directory') {
      setIsOpen(!isOpen);
    } else {
      onFileSelect(node.path);
    }
  };

  return (
    <div className="pl-4">
      <div onClick={handleToggle} className="flex items-center cursor-pointer hover:bg-gray-800 p-1 rounded">
        {node.type === 'directory' ? (
          isOpen ? <FolderOpen className="w-4 h-4 mr-2" /> : <Folder className="w-4 h-4 mr-2" />
        ) : (
          <FileText className="w-4 h-4 mr-2" />
        )}
        <span>{node.name}</span>
      </div>
      {isOpen && node.children && (
        <div>
          {node.children.map(child => (
            <FileTree key={child.path} node={child} onFileSelect={onFileSelect} />
          ))}
        </div>
      )}
    </div>
  );
};

export default function IdePage() {
  const searchParams = useSearchParams()
  const sessionId = searchParams.get('sessionId')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fileTree, setFileTree] = useState<FileTreeNode[] | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!sessionId) {
      setError('No session ID provided')
      setLoading(false)
      return
    }

    const fetchFiles = async () => {
      try {
        const response = await fetch(`/api/ide?sessionId=${sessionId}&action=listFiles`);
        if (!response.ok) {
          throw new Error('Failed to fetch file tree');
        }
        const data = await response.json();
        setFileTree(data.files);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchFiles();
  }, [sessionId])

  const handleFileSelect = async (path: string) => {
    setSelectedFile(path);
    try {
      const response = await fetch(`/api/ide?sessionId=${sessionId}&action=readFile&filePath=${path}`);
      if (!response.ok) {
        throw new Error('Failed to read file');
      }
      const data = await response.json();
      setFileContent(data.content);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setIsSaving(true);
    try {
      await fetch(`/api/ide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          action: 'saveFile',
          filePath: selectedFile,
          content: fileContent,
        }),
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-full mx-auto">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Code IDE</h1>
          {selectedFile && (
            <Button onClick={handleSave} disabled={isSaving}>
              <Save className="w-4 h-4 mr-2" />
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          )}
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
        ) : (
          <ResizablePanelGroup direction="horizontal" className="min-h-[80vh] rounded-lg border">
            <ResizablePanel defaultSize={25}>
              <div className="h-full p-2 overflow-auto">
                {fileTree ? fileTree.map(node => (
                  <FileTree key={node.path} node={node} onFileSelect={handleFileSelect} />
                )) : (
                  <div className="flex h-full items-center justify-center">
                    <span className="font-semibold">File Explorer</span>
                  </div>
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={75}>
              <Editor
                height="80vh"
                language="typescript"
                theme="vs-dark"
                value={fileContent}
                onChange={(value) => setFileContent(value || '')}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
        
        <div className="mt-4 text-sm text-gray-400">
          <p>Session ID: {sessionId || 'Not provided'}</p>
        </div>
      </div>
    </div>
  )
} 