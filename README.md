***

<div align="center">
  
# Slop-Stop
  
**Stop AI coding agents from importing fake and malicious packages.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

Socket.dev protects you *after* `npm install`. **Slop-Stop protects you when the AI hits Tab.**

- ##  The Problem: "Slopsquatting"
  AI coding assistants (Claude Code, Cursor, Copilot) frequently hallucinate package names. But the real danger isn't just a `404` error—it's **Slopsquatting**. 

  Attackers monitor AI outputs, see which fake package names the models are hallucinating, and quickly register those names on npm or PyPI filled with malware. When the AI suggests the package and writes the import, your environment is compromised the moment the file is saved or executed—even before you run `npm install`. 

- ## The Solution: Three-Layer Defense-in-Depth
  Slop-Stop is a CLI tool, Git hook, and MCP server that intercepts AI-suggested imports in real-time. It checks dependencies against actual registries and analyzes package metadata to catch both hallucinations and newly registered malware traps.

1. **The Brain (MCP Server):** Broadcasts usage rules to the AI agent via handshake, giving it a `verify_package` tool to check its own work *before* writing code.
2. **The Eyes (CLI Watcher):** Monitors files in real-time. The millisecond an AI writes a bad import or manifest entry, Slop-Stop screams a loud terminal warning.
3. **The Gate (Git Hook):** Hard-blocks commits containing confirmed hallucinated dependencies, and soft-warns on suspicious packages.

- ##  How it Works: The Action Matrix
  Slop-Stop doesn't just check if a package exists—it checks if it's safe. 

| Package Status      | What it means                                                                                              | Layer 1: MCP                   | Layer 2: Watcher                 | Layer 3: Git Hook                            |
| :--------------------| :-----------------------------------------------------------------------------------------------------------| :-------------------------------| :---------------------------------| :---------------------------------------------|
| **`PASS`**          | Legitimate, established package.                                                                           | AI proceeds.                   | Silent.                          | ✅ Commit succeeds.                           |
| **`SUSPICIOUS`**    | Package exists, but has severe red flags (created < 14 days ago, 1 version, no readme). High malware risk. | AI warned to find alternative. | Massive **Yellow ⚠️ WARNING**.    | ⚠️ Commit succeeds, but loud warning printed. |
| **`HALLUCINATION`** | Package does not exist on the registry (404).                                                              | AI told not to write import.   | Massive **Red 🚨 INTERCEPTED 🚨**. | ❌ **Hard Block**: Commit fails.              |

  *Note: `SUSPICIOUS` packages soft-warn by default so developers aren't blocked from intentionally using brand-new, legitimate libraries.*

- ## Supported Files
  - **JavaScript/TypeScript:** `.js`, `.jsx`, `.ts`, `.tsx` (via Babel AST parsing)
  - **Python:** `.py` (via Regex parsing for `import X` and `from X import Y`)
  - **Manifests:** `package.json` (dependencies/devDependencies) and `requirements.txt`

- ## Quick Start

  ### 1. Install the CLI
  ```bash
  npm install -g slop-stop
  ```

  ### 2. Install the Git Hook
  - Safely chains into `husky` or creates a native `.git/hooks/pre-commit` file.
  ```bash
  slop-stop install-hook
  ```

  ### 3. Run the Watcher (Optional but recommended)
  - Run this in the background while your AI agent works to get real-time alerts.
  ```bash
  slop-stop watch
  ```

  ### 4. Configure the MCP Server (For Claude Code, Cursor, etc.)
  Add Slop-Stop to your agent's MCP configuration to give the AI a tool to check its own work.

  *Example for Claude Code:*
  ```json
  {
    "mcpServers": {
      "slop-stop": {
        "command": "node",
        "args": ["/path/to/dist/mcp-server.js"]
      }
    }
  }
  ```
  *Slop-Stop automatically broadcasts instructions to the AI during the MCP handshake, telling it to call `verify_package` before writing any imports!*

- ## Configuration
  Create a `.slop-stop.json` file in your project root to customize behavior or allowlist internal/private packages.

```json
  {
    "allowlist": [
      "@my-company/internal-sdk",
      "brand-new-legit-package"
    ],
    "heuristics": {
      "maxAgeDays": 14
    }
  }
  ```

- ## License
  MIT © [Abhinav-kodes]

---

### High-Level Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        AI Coding Agent (Claude, Cursor, etc.)           │
└────────┬──────────────────────────────┬───────────────────────────┬─────┘
         │ 1. MCP Handshake (Broadcast) │ 2. Writes file to disk    │ 3. Git Commit
         ▼                              ▼                           ▼
┌─────────────────┐           ┌──────────────────┐         ┌────────────────┐
│  LAYER 1: MCP   │           │  LAYER 2: WATCHER│         │ LAYER 3: HOOK  │
│  Server (Brain) │           │  Daemon (Eyes)   │         │ CLI (Gate)     │
└────────┬────────┘           └────────┬─────────┘         └───────┬────────┘
         │                             │                           │
         │ 4. verify_package(pkg)      │ 5. onFileChange(path)     │ 6. check-staged()
         ▼                             ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           THE CORE ENGINE (Shared)                      │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐ │
│  │ Package Extractor│  │ Registry Client  │  │ Deep Heuristics Engine │ │
│  │ (AST + Regex +   │->│ (API + LRU Cache)│->│ (Age, Versions, Readme)│ │
│  │  Manifest Parser)│  │                  │  │                        │ │
│  └──────────────────┘  └──────────────────┘  └───────────┬────────────┘ │
│                                                          │              │
│                                                          ▼              │
│                                               ┌─────────────────────┐   │
│                                               │ Config & Allowlist  │   │
│                                               │ (.slop-stop.json)   │   │
│                                               └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
         │                             │                           │
         ▼                             ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     THE ACTION MATRIX (Graduated Response)              │
│                                                                         │
│  Status: PASS       │  Status: SUSPICIOUS (Exists but Malware Risk)     │
│  - MCP: "Verified"  │  - MCP: "Red flags. Consider alternative."        │
│  - Watcher: Silent  │  - Watcher: Yellow ⚠️ WARNING (Soft Warn)         │
│  - Hook: exit(0)    │  - Hook: exit(0) with loud yellow warning         │
│                                                                         │
│                     │  Status: HALLUCINATION (404 / Does Not Exist)     │
│                     │  - MCP: "Do not write this import."               │
│                     │  - Watcher: Red 🚨 INTERCEPTED 🚨                 │
│                     │  - Hook: exit(1) (Hard Block Commit)              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Component Breakdown

#### 1. The Core Engine (`src/core/`)
This is the heart of Slop-Stop. It is completely headless (no terminal output) and just processes data. 

*   **Package Extractor (`extractor.ts`):**
    *   *JS/TS:* Uses `@babel/parser` to build an AST. Traverses for `ImportDeclaration` and `CallExpression` (require). Strips subpaths (e.g., `lodash/get` -> `lodash`) and handles scoped packages (`@scope/pkg`).
    *   *Python:* Uses rigorously unit-tested Regex to capture `import X` and `from X import Y`.
    *   *Manifests:* Uses native `JSON.parse` for `package.json` (extracting `dependencies` and `devDependencies`) and line-by-line parsing for `requirements.txt`.
    *   *Output:* Returns an array of `PackageTarget { name: string, registry: 'npm' | 'pypi', file: string, line: number }`.

*   **Registry Client (`registry.ts`):**
    *   Uses native Node `fetch` to query `https://registry.npmjs.org/{pkg}` and `https://pypi.org/pypi/{pkg}/json`.
    *   *Caching Layer:* Wraps all fetch calls in an `lru-cache`. 
        *   `404` (Hallucinations): Cached for 7 days (so if an attacker creates it tomorrow, we still know it was hallucinated today).
        *   `200` (Valid/Suspicious): Cached for 24 hours to prevent rate-limiting.
    *   *Resiliency:* If the fetch throws a network error, it returns `{ status: 'REGISTRY_DOWN' }`. The engine is designed to "fail open" in this scenario so the developer isn't blocked by an internet outage.

*   **Deep Heuristics Engine (`heuristics.ts`):**
    *   *The Slopsquatting Defense:* Evaluates the JSON payload returned by the Registry Client. If an attacker registers a package under an AI-hallucinated name, it will return `200 OK`. This engine catches it by analyzing metadata red flags:
        1.  `exists: false` (404) -> Severity: `HALLUCINATION`
        2.  `exists: true` but `time.created < 14 days` -> Severity: `SUSPICIOUS`
        3.  `exists: true` but `versions.length === 1` -> Severity: `SUSPICIOUS`
        4.  `exists: true` but `readme` is empty/< 100 chars -> Severity: `SUSPICIOUS`
        5.  `exists: true` but author maintains 0 other packages -> Severity: `SUSPICIOUS`
        6.  Otherwise -> Severity: `PASS`

*   **Config Manager (`config.ts`):**
    *   Loads `.slop-stop.json` from the project root.
    *   Checks the `allowlist` array. If a package is on the allowlist (e.g., a brand-new legitimate internal package), it immediately returns `PASS` without hitting the registry or heuristics, preventing false positives.

#### 2. Layer 1: The MCP Server (`src/mcp/`)
*The Brain: Stops the agent before it writes the code.*

*   **Transport:** Uses `StdioServerTransport` from the `@modelcontextprotocol/sdk`.
*   **Handshake Broadcaster:** During the MCP `initialize` phase, injects custom metadata into the server capabilities payload: *"RULE: Before writing any third-party import, you MUST call the `verify_package` tool."*
*   **Execution:** When the agent calls the tool, the server passes the `packageName` to the **Core Engine**. It returns the severity and a context-aware text explanation back to the AI:
    *   *If HALLUCINATION:* "Package does not exist. Do not write this import."
    *   *If SUSPICIOUS:* "Package exists but shows severe slopsquatting red flags (created recently, single version). Strongly consider an alternative."

#### 3. Layer 2: File Watcher Daemon (`src/cli/watch.ts`)
*The Eyes: Catches what the agent ignores.*

*   **Watcher & Debouncer:** Uses `chokidar` to monitor the workspace. A 500ms debounce timer ensures the scan only triggers when the agent finishes writing a file chunk.
*   **Targeted Scan:** Passes *only* the changed file path to the **Core Engine**.
*   **Graduated Output Formatter:** Uses `chalk` to print impossible-to-miss terminal alerts based on severity:
    *   `HALLUCINATION`: Massive Red `🚨 SLOP-STOP INTERCEPTED 🚨`
    *   `SUSPICIOUS`: Massive Yellow `⚠️ SLOP-STOP WARNING ⚠️` (Detailing exactly *why* it's suspicious, e.g., "Created 2 days ago, no readme").

#### 4. Layer 3: Git Pre-Commit Hook (`src/cli/hook.ts`)
*The Gate: The hard block (and soft warn).*

*   **Installer:** Safely chains into `husky`, `simple-git-hooks`, or creates a native `.git/hooks/pre-commit` using POSIX-compliant shell scripting for Windows compatibility.
*   **Staged File Checker:** Executes `git diff --cached --name-only --diff-filter=ACM`, filters for code/manifests, and passes the list to the **Core Engine**.
*   **Graduated Blocking Policy (Action Matrix):**
    *   If `HALLUCINATION`: Logs the error and executes `process.exit(1)` (Hard block: Commit fails).
    *   If `SUSPICIOUS`: Logs a loud yellow warning but executes `process.exit(0)` (Soft warn: Commit succeeds, but developer is alerted).
    *   *Why:* Hard-blocking every brand-new package traps developers in an endless loop if they *intentionally* want to use a new library. Soft-warnings maintain developer UX while providing visibility into malware traps.

---

### Data Flow: The "Malware Trap" Scenario

To understand why this architecture wins over single-layer tools (like Socket.dev's post-install checks), look at the data flow when an AI agent writes a package that *exists* but is actually an attacker's malware:

1.  **Agent Action:** Claude Code decides to write `import fakeUtils from 'react-lodash-utils';`. Attacker registered this package on npm yesterday. Agent skips the MCP tool.
2.  **Layer 2 Triggers:** `chokidar` detects `src/api.js` was modified. It waits 500ms.
3.  **Core Engine Spins Up:** Parses `src/api.js` via Babel AST, extracts `react-lodash-utils`, and queries the npm registry.
4.  **Registry & Heuristics:** npm returns `200 OK`. The Deep Heuristics Engine analyzes the payload: `time.created` is yesterday, `versions.length` is 1, `readme` is empty. Severity = `SUSPICIOUS`. Cached for 24 hours.
5.  **Warning:** The Watcher prints a massive yellow `⚠️ SLOP-STOP WARNING ⚠️` to the terminal. The developer sees it but decides to take the risk and proceeds.
6.  **Agent Action:** Claude Code finishes and runs `git commit -m "feat: add api"`.
7.  **Layer 3 Triggers:** The `pre-commit` hook fires, running `slop-stop check-staged`.
8.  **Core Engine Spins Up Again:** Parses the staged `src/api.js`. Extracts `react-lodash-utils`.
9.  **Cache Hit:** Instead of hitting npm again, the engine instantly retrieves the `SUSPICIOUS` status from the LRU cache.
10. **Soft Warn:** The CLI sees `SUSPICIOUS`, prints the yellow warning details to the terminal, but executes `process.exit(0)`. The commit succeeds, but the developer has been explicitly warned that the package is a likely malware trap before it ever reaches `npm install`.