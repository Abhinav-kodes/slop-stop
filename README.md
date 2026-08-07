***

<div align="center">
  
# Slop-Stop
  
**Stop AI coding agents from importing fake and malicious packages.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

Socket.dev protects you *after* `npm install`. **Slop-Stop protects you when the AI hits Tab.**

---

- ## ⚠️ The Problem: "Slopsquatting" & Account Hijacking
  AI coding assistants (Claude Code, Cursor, Copilot, opencode, Antigravity) frequently hallucinate package names. But the real danger isn't just a `404` error—it's **Slopsquatting**. 

  Attackers monitor AI outputs, see which fake package names models hallucinate, and register those names on npm or PyPI filled with malware. When an AI suggests the package and writes the import, your environment is compromised the moment the file is saved or executed—even before you run `npm install`. Furthermore, phished maintainer accounts publishing malicious updates to established packages (e.g. `axios`, `is`, `keyv`) pose an equal threat that standard heuristics miss.

---

- ## 🛡️ The Solution: Deterministic Agent-Agnostic Defense
  Slop-Stop provides a multi-layer defense stack built around **deterministic filesystem and shell boundaries**. Because it doesn't rely solely on the AI to police itself, it works across **all** AI coding tools (Antigravity, opencode, Cursor, Windsurf, Claude Code):

1. **The Brain (Advisory MCP Server):** Broadcasts protocol instructions to compatible AI agents during handshake, giving them a `verify_package` tool to check package existence & safety before writing code.
2. **The Eyes (Real-Time File Watcher):** Monitors workspace files in real-time (`slop-stop watch`). The millisecond an AI writes a bad import or manifest entry, Slop-Stop flashes a loud terminal alert.
3. **The Gate (Git Pre-Commit Hook):** Hard-blocks commits (`exit 1`) containing confirmed hallucinated dependencies, and soft-warns on suspicious packages.
4. **The Backstop (Shell Shims):** Optional `slop-stop shim-npm` & `shim-pip` wrapper functions to intercept literal `npm install` and `pip install` commands before network requests occur.

---

- ## 🎯 How it Works: The Action Matrix

Slop-Stop doesn't just check if a package exists—it checks if it's safe using Registry APIs, Deep Metadata Heuristics, and deps.dev / OSV Threat Intel.

| Package Status | What it means | Layer 1: MCP Server | Layer 2: File Watcher | Layer 3: Git Pre-Commit Hook | Layer 4: Shell Shim |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`PASS`** | Legitimate, established package or allowlisted/private scope. | AI proceeds. | Silent / Green tick. | ✅ Commit succeeds (`exit 0`). | Allows install. |
| **`SUSPICIOUS`** | Package exists, but has red flags (created < 14 days ago, 1 version, low OpenSSF Scorecard, no Sigstore). | AI warned to find alternative. | Massive **Yellow ⚠️ WARNING**. | ⚠️ Commit succeeds, but loud warning printed. | Warns developer. |
| **`HALLUCINATION`** | Package does not exist on registry (404). | AI told not to write import. | Massive **Red 🚨 INTERCEPTED 🚨**. | ❌ **Hard Block**: Commit fails (`exit 1`). | Blocks `npm/pip install`. |

*Note: `SUSPICIOUS` packages soft-warn by default so developers aren't blocked from intentionally using brand-new, legitimate libraries.*

---

- ## 📁 Supported Files & Ecosystems

  - **JavaScript/TypeScript:** `.js`, `.jsx`, `.ts`, `.tsx` (via AST parsing with subpath normalization)
  - **Python:** `.py` (via import parsing) and Jupyter Notebooks (`.ipynb`)
  - **Manifests:** `package.json` and `requirements.txt`
  - **Lockfiles:** `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock` (lockfile drift detection)
  - **Private Registry / Scope Awareness:** Automatically parses `.npmrc`, `pip.conf`, and `pyproject.toml` to auto-PASS internal scopes (`@mycompany/*`, Verdaccio, Artifactory, GitHub Packages).

---

- ## 🚀 Quick Start

### 1. Install the CLI
```bash
npm install -g slop-stop
```

### 2. Install the Git Pre-Commit Hook
Safely chains into `husky` or creates a native POSIX `.git/hooks/pre-commit` file.
```bash
slop-stop install-hook
```

### 3. Run the Real-Time File Watcher
Run this in the background while your AI agent works to get real-time alerts.
```bash
slop-stop watch
```

### 4. Configure the MCP Server (For Claude Code, Cursor, Antigravity, etc.)
Add Slop-Stop to your agent's MCP configuration to give the AI a tool to check its own work.

*Example configuration:*
```json
{
  "mcpServers": {
    "slop-stop": {
      "command": "slop-stop",
      "args": ["mcp"]
    }
  }
}
```

---

- ## ⚙️ Configuration

Create a `.slop-stop.json` file in your project root to customize behavior, adjust age thresholds, or allowlist specific internal packages.

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

---

- ## 🏗️ High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                    AI Coding Agent (Antigravity, opencode, Cursor, etc.)│
└────────┬──────────────────────────────┬───────────────────────────┬─────┘
         │ 1. MCP Handshake (Advisory)  │ 2. Writes file to disk    │ 3. Git Commit / npm i
         ▼                              ▼                           ▼
┌─────────────────┐           ┌──────────────────┐         ┌────────────────────────┐
│  LAYER 1: MCP   │           │  LAYER 2: WATCHER│         │  LAYER 3: HOOK & LAYER 4: SHIM
│  Server (Brain) │           │  Daemon (Eyes)   │         │  (Gate & Backstop)
└────────┬────────┘           └────────┬─────────┘         └───────┬────────────────┘
         │                             │                           │
         │ 4. verify_package(pkg)      │ 5. onFileChange(path)     │ 6. check-staged() / intercept()
         ▼                             ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           THE CORE ENGINE (Shared)                      │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────────────┐ │
│  │ Package Extractor│  │ Registry Client  │  │ Deep Heuristics Engine │ │
│  │ (AST + Manifest +│->│ (API + LRU Cache │->│ (Age, Versions, README,│ │
│  │   Lockfiles)     │  │  + deps.dev/OSV) │  │ Scorecard, Provenance) │ │
│  └──────────────────┘  └──────────────────┘  └───────────┬────────────┘ │
│                                                          │              │
│                                                          ▼              │
│                                               ┌─────────────────────┐   │
│                                               │ Config, .npmrc &    │   │
│                                               │ Scope Resolution    │   │
│                                               └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
         │                             │                           │
         ▼                             ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     THE ACTION MATRIX (Graduated Response)              │
│                                                                         │
│  Status: PASS       │  Status: SUSPICIOUS (Malware / Drift Risk)        │
│  - MCP: "Verified"  │  - MCP: "Red flags. Consider alternative."        │
│  - Watcher: Silent  │  - Watcher: Yellow ⚠️ WARNING (Soft Warn)         │
│  - Hook: exit(0)    │  - Hook: exit(0) with loud yellow warning         │
│  - Shim: Allows     │  - Shim: Warns developer                            │
│                                                                         │
│                     │  Status: HALLUCINATION (404 / Does Not Exist)     │
│                     │  - MCP: "Do not write this import."               │
│                     │  - Watcher: Red 🚨 INTERCEPTED 🚨                 │
│                     │  - Hook: exit(1) (Hard Block Commit)              │
│                     │  - Shim: Blocks npm/pip install                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

- ## 📜 License
MIT © [Abhinav-kodes]