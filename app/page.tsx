"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Code,
  Github,
  Sparkles,
  Check,
  Clock,
  Copy,
  ExternalLink,
  ChevronRight,
  Loader2,
  Terminal,
  FileCode,
  GitPullRequest,
  Zap,
  Settings,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { StreamEvent } from "@/types"

const examplePrompts = [
  {
    category: "UI",
    title: "Add a dark mode toggle",
    description: "Implement a dark/light mode switcher with theme persistence",
    color: "border-blue-500",
  },
  {
    category: "Backend",
    title: "Add user authentication",
    description: "Implement JWT-based authentication with login/signup endpoints",
    color: "border-purple-500",
  },
  {
    category: "Feature",
    title: "Create a search functionality",
    description: "Add full-text search with filters and pagination",
    color: "border-green-500",
  },
  {
    category: "Database",
    title: "Add data validation",
    description: "Implement input validation and sanitization for all forms",
    color: "border-orange-500",
  },
]

const timelineSteps = [
    { id: 1, name: "Starting Up", type: 'start', description: "Initializing the agent and sandbox" },
    { id: 2, name: "Repository Cloning", type: 'clone', description: "Cloning repo into secure sandbox" },
    { id: 3, name: "Repository Analysis", type: 'analyze', description: "Scanning codebase and dependencies" },
    { id: 4, name: "Planning Changes", type: 'plan', description: "Determining implementation approach" },
    { id: 5, name: "Generating Code", type: 'implement', description: "Writing new code and modifications" },
    { id: 6, name: "Creating Pull Request", type: 'pr_create', description: "Preparing PR with detailed description" },
]

export default function CodePilotUI() {
  const [repoUrl, setRepoUrl] = useState("")
  const [prompt, setPrompt] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)
  const [isComplete, setIsComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prUrl, setPrUrl] = useState<string | null>(null)
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [verificationMode, setVerificationMode] = useState(false)
  const [verificationData, setVerificationData] = useState<any>(null)
  const [showVerificationUI, setShowVerificationUI] = useState(false)

  const isValidRepo = repoUrl.includes("github.com") && repoUrl.includes("/")
  const charCount = prompt.length
  const maxChars = 1000

  const handleSubmit = async () => {
    if (!isValidRepo || !prompt.trim() || isProcessing) return;

    setIsProcessing(true);
    setIsComplete(false);
    setCurrentStep(0);
    setEvents([]);
    setError(null);
    setPrUrl(null);
    setVerificationData(null);
    setShowVerificationUI(false);

    try {
      const response = await fetch('/api/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, prompt, verificationMode }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'An unknown error occurred');
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');

        while (boundary !== -1) {
          const eventStr = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          if (eventStr.startsWith('data: ')) {
            try {
              const eventData: StreamEvent = JSON.parse(eventStr.slice(6));
              setEvents(prev => [...prev, eventData]);

              const stepIndex = timelineSteps.findIndex(s => s.type === eventData.type);
              if (stepIndex !== -1) {
                setCurrentStep(stepIndex + 1);
              } else if (eventData.type === 'sandbox_create') {
                setCurrentStep(1); // Still part of the "Starting Up" phase
              }

              if (eventData.type === 'complete') {
                setIsComplete(true);
                setCurrentStep(timelineSteps.length + 1)
                if (eventData.data?.prUrl) {
                  setPrUrl(eventData.data.prUrl);
                }
                break;
              }

              if (eventData.type === 'pause_for_verification') {
                console.log('[FRONTEND] Pausing for verification:', eventData.data);
                setVerificationData(eventData.data);
                setShowVerificationUI(true);
                setIsProcessing(false); // Allow user interaction
                break;
              }

              if (eventData.type === 'error' || eventData.type === 'tool_error') {
                setError(eventData.message);
                break;
              }
              
              // Log debug events to console for development
              if (eventData.type === 'debug') {
                console.log('[FRONTEND] Debug:', eventData.message, eventData.data);
              }
            } catch (e) {
              console.error('Failed to parse SSE event:', e);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExampleClick = (example: (typeof examplePrompts)[0]) => {
    setPrompt(example.description)
  }

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-800 bg-gradient-to-r from-slate-900/90 to-purple-900/90 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-r from-blue-500 to-purple-500">
                <Code className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Code Pilot</h1>
                <p className="text-sm text-slate-400">AI-Powered Code Generation & Pull Requests</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="text-slate-400 hover:text-white">
              <Github className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Left Column - Input Form */}
          <div className="space-y-6">
            {/* Repository Input */}
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Github className="w-4 h-4 text-slate-400" />
                    <label className="text-sm font-medium text-white">Repository URL</label>
                  </div>
                  <div className="relative">
                    <Input
                      placeholder="https://github.com/username/repository"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500 pr-10"
                    />
                    {isValidRepo && (
                      <Check className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-green-500" />
                    )}
                  </div>
                  <p className="text-xs text-slate-400">Must be a public GitHub repository</p>
                </div>
              </CardContent>
            </Card>

            {/* Prompt Input */}
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-slate-400" />
                    <label className="text-sm font-medium text-white">Describe Your Changes</label>
                  </div>
                  <Textarea
                    placeholder="Describe what you want to build or modify..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500 min-h-[120px] resize-none"
                    maxLength={maxChars}
                  />
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-slate-400">Be specific about the functionality you need</p>
                    <span className={cn("text-xs", charCount > maxChars * 0.9 ? "text-orange-400" : "text-slate-400")}>
                      {charCount}/{maxChars}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Example Prompts */}
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <h3 className="text-sm font-medium text-white">Example Prompts</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {examplePrompts.map((example, index) => (
                      <Card
                        key={index}
                        className={cn(
                          "bg-slate-900/50 border-2 cursor-pointer transition-all hover:bg-slate-900/70 hover:scale-105",
                          example.color,
                        )}
                        onClick={() => handleExampleClick(example)}
                      >
                        <CardContent className="p-4">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <Badge variant="secondary" className="text-xs">
                                {example.category}
                              </Badge>
                              <ChevronRight className="w-3 h-3 text-slate-400" />
                            </div>
                            <h4 className="text-sm font-medium text-white">{example.title}</h4>
                            <p className="text-xs text-slate-400 line-clamp-2">{example.description}</p>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Verification Mode Toggle */}
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <Settings className="w-4 h-4 text-slate-400" />
                    <label className="text-sm font-medium text-white">Workflow Options</label>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="auto-publish"
                            name="workflow"
                            checked={!verificationMode}
                            onChange={() => setVerificationMode(false)}
                            className="w-4 h-4 text-blue-500 bg-slate-900 border-slate-600 focus:ring-blue-500"
                          />
                          <label htmlFor="auto-publish" className="text-sm text-white">Auto-publish PR</label>
                        </div>
                        <p className="text-xs text-slate-400 ml-6">Automatically create and publish pull request</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            id="verify-mode"
                            name="workflow"
                            checked={verificationMode}
                            onChange={() => setVerificationMode(true)}
                            className="w-4 h-4 text-blue-500 bg-slate-900 border-slate-600 focus:ring-blue-500"
                          />
                          <label htmlFor="verify-mode" className="text-sm text-white">Review before publishing</label>
                          <Badge variant="secondary" className="text-xs">Recommended</Badge>
                        </div>
                        <p className="text-xs text-slate-400 ml-6">Review changes in terminal before creating PR</p>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Submit Button */}
            <Button
              onClick={handleSubmit}
              disabled={!isValidRepo || !prompt.trim() || isProcessing}
              className="w-full bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white font-medium py-6 text-lg"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5 mr-2" />
                  Generate Pull Request
                </>
              )}
            </Button>
          </div>

          {/* Right Column - Processing Timeline */}
          <div className="space-y-6">
            <Card className="bg-slate-800/50 border-slate-700">
              <CardContent className="p-6">
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold text-white">Processing Timeline</h3>
                    {isProcessing && (
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Clock className="w-4 h-4" />
                        Step {currentStep > 0 ? currentStep : 1}/{timelineSteps.length}
                      </div>
                    )}
                  </div>

                  {/* Timeline */}
                  <div className="space-y-4">
                    {timelineSteps.map((step, index) => {
                      const stepNumber = index + 1
                      const isCompleted = currentStep > stepNumber
                      const isCurrent = currentStep === stepNumber
                      const isPending = currentStep < stepNumber

                      return (
                        <div key={step.id} className="flex gap-4">
                          <div className="flex flex-col items-center">
                            <div
                              className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all",
                                isCompleted && "bg-green-500 border-green-500",
                                isCurrent && "bg-blue-500 border-blue-500 animate-pulse",
                                isPending && "bg-slate-700 border-slate-600",
                              )}
                            >
                              {isCompleted ? (
                                <Check className="w-4 h-4 text-white" />
                              ) : isCurrent ? (
                                <Loader2 className="w-4 h-4 text-white animate-spin" />
                              ) : (
                                <span className="text-xs text-slate-400">{stepNumber}</span>
                              )}
                            </div>
                            {index < timelineSteps.length - 1 && (
                              <div
                                className={cn(
                                  "w-0.5 h-8 mt-2 transition-all",
                                  isCompleted ? "bg-green-500" : "bg-slate-600",
                                )}
                              />
                            )}
                          </div>
                          <div className="flex-1 pb-8">
                            <h4
                              className={cn(
                                "font-medium transition-all",
                                isCompleted ? "text-green-400" : isCurrent ? "text-blue-400" : "text-slate-400",
                              )}
                            >
                              {step.name}
                            </h4>
                            <p className="text-sm text-slate-500 mt-1">{step.description}</p>
                            {isCurrent && (
                              <div className="mt-2">
                                <div className="flex items-center gap-2 text-xs text-blue-400">
                                  <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                                  Processing...
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Terminal Output */}
                  {(isProcessing || isComplete || error) && (
                    <Card className="bg-slate-900 border-slate-700">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <Terminal className="w-4 h-4 text-green-400" />
                            <span className="text-sm font-medium text-white">Output</span>
                          </div>
                          <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white" onClick={() => handleCopy(events.map(e => e.message).join('\n'))}>
                            <Copy className="w-3 h-3" />
                          </Button>
                        </div>
                        <div className="bg-black rounded p-3 font-mono text-xs text-white max-h-40 overflow-y-auto">
                           {events.map((e, i) => (
                              <div key={i} className={cn("whitespace-pre-wrap", e.type === 'error' && 'text-red-400')}>
                                <span className="text-green-400 mr-2">$</span>{e.message}
                              </div>
                           ))}
                          {error && <div className="text-red-400"><span className="text-red-400 mr-2">$</span>{error}</div>}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Success State */}
                  {isComplete && prUrl && (
                    <Card className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border-green-500/20">
                      <CardContent className="p-6">
                        <div className="space-y-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-green-500 rounded-full flex items-center justify-center">
                              <Check className="w-5 h-5 text-white" />
                            </div>
                            <div>
                              <h4 className="font-semibold text-green-400">Pull Request Created!</h4>
                              <p className="text-sm text-slate-400">Your changes are ready for review</p>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <a href={prUrl} target="_blank" rel="noopener noreferrer" className="w-full">
                            <Button className="w-full bg-green-500 hover:bg-green-600 text-white">
                              <ExternalLink className="w-4 h-4 mr-2" />
                              View on GitHub
                            </Button>
                            </a>

                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-slate-600 text-slate-300 bg-transparent"
                                onClick={() => handleCopy(prUrl)}
                              >
                                <Copy className="w-3 h-3 mr-2" />
                                Copy PR URL
                              </Button>
                              <a href={prUrl} target="_blank" rel="noopener noreferrer">
                              <Button
                                variant="outline"
                                size="sm"
                                  className="border-slate-600 text-slate-300 bg-transparent w-full"
                              >
                                <GitPullRequest className="w-3 h-3 mr-2" />
                                View Changes
                              </Button>
                              </a>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {error && (
                     <Card className="bg-red-500/10 border-red-500/20">
                       <CardContent className="p-4">
                         <h4 className="font-semibold text-red-400">An Error Occurred</h4>
                         <p className="text-sm text-slate-400">{error}</p>
                      </CardContent>
                    </Card>
                  )}

                  {/* Verification UI */}
                  {showVerificationUI && verificationData && (
                    <Card className="bg-yellow-500/10 border-yellow-500/20">
                      <CardContent className="p-6">
                        <div className="space-y-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-yellow-500 rounded-full flex items-center justify-center">
                              <Terminal className="w-5 h-5 text-white" />
                            </div>
                            <div>
                              <h4 className="font-semibold text-yellow-400">Ready for Verification</h4>
                              <p className="text-sm text-slate-400">Review changes before publishing PR</p>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <div className="text-sm text-slate-300">
                              <p><strong>Branch:</strong> {verificationData.branchName}</p>
                              <p><strong>Files Changed:</strong> {verificationData.filesChanged.length}</p>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-yellow-500 text-yellow-400 bg-transparent hover:bg-yellow-500/10"
                                onClick={() => window.open(`/verification?sessionId=${verificationData.sessionId}`, '_blank')}
                              >
                                <Terminal className="w-3 h-3 mr-2" />
                                Open Terminal
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                className="border-blue-500 text-blue-400 bg-transparent hover:bg-blue-500/10"
                                onClick={() => window.open(`/diff?sessionId=${verificationData.sessionId}`, '_blank')}
                              >
                                <FileCode className="w-3 h-3 mr-2" />
                                View Diff
                              </Button>
                            </div>

                            <Button
                              className="w-full bg-green-500 hover:bg-green-600 text-white"
                              onClick={async () => {
                                try {
                                  setIsProcessing(true);
                                  setShowVerificationUI(false);
                                  
                                  const response = await fetch('/api/publish', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      sessionId: verificationData.sessionId,
                                      branchName: verificationData.branchName
                                    })
                                  });

                                  if (!response.ok) {
                                    throw new Error('Failed to publish PR');
                                  }

                                  // Handle SSE response
                                  const reader = response.body?.getReader();
                                  const decoder = new TextDecoder();
                                  
                                  if (reader) {
                                    while (true) {
                                      const { value, done } = await reader.read();
                                      if (done) break;
                                      
                                      const chunk = decoder.decode(value);
                                      const lines = chunk.split('\n');
                                      
                                      for (const line of lines) {
                                        if (line.startsWith('data: ')) {
                                          try {
                                            const eventData = JSON.parse(line.slice(6));
                                            setEvents(prev => [...prev, eventData]);
                                            
                                            if (eventData.type === 'complete') {
                                              setIsComplete(true);
                                              setIsProcessing(false);
                                              if (eventData.data?.prUrl) {
                                                setPrUrl(eventData.data.prUrl);
                                              }
                                            } else if (eventData.type === 'error') {
                                              setError(eventData.message);
                                              setIsProcessing(false);
                                            }
                                          } catch (e) {
                                            console.error('Failed to parse publish event:', e);
                                          }
                                        }
                                      }
                                    }
                                  }
                                } catch (error: any) {
                                  setError(error.message);
                                  setIsProcessing(false);
                                }
                              }}
                              disabled={isProcessing}
                            >
                              {isProcessing ? (
                                <>
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                  Publishing PR...
                                </>
                              ) : (
                                <>
                                  <GitPullRequest className="w-4 h-4 mr-2" />
                                  Publish PR
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-900/50 mt-16">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center justify-between text-sm text-slate-400">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4" />
              <span>Powered by AI • v1.0.0</span>
            </div>
            <div>Built with ❤️ for developers</div>
          </div>
        </div>
      </footer>
    </div>
  )
}
