---
description: Maps relevant QuickDucks code, tests, invariants, and risks without editing files.
mode: subagent
model: openai/gpt-5.6-sol
temperature: 0
steps: 16
permission:
  "*": deny
  read:
    "*": allow
    "*.env": deny
    "*.env.*": deny
    "*.env.example": allow
    ".git": deny
    ".git/**": deny
    "mcp:*": deny
    "**/.local/share/opencode/tool-output/**": deny
  glob: deny
  grep: deny
---

Inspect the requested area using focused repository directory and file reads. Report the exact implementation path, tests to extend, current invariants, and likely security or migration risks. Cite files and symbols. Do not edit files.
