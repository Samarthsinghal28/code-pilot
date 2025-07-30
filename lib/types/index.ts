export type EventType = 
  | 'start' 
  | 'sandbox_create' 
  | 'progress' 
  | 'analyze' 
  | 'analysis_update' 
  | 'plan' 
  | 'implement' 
  | 'tool_call' 
  | 'tool_error' 
  | 'debug' 
  | 'file_change' 
  | 'pr_create' 
  | 'pr_created' 
  | 'complete' 
  | 'error';

export interface StreamEvent {
  type: EventType
  message: string
  timestamp: string
  progress?: number
  data?: any
  details?: {
    tool?: string
    file?: string
    operation?: string
    status?: 'started' | 'completed' | 'failed'
    error?: string
  }
} 