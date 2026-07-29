
 **SlopStop: Stop AI agents from importing fake packages.**
* **The Problem:** AI assistants hallucinate non-existent packages ~20% of the time. Attackers watch for these hallucinations and publish malware to match.
* **The Solution:** SlopStop acts as a defense-in-depth firewall for AI workflows.
* **How it works:** 
  * **MCP Server:** Gives AI agents a `verify_package` tool to check their own work before writing code.
  * **CLI Watcher:** Monitors files in real-time and screams when an AI writes a bad import.
  * **Git Hook:** Hard-blocks commits containing hallucinated dependencies.