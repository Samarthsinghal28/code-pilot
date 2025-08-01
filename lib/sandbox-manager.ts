import { E2BSandbox } from '@/lib/e2b-sandbox';

interface ActiveSandbox {
  sandbox: E2BSandbox;
  lastActivity: Date;
}

export class SandboxManager {
  private static instance: SandboxManager;
  private sandboxes = new Map<string, ActiveSandbox>();
  private readonly SANDBOX_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  private cleanupInterval: NodeJS.Timeout;

  private constructor() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSandboxes();
    }, 60 * 1000);
  }

  static getInstance(): SandboxManager {
    if (!SandboxManager.instance) {
      SandboxManager.instance = new SandboxManager();
    }
    return SandboxManager.instance;
  }

  async getSandbox(sessionId: string): Promise<E2BSandbox> {
    if (this.sandboxes.has(sessionId)) {
      const activeSandbox = this.sandboxes.get(sessionId)!;
      activeSandbox.lastActivity = new Date();
      return activeSandbox.sandbox;
    }
    return this.createSandbox(sessionId)
  }

  async createSandbox(sessionId: string): Promise<E2BSandbox> {
    if (this.sandboxes.has(sessionId)) {
      return this.sandboxes.get(sessionId)!.sandbox;
    }

    const sandbox = new E2BSandbox();
    await sandbox.initialize();
    this.sandboxes.set(sessionId, {
      sandbox,
      lastActivity: new Date(),
    });
    return sandbox;
  }

  registerSandbox(sessionId: string, sandbox: E2BSandbox): void {
    if (this.sandboxes.has(sessionId)) {
      // The sandbox is already registered
      return;
    }
    this.sandboxes.set(sessionId, {
      sandbox,
      lastActivity: new Date(),
    });
  }

  private cleanupExpiredSandboxes(): void {
    const now = new Date();
    for (const [sessionId, activeSandbox] of this.sandboxes.entries()) {
      const timeSinceLastActivity = now.getTime() - activeSandbox.lastActivity.getTime();
      if (timeSinceLastActivity > this.SANDBOX_TIMEOUT) {
        console.log(`[SANDBOX] Cleaning up expired sandbox ${sessionId}`);
        activeSandbox.sandbox.cleanup();
        this.sandboxes.delete(sessionId);
      }
    }
  }

  cleanup(): void {
    clearInterval(this.cleanupInterval);
    for (const activeSandbox of this.sandboxes.values()) {
      activeSandbox.sandbox.cleanup();
    }
    this.sandboxes.clear();
  }
} 