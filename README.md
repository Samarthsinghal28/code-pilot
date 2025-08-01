# Code Pilot 🚀

Code Pilot is a sandboxed AI coding agent that can automatically generate and propose code changes to a GitHub repository by creating a pull request based on a natural language prompt.

*Note: A screenshot of the UI will be added here soon.*

## ✨ Features

- **🤖 AI-Powered Code Generation**: Leverages OpenAI's top models (`gpt-4o`) to understand prompts and generate high-quality code.
- **🛡️ Secure Sandboxing**: Clones repositories and executes code within a secure, isolated sandbox environment using E2B.
- **🔄 Automated GitHub Workflow**: Automatically creates a new branch, commits the changes, and opens a pull request on the target repository.
- **📺 Real-time Streaming UI**: A Next.js frontend provides a real-time view of the agent's progress, from cloning to PR creation, using Server-Sent Events (SSE).
- **🔎 LLM Observability**: Integrated with LangSmith for detailed tracing and debugging of the agent's decision-making process.
- **✅ Code Validation & Retry**: Includes a validation loop to check for malformed code from the LLM and automatically retries with better instructions.

## 🛠️ Tech Stack

- **Framework**: [Next.js](https://nextjs.org/) (App Router)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **AI**: [OpenAI API](https://openai.com/docs) (`gpt-4o`)
- **Sandboxing**: [E2B](https://e2b.dev/)
- **Observability**: [LangSmith](https://www.langchain.com/langsmith)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/) with [shadcn/ui](https://ui.shadcn.com/)
- **Package Manager**: [pnpm](https://pnpm.io/)

## 🏗️  Project Architecture

### High-Level Flow
1. **Frontend** (Next.js App Router)
    • User enters a GitHub URL and a natural-language prompt.<br>  • The UI calls `POST /api/code` and streams Server-Sent Events (SSE).<br>  • While the agent works, the UI can open auxiliary pages:
      – **/diff** – visual diff viewer  
      – **/verification** – web terminal into the sandbox  
      – **/ide** – in-browser file explorer + Monaco editor.
2. **/api/code**  
   Creates an `McpAgent`, wraps it with a LangSmith tracer and returns an SSE stream of `StreamEvent`s.
3. **McpAgent**  
   • Sets up an **E2B** sandbox (`/tmp/repo`).  
   • Clones the repo (`clone_repository` tool).  
   • Analyses the repo (LLM + tools).  
   • Generates an implementation plan.  
   • Calls tools (`list_files`, `read_file`, `write_file`, `git_*`) autonomously through OpenAI function-calling.  
   • Commits, optionally pauses for verification, then opens a PR.
4. **SandboxManager** (singleton)  
   Keeps a map `sessionId → E2BSandbox` so all API routes (/diff, /ide, /verification) hit the **same** running container.

### Key Packages / Folders
```
app/                Next.js routes & pages (UI + API)
  api/
    code/route.ts     → POST /api/code (LLM agent)
    diff/route.ts     → GET  /api/diff (pretty diff JSON)
    ide/route.ts      → GET/POST /api/ide (tree + file IO)
    publish/route.ts  → POST /api/publish (resume & push)
    terminal/…        → WebSocket terminal bridge
  (diff|ide|verification)/page.tsx  → Client pages
lib/
  llm/openai.ts      → OpenAI wrapper (function-calling, cost calc)
  agent/…            → McpAgent + tool runner & planner
  e2b-sandbox.ts     → Thin wrapper around E2B Code-Interpreter
  sandbox-manager.ts → Maps sessionId → sandbox (cleans up idle)
  terminal/session-manager.ts → Maps sessionId → node-pty process
components/          → shadcn/ui primitives
```

## 🔌  API Endpoints
| Method | Path               | Purpose |
| ------ | ------------------ | ------- |
| POST   | `/api/code`        | Launch agent, returns **SSE** stream of `StreamEvent` objects. |
| GET    | `/api/diff`        | JSON diff of current sandbox (`sessionId`). |
| GET    | `/api/ide`         | `action=listFiles|readFile` tree & file IO. |
| POST   | `/api/ide`         | `action=saveFile` write file back to sandbox. |
| GET    | `/api/terminal/ws` | WebSocket for interactive terminal. |
| POST   | `/api/publish`     | Resume a paused agent, push & open PR. |

See `types/index.ts` for full `StreamEvent` and diff schema.

## 📂  Session-based Verification Workflow
1. Run with *Verification* enabled on the main page.  
2. Agent pauses and emits `pause_for_verification` event with `sessionId`.  
3. Buttons open `/diff?sessionId=x`, `/ide?sessionId=x`, `/verification?sessionId=x`.  
4. All pages talk to the **same** sandbox via `SandboxManager`.  
5. When satisfied, click **Publish PR** – frontend calls `/api/publish` which resumes the agent.

## 📝 API Usage

The primary endpoint is a POST request to `/api/code`.

**Endpoint**: `POST /api/code`

**Body**:
```json
{
  "repoUrl": "https://github.com/username/repository-name",
  "prompt": "Add a dark mode toggle to the settings page"
}
```

The API streams back Server-Sent Events (SSE) with real-time updates on the agent's progress. The frontend consumes this stream to update the UI. 

## ⚙️  Environment Variables (`.env`)
| Key | Description |
| --- | ----------- |
| `OPENAI_API_KEY` | Your OpenAI key (used by `lib/llm/openai.ts`). |
| `LLM_MODEL`      | Model name (defaults to `gpt-4o`). Change to any model supported by OpenAI. |
| `LLM_TEMPERATURE`| Sampling temperature (default 0.1). |
| `E2B_API_KEY`    | API key for E2B Code-Interpreter sandbox. |
| `USE_E2B_SANDBOX`| `true`/`false` – switch between E2B and local `VirtualSandbox` (for tests). |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Token with `repo` scope to create branches & PRs. |
| (see `.env.example` for the full list) |

## 🖥️  Running Locally (Quick Start)
```bash
pnpm install       # or npm / yarn
cp .env.example .env  # add your keys
pnpm dev           # http://localhost:3000
```

## 💸  Token & Cost Tracking
`lib/llm/openai.ts` records token usage per request and multiplies it by the pricing table in `.env → LLM_COST_PER_1K_TOKENS`.  
Adjust the JSON if you switch models – it **does not** affect which model is used, only cost calculation.

## 🧰  Tooling & Scripts
| Script | Description |
| ------ | ----------- |
| `pnpm dev`   | Start Next.js in dev mode. |
| `pnpm lint`  | ESLint + TypeScript checks. |
| `pnpm build` | Production build. |
| `pnpm start` | Start prod server. |

## 🤝  Contributing
PRs are welcome!  Please open an issue first to discuss changes.

## 📜  License
MIT 