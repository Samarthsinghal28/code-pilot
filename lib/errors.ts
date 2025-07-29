export class CodePilotError extends Error {
    public readonly statusCode: number;
    public readonly details?: any;
  
    constructor(message: string, statusCode: number = 500, details?: any) {
      super(message);
      this.name = 'CodePilotError';
      this.statusCode = statusCode;
      this.details = details;
      Object.setPrototypeOf(this, CodePilotError.prototype);
    }
}
  
export class ValidationError extends CodePilotError {
    constructor(message: string, details?: any) {
        super(message, 400, details);
        this.name = 'ValidationError';
    }
}
  
export class NotFoundError extends CodePilotError {
    constructor(message: string = 'Resource not found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}
  
export class UnauthorizedError extends CodePilotError {
    constructor(message: string = 'Authentication failed') {
        super(message, 401);
        this.name = 'UnauthorizedError';
    }
} 