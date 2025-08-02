import { Octokit } from '@octokit/rest'
import { getGitHubToken } from '@/lib/config/env'
import { parseGitHubUrl } from '@/lib/utils/file-ops'
import { GitHubPRResult } from '@/types'

class GitHubAPIManager {
  private octokit: Octokit | null = null
  private isInitialized = false
  private initializationAttempted = false

  constructor() {
    // Defer initialization to first use
  }

  private initialize(): boolean {
    if (this.initializationAttempted) {
      return this.isInitialized
    }
    
    this.initializationAttempted = true
    
    try {
      const token = getGitHubToken()

      if (token) {
        // Use Personal Access Token
        this.octokit = new Octokit({
          auth: token,
          userAgent: 'CodePilot/1.0.0'
        })
        console.log('Initialized GitHub API with Personal Access Token')
        this.isInitialized = true
      } else {
        console.warn('No GitHub authentication configured - PR creation will be mocked')
      }
      
      return this.isInitialized
    } catch (error) {
      console.error('Failed to initialize GitHub API:', error)
      return false
    }
  }

  public isAuthenticated(): boolean {
    return this.initialize() && this.octokit !== null
  }

  public async validateToken(): Promise<any | null> {
    if (!this.isAuthenticated()) {
      return null
    }

    try {
      const response = await this.octokit!.rest.users.getAuthenticated()
      return {
        login: response.data.login,
        id: response.data.id,
        name: response.data.name,
        email: response.data.email
      }
    } catch (error) {
      console.error('Token validation failed:', error)
      return null
    }
  }

  public async getRepository(owner: string, repo: string) {
    if (!this.isAuthenticated()) {
      throw new Error('GitHub API not authenticated')
    }

    try {
      const response = await this.octokit!.rest.repos.get({
        owner,
        repo
      })

      return {
        id: response.data.id,
        name: response.data.name,
        fullName: response.data.full_name,
        description: response.data.description,
        private: response.data.private,
        fork: response.data.fork,
        defaultBranch: response.data.default_branch,
        language: response.data.language,
        size: response.data.size,
        openIssues: response.data.open_issues_count,
        watchers: response.data.watchers_count,
        forks: response.data.forks_count,
        createdAt: response.data.created_at,
        updatedAt: response.data.updated_at,
        cloneUrl: response.data.clone_url,
        htmlUrl: response.data.html_url,
        permissions: response.data.permissions
      }
    } catch (error) {
      console.error(`Failed to get repository ${owner}/${repo}:`, error)
      throw new Error(`Failed to get repository: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  public async forkRepository(owner: string, repo: string): Promise<any> {
    if (!this.isAuthenticated()) {
      throw new Error('GitHub API not authenticated');
    }

    try {
      console.log(`Forking repository ${owner}/${repo}...`);
      const response = await this.octokit!.rest.repos.createFork({
        owner,
        repo,
      });
      console.log(`Successfully forked repository to ${response.data.full_name}`);
      
      // It can take a few seconds for the fork to be available
      // We will add a short delay and then check for availability
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify the fork is ready
      try {
        await this.getRepository(response.data.owner.login, response.data.name);
        console.log(`Fork is available at ${response.data.full_name}`);
        return response.data;
      } catch (e) {
        console.warn(`Fork not immediately available, waiting a bit longer...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
        return await this.getRepository(response.data.owner.login, response.data.name);
      }

    } catch (error) {
      console.error(`Failed to fork repository ${owner}/${repo}:`, error);
      throw new Error(`Failed to fork repository: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async createPullRequest(request: any): Promise<GitHubPRResult> {
    if (!this.isAuthenticated()) {
      // Return mock result for development
      console.warn('GitHub API not authenticated - returning mock PR result')
      return this.createMockPullRequest(request)
    }

    try {
      const { repository, title, body, head, base = 'main', draft = false } = request

      // First, verify the repository exists and we have access
      await this.getRepository(repository.owner, repository.repo)

      // Create the pull request
      const response = await this.octokit!.rest.pulls.create({
        owner: repository.owner,
        repo: repository.repo,
        title,
        body,
        head,
        base,
        draft
      })

      const prResult: GitHubPRResult = {
        url: response.data.html_url,
        number: response.data.number,
        title: response.data.title,
        body: response.data.body || '',
        branch: response.data.head.ref,
        commits: 1 // Will be updated if we can get commit count
      }

      console.log(`Successfully created PR #${prResult.number}: ${prResult.url}`)
      return prResult
    } catch (error) {
      console.error('Failed to create pull request:', error)
      throw new Error(`Failed to create pull request: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private createMockPullRequest(request: any): GitHubPRResult {
    const mockNumber = Math.floor(Math.random() * 1000) + 1
    const { repository } = request
    
    return {
      url: `https://github.com/${repository.owner}/${repository.repo}/pull/${mockNumber}`,
      number: mockNumber,
      title: request.title,
      body: request.body,
      branch: request.head,
      commits: 1
    }
  }

  public async getBranches(owner: string, repo: string) {
    if (!this.isAuthenticated()) {
      throw new Error('GitHub API not authenticated')
    }

    try {
      const response = await this.octokit!.rest.repos.listBranches({
        owner,
        repo,
        per_page: 100
      })

      return response.data.map((branch: any) => ({
        name: branch.name,
        protected: branch.protected,
        commit: {
          sha: branch.commit.sha,
          url: branch.commit.url
        }
      }))
    } catch (error) {
      console.error(`Failed to get branches for ${owner}/${repo}:`, error)
      throw new Error(`Failed to get branches: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  public async getCommits(owner: string, repo: string, branch?: string, limit: number = 10): Promise<any[]> {
    if (!this.isAuthenticated()) {
      throw new Error('GitHub API not authenticated')
    }

    try {
      const response = await this.octokit!.rest.repos.listCommits({
        owner,
        repo,
        sha: branch,
        per_page: limit
      })

      return response.data.map((commit: any) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: {
          name: commit.commit.author?.name || 'Unknown',
          email: commit.commit.author?.email || 'unknown@example.com',
          date: commit.commit.author?.date || new Date().toISOString()
        },
        url: commit.html_url
      }))
    } catch (error) {
      console.error(`Failed to get commits for ${owner}/${repo}:`, error)
      throw new Error(`Failed to get commits: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  public async checkRepositoryAccess(repoUrl: string): Promise<boolean> {
    const parsed = parseGitHubUrl(repoUrl)
    if (!parsed) {
      return false
    }

    try {
      await this.getRepository(parsed.owner, parsed.repo)
      return true
    } catch {
      return false
    }
  }

  public async createBranch(owner: string, repo: string, branchName: string, fromBranch: string = 'main'): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new Error('GitHub API not authenticated')
    }

    try {
      // Get the SHA of the source branch
      const refResponse = await this.octokit!.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${fromBranch}`
      })

      const sourceSha = refResponse.data.object.sha

      // Create the new branch
      await this.octokit!.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: sourceSha
      })

      console.log(`Created branch ${branchName} from ${fromBranch}`)
    } catch (error) {
      console.error(`Failed to create branch ${branchName}:`, error)
      throw new Error(`Failed to create branch: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  public async updateFile(
    owner: string, 
    repo: string, 
    path: string, 
    content: string, 
    message: string,
    branch?: string
  ): Promise<void> {
    if (!this.isAuthenticated()) {
      throw new Error('GitHub API not authenticated')
    }

    try {
      // Check if file exists to get its SHA
      let sha: string | undefined

      try {
        const existingFile = await this.octokit!.rest.repos.getContent({
          owner,
          repo,
          path,
          ref: branch
        })

        if ('sha' in existingFile.data) {
          sha = existingFile.data.sha
        }
      } catch {
        // File doesn't exist, that's fine for creation
      }

      // Update or create the file
      await this.octokit!.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64'),
        sha,
        branch
      })

      console.log(`Updated file ${path} in ${owner}/${repo}`)
    } catch (error) {
      console.error(`Failed to update file ${path}:`, error)
      throw new Error(`Failed to update file: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
}

// Export singleton instance
export const githubAPI = new GitHubAPIManager()

// Helper functions
export function createPullRequestFromRepo(
  repoUrl: string,
  title: string,
  body: string,
  branchName: string,
  baseBranch: string = 'main'
): Promise<GitHubPRResult> {
  const parsed = parseGitHubUrl(repoUrl)
  if (!parsed) {
    throw new Error('Invalid GitHub repository URL')
  }

  return githubAPI.createPullRequest({
    repository: { owner: parsed.owner, repo: parsed.repo },
    title,
    body,
    head: branchName,
    base: baseBranch
  })
}

export async function validateRepositoryAccess(repoUrl: string): Promise<boolean> {
  return githubAPI.checkRepositoryAccess(repoUrl)
}

export async function getCurrentUser(): Promise<any | null> {
  return githubAPI.validateToken()
} 