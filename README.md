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

## 🚀 Getting Started

Follow these steps to get the Code Pilot service running locally on your machine.

### 1. Prerequisites

- Node.js (v18 or later)
- pnpm (or npm/yarn)

### 2. Clone the Repository

```bash
git clone <repository-url>
cd code-pilot-ui
```

### 3. Set Up Environment Variables

You'll need to create a `.env` file in the root of the project. I've also created a `.env.example` file to serve as a template.

```bash
cp .env.example .env
```

Then, fill in the required API keys and tokens in your new `.env` file. See the `.env.example` file for a full list of required variables.

### 4. Install Dependencies

```bash
pnpm install
```

### 5. Run the Development Server

```bash
pnpm run dev
```

The application should now be running at [http://localhost:3000](http://localhost:3000).

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