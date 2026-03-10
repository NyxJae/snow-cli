tool_search
   └─ query: "xlsx-viewer"
Error: [API_ERROR] Anthropic API HTTP 400: Bad Request -
   {"type":"api_error","request_id":"","error":{"type":"api_error","message":"function
   name subagent-agent_reviewer is duplicated"}}

[
  {
    "name": "tool_search",
    "description": "Search for available tools by keyword or description. Call this FIRST to discover tools you need. Found tools become immediately available. Search by authorized built-in category (e.g., \"subagent\", \"filesystem\", \"todo\", \"ace\", \"useful_info\") or by action (e.g., \"edit file\", \"search code\", \"run command\"). You can call this multiple times to discover different tool categories. Additionally, the following third-party MCP services are loaded and searchable: \"chrome_devtools\" (Clicks on the provided element; Closes the page by its index. The last open page cannot b...; Drag an element onto another element +16 more). Search by their service name to discover their tools.",
    "input_schema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query - tool name, keyword, or description of what you want to do. Examples: \"subagent\", \"filesystem\", \"todo\", \"ace\", \"useful_info\", \"edit file\", \"search code\", \"run command\". Third-party services: \"chrome_devtools\""
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "filesystem-read",
    "description": "Read file content with line numbers. Supports text files, images, Office documents, and directories. **REMOTE SSH SUPPORT**: Fully supports remote files via SSH URL format (ssh://user@host:port/path). **PATH REQUIREMENT**: Use EXACT paths from search results or user input, never undefined/null/empty/placeholders. **WORKFLOW**: (1) Use search tools FIRST to locate files, (2) Read only when you have the exact path. **SUPPORTS**: Single file (string), multiple files (array of strings), or per-file ranges (array of {path, startLine?, endLine?}). Returns content with line numbers (format: \"123->code\").",
    "input_schema": {
      "type": "object",
      "properties": {
        "filePath": {
          "oneOf": [
            {
              "type": "string",
              "description": "Path to a single file to read or directory to list"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Array of file paths to read in one call (uses unified startLine/endLine from top-level parameters)"
            },
            {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "description": "File path"
                  },
                  "startLine": {
                    "type": "number",
                    "description": "Optional: Starting line for this file (overrides top-level startLine)"
                  },
                  "endLine": {
                    "type": "number",
                    "description": "Optional: Ending line for this file (overrides top-level endLine)"
                  }
                },
                "required": [
                  "path"
                ]
              },
              "description": "Array of file config objects with per-file line ranges. Each file can have its own startLine/endLine."
            }
          ],
          "description": "Path to the file(s) to read or directory to list: string, array of strings, or array of {path, startLine?, endLine?} objects"
        },
        "startLine": {
          "type": "number",
          "description": "Optional: Default starting line number (1-indexed) for all files. Omit to read from line 1. Can be overridden by per-file startLine in object format."
        },
        "endLine": {
          "type": "number",
          "description": "Optional: Default ending line number (1-indexed) for all files. Omit to read to end of file. Can be overridden by per-file endLine in object format."
        }
      },
      "required": [
        "filePath"
      ]
    }
  },
  {
    "name": "filesystem-create",
    "description": "Create a new file with content. **PATH REQUIREMENT**: Use EXACT non-empty string path, never undefined/null/empty/placeholders like \"path/to/file\". Verify file does not exist first. Automatically creates parent directories.注意!为安全起见,如果要创建的文件已存在,则会创建失败,故你需要先使用搜索工具确认文件存在性和内容,避免误覆盖.",
    "input_schema": {
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "description": "Path where the file should be created"
        },
        "content": {
          "type": "string",
          "description": "Content to write to the file"
        },
        "createDirectories": {
          "type": "boolean",
          "description": "Whether to create parent directories if they don't exist",
          "default": true
        }
      },
      "required": [
        "filePath",
        "content"
      ]
    }
  },
  {
    "name": "filesystem-edit_search",
    "description": "RECOMMENDED for most edits: Search-and-replace with SMART FUZZY MATCHING. **REMOTE SSH SUPPORT**: Fully supports remote files via SSH URL format (ssh://user@host:port/path). **CRITICAL PATH REQUIREMENTS**: (1) filePath parameter is REQUIRED - MUST be a valid non-empty string or array, never use undefined/null/empty string, (2) Use EXACT file paths from search results or user input - never use placeholders like \"path/to/file\", (3) If uncertain about path, use search tools first to find the correct file. **SUPPORTS BATCH EDITING**: Pass (1) single file with search/replace, (2) array of file paths with unified search/replace, or (3) array of {path, searchContent, replaceContent, occurrence?} for per-file edits. **CRITICAL WORKFLOW FOR CODE SAFETY - COMPLETE BOUNDARIES REQUIRED**: (1) Use search tools (codebase-search or ACE tools) to locate code, (2) MUST use filesystem-read to identify COMPLETE code boundaries with ALL closing pairs: entire function from declaration to final closing brace `}`, complete HTML/XML/JSX tags from opening `<tag>` to closing `</tag>`, full code blocks with ALL matching brackets/braces/parentheses, (3) Copy the COMPLETE code block (without line numbers) - verify you have captured ALL opening and closing symbols, (4) MANDATORY verification: Count and match ALL pairs - every `{` must have `}`, every `(` must have `)`, every `[` must have `]`, every `<tag>` must have `</tag>`, (5) Use THIS tool only after verification passes. **ABSOLUTE PROHIBITIONS**: NEVER edit partial functions (missing closing brace), NEVER edit incomplete markup (missing closing tag), NEVER edit partial code blocks (unmatched brackets), NEVER copy line numbers from filesystem-read output. **WHY USE THIS**: No line tracking needed, auto-handles spacing/tabs differences, finds best fuzzy match even with whitespace changes, safer than line-based editing. **SMART MATCHING**: Uses similarity algorithm to find code even if indentation/spacing differs from your search string. Automatically corrects over-escaped content. If multiple matches found, selects best match first (highest similarity score). **INCLUDE CONTEXT FOR BETTER MATCHING**: When providing searchContent and replaceContent, include 8-10 lines of surrounding context (before and after the actual edit target) to help the fuzzy matcher locate the exact position. This context acts as \"anchors\" for precise matching. **CRITICAL: KEEP CONTEXT IDENTICAL**: The surrounding context lines in searchContent and replaceContent MUST be EXACTLY the same - only modify the target line(s). **EXAMPLE**: To change line 50 from `const x = 1;` to `const x = 2;`, your searchContent should be: ```\nfunction foo() {\n  const y = 0;\n  const x = 1;\n  const z = 3;\n  return x + y;\n}\n``` and replaceContent should be: ```\nfunction foo() {\n  const y = 0;\n  const x = 2;\n  const z = 3;\n  return x + y;\n}\n``` Notice: Only line 3 changed (`const x = 1;` → `const x = 2;`), all other context lines remain IDENTICAL. **COMMON FATAL ERRORS TO AVOID**: Using invalid/empty file paths, modifying only part of a function (missing closing brace `}`), incomplete markup tags (HTML/Vue/JSX missing `</tag>`), partial code blocks (unmatched `{`, `}`, `(`, `)`, `[`, `]`), copying line numbers from filesystem-read output, providing insufficient context for matching, accidentally modifying context lines. You MUST include complete syntactic units with ALL opening/closing pairs verified and matched. **BATCH EXAMPLE**: filePath=[{path:\"a.ts\", searchContent:\"old1\", replaceContent:\"new1\"}, {path:\"b.ts\", searchContent:\"old2\", replaceContent:\"new2\"}].",
    "input_schema": {
      "type": "object",
      "properties": {
        "filePath": {
          "oneOf": [
            {
              "type": "string",
              "description": "Path to a single file to edit"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Array of file paths (uses unified searchContent/replaceContent from top-level)"
            },
            {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "description": "File path"
                  },
                  "searchContent": {
                    "type": "string",
                    "description": "Content to search for in this file"
                  },
                  "replaceContent": {
                    "type": "string",
                    "description": "New content to replace with"
                  },
                  "occurrence": {
                    "type": "number",
                    "description": "Which match to replace (1-indexed, default: 1)"
                  }
                },
                "required": [
                  "path",
                  "searchContent",
                  "replaceContent"
                ]
              },
              "description": "Array of edit config objects for per-file search-replace operations"
            }
          ],
          "description": "File path(s) to edit"
        },
        "searchContent": {
          "type": "string",
          "description": "Content to find and replace (for single file or unified mode). Copy from filesystem-read WITHOUT line numbers. **IMPORTANT**: Include 8-10 lines of surrounding context (before and after your actual edit target) to help the fuzzy matcher precisely locate the code. The context acts as \"anchors\" for accurate matching. **CRITICAL**: Keep context lines IDENTICAL between searchContent and replaceContent - only modify the target line(s). Example: To change `const x = 1;` to `const x = 2;`, searchContent: `function foo() {\\n  const y = 0;\\n  const x = 1;\\n  const z = 3;\\n}` and replaceContent: `function foo() {\\n  const y = 0;\\n  const x = 2;\\n  const z = 3;\\n}` (only line 3 changed, all context identical)."
        },
        "replaceContent": {
          "type": "string",
          "description": "New content to replace with (for single file or unified mode). **IMPORTANT**: Include the SAME surrounding context as searchContent, only modify the actual target lines. The surrounding context MUST be EXACTLY identical to searchContent - do NOT accidentally modify context lines. Only the target line(s) should differ. Example: If searchContent has 8 lines with line 3 as target, replaceContent should also have the same 8 lines with only line 3 modified."
        },
        "occurrence": {
          "type": "number",
          "description": "Which match to replace if multiple found (1-indexed). Default: 1 (best match first). Use -1 for all (not yet supported).",
          "default": 1
        },
        "contextLines": {
          "type": "number",
          "description": "Context lines to show before/after (default: 8)",
          "default": 8
        }
      },
      "required": [
        "filePath"
      ]
    }
  },
  {
    "name": "terminal-execute",
    "description": "执行终端命令,如 npm、git、构建脚本等。**SSH远程支持**: 当 workingDirectory 是远程 SSH 路径(ssh://...)时,命令会自动通过 SSH 在远程服务器执行 - 无需自己包装 ssh user@host,直接提供原始命令即可。最佳实践:对于文件编辑,MUST ONLY 使用 `filesystem-xxx` 系列工具,不可使用本工具进行任何文件的文本编辑!!!——主要使用场景:(1) 运行构建/测试/代码检查脚本,(2) 版本控制操作,(3) 包管理,(4) 系统工具,(5) 必要的文件操作`mv`,`cp`,`rm`等",
    "input_schema": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string",
          "description": "Terminal command to execute directly. For remote SSH working directories, provide raw commands without ssh wrapper - the system handles SSH connection automatically."
        },
        "workingDirectory": {
          "type": "string",
          "description": "REQUIRED: Working directory where the command should be executed. Can be a local path (e.g., \"D:/projects/myapp\") or a remote SSH path (e.g., \"ssh://user@host:port/path\"). For remote paths, the command will be executed on the remote server via SSH."
        },
        "timeout": {
          "type": "number",
          "description": "Timeout in milliseconds (default: 30000)",
          "default": 30000,
          "maximum": 300000
        },
        "isInteractive": {
          "type": "boolean",
          "description": "Set to true if the command requires user input (e.g., Read-Host, password prompts, y/n confirmations, interactive installers). When true, an input prompt will be shown to allow user to provide input. Default: false.",
          "default": false
        }
      },
      "required": [
        "command",
        "workingDirectory"
      ]
    }
  },
  {
    "name": "todo-get",
    "description": "Get current TODO list with task IDs, status, and hierarchy.\n\nPARALLEL CALLS ONLY: MUST pair with other tools (todo-get + filesystem-read/terminal-execute/etc).\nNEVER call todo-get alone - always combine with an action tool.\n\nUSE WHEN:\n- User provides additional info → Check what's already done before continuing\n- User requests modifications → Check current progress before adding tasks\n- Continuing work → Verify status to avoid redoing completed tasks\n\nEXAMPLE: todo-get + filesystem-read (check progress while reading files)",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "todo-update",
    "description": "Update TODO status/content - USE FREQUENTLY to track progress!\n\nPARALLEL CALLS ONLY: MUST pair with other tools (todo-update + filesystem-edit/terminal-execute/etc).\nNEVER call todo-update alone - always combine with an action tool.\n\nBEST PRACTICE: \n- Mark \"completed\" ONLY after task is verified\n- Update while working, not after\n- Example: todo-update(task1, completed) + filesystem-edit(task2) \n\nThis ensures efficient workflow and prevents unnecessary wait times.",
    "input_schema": {
      "type": "object",
      "properties": {
        "todoId": {
          "type": "string",
          "description": "TODO item ID to update (get exact ID from todo-get)"
        },
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "inProgress",
            "completed"
          ],
          "description": "New status - \"pending\" (not started), \"inProgress\" (currently working on), or \"completed\" (100% finished and verified)"
        },
        "content": {
          "type": "string",
          "description": "Updated TODO content (optional, only if task description needs refinement)"
        }
      },
      "required": [
        "todoId"
      ]
    }
  },
  {
    "name": "todo-add",
    "description": "Add tasks to TODO list - FIRST STEP for most programming tasks.\n\nPARALLEL CALLS ONLY: MUST pair with other tools (todo-add + filesystem-read/etc).\nNEVER call todo-add alone - always combine with an action tool.\n\nWHEN TO USE (Very common):\n- Start ANY multi-step task → Create TODO list immediately\n- User adds new requirements → Add tasks for new work\n- Break down complex work → Add subtasks\n\nSUPPORTS BATCH ADDING:\n- Single: content=\"Task description\"\n- Multiple: content=[\"Task 1\", \"Task 2\", \"Task 3\"] (recommended for multi-step work)",
    "input_schema": {
      "type": "object",
      "properties": {
        "content": {
          "oneOf": [
            {
              "type": "string",
              "description": "Single TODO item description"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Multiple TODO item descriptions for batch adding,注意:这里是数组,不是字符串,中括号外不要加引号"
            }
          ],
          "description": "TODO item description(s) - must be specific, actionable, and technically precise. Can be a single string or an array of strings."
        },
        "parentId": {
          "type": "string",
          "description": "Parent TODO ID to create a subtask (optional). Get valid IDs from todo-get. When adding multiple tasks, all will be added under the same parent."
        }
      },
      "required": [
        "content"
      ]
    }
  },
  {
    "name": "ace-text_search",
    "description": "ACE代码搜索: 字面文本/正则表达式模式匹配(grep风格搜索). 最适合查找精确字符串: TODO, 注释, 日志消息, 错误字符串, 字符串常量. 基于rg但更好更快.使用此工具,NOT直接用rg命令",
    "input_schema": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Text pattern or regex to search for. Examples: \"TODO:\" (literal), \"import.*from\" (regex), \"tool_call|toolCall\" (regex with OR). By default, pattern is treated as regex. Set isRegex to false for literal string search."
        },
        "fileGlob": {
          "type": "string",
          "description": "Glob pattern to filter files (e.g., \"*.ts\" for TypeScript only, \"**/*.{js,ts}\" for JS and TS, \"src/**/*.py\" for Python in src)"
        },
        "isRegex": {
          "type": "boolean",
          "description": "Whether to force regex mode. If not specified, the tool defaults to regex mode. Set to false to use literal string search.",
          "default": true
        },
        "maxResults": {
          "type": "number",
          "description": "Maximum number of results to return (default: 100)",
          "default": 100
        }
      },
      "required": [
        "pattern"
      ]
    }
  },
  {
    "name": "useful_info-add",
    "description": "📚 Add file content to useful information list - SHARED ACROSS ALL AGENTS\n\n⚠️ CRITICAL USAGE RULES:\n- Useful information is SHARED across main agent and all sub-agents in this session\n- MUST add/update useful info after editing files\n- Use line ranges to add only relevant code sections\n- ⚠️ MAX 50 LINES PER SECTION.\n\n## 🎯 WHEN TO ADD:\n✅ After editing a file - add the modified section (max 50 lines)\n✅ Key code sections needed for context (max 50 lines)\n✅ Important configurations or constants (max 50 lines)\n✅ Complex logic that needs to be referenced (max 50 lines)\n❌ DO NOT add entire files\n❌ DO NOT add trivial or obvious code\n❌ DO NOT exceed 50 lines per section - split large sections if needed\n\n## 💡 BEST PRACTICES:\n- Add specific functions/classes, not whole files\n- Update after each significant edit\n- Use descriptions to explain why this is useful\n- Keep the useful info list focused and relevant\n- ⚠️ REQUIRED: Always specify startLine and endLine parameters\n- ⚠️ LIMIT: Each section must be ≤50 lines (endLine - startLine + 1 ≤ 50)",
    "input_schema": {
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "filePath": {
                "type": "string",
                "description": "Path to the file (required)"
              },
              "startLine": {
                "type": "number",
                "description": "Starting line number (1-indexed, REQUIRED)"
              },
              "endLine": {
                "type": "number",
                "description": "Ending line number (1-indexed, REQUIRED)"
              },
              "description": {
                "type": "string",
                "description": "Optional description explaining why this is useful"
              }
            },
            "required": [
              "filePath",
              "startLine",
              "endLine"
            ]
          },
          "description": "Array of file sections to add to useful information"
        }
      },
      "required": [
        "items"
      ]
    }
  },
  {
    "name": "ide-get_diagnostics",
    "description": "🔍 Get diagnostics (errors, warnings, hints) for a specific file from the connected IDE. Works with both VSCode and JetBrains IDEs. Returns array of diagnostic information including severity, line number, character position, message, and source. Requires IDE plugin to be installed and running.",
    "input_schema": {
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "description": "Absolute path to the file to get diagnostics for. Must be a valid file path accessible by the IDE."
        }
      },
      "required": [
        "filePath"
      ]
    }
  },
  {
    "name": "askuser-ask_question",
    "description": "Ask the user a question with multiple choice options to clarify requirements. The AI workflow pauses until the user selects an option or provides custom input. Use this when you need user input to continue processing. Supports both single and multiple selection - user can choose one or more options.",
    "input_schema": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "The question to ask the user. Be clear and specific about what information you need."
        },
        "options": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Array of option strings for the user to choose from. Should be concise and clear. User can select one or multiple options.",
          "minItems": 2
        }
      },
      "required": [
        "question",
        "options"
      ]
    }
  },
  {
    "name": "subagent-agent_reviewer",
    "description": "reviewer: 负责专门审查的子Agent.提供:用户需求,审核范围,涉及文件等信息;产出:审核报告.",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session."
        }
      },
      "required": [
        "prompt"
      ]
    }
  },
  {
    "name": "subagent-agent_explore",
    "description": "Explore Agent: 专门快速探索和理解代码库的子Agent.擅长网络搜索,搜索代码、查找定义、分析代码结构和依赖关系,能帮你节约大量到处探索所消耗的token.复杂调研或调研目标模糊时,MUST发布任务给此子Agent.可将研究目标细分,并行调用多个探索子代理,每个子代理专注一个方向,比如,一个专门调研文档,一个专门调研代码等.将帮你收集有用信息和返回探索报告.",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session."
        }
      },
      "required": [
        "prompt"
      ]
    }
  },
  {
    "name": "subagent-agent_general",
    "description": "General Purpose Agent: 通用任务执行子Agent.可修改文件和执行命令.将任务拆分成小任务发布,让此Agent每次只专注执行一个具体小任务.并行调用时注意每个任务间不要有冲突.",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session."
        }
      },
      "required": [
        "prompt"
      ]
    }
  },
  {
    "name": "subagent-agent_architect",
    "description": "Architect: 项目架构师,专门管理更新项目的架构蓝图笔记,也负责根据新需求设计更新项目架构和制作开发计划,以保证项目的长线和短线开发质量.当有蓝图笔记需要更新,或新需求需要开发前,MUST发布任务给此子代理.蓝图笔记更新需要提供:涉及文件,避坑发现,等信息.新需求开发前,需要提供:用户需求,相关需求文档,相关代码等信息.",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session."
        }
      },
      "required": [
        "prompt"
      ]
    }
  },
  {
    "name": "skill-execute",
    "description": "Execute a skill within the main conversation\n\n<skills_instructions>\nWhen users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.\n\nHow to use skills:\n- Invoke skills using this tool with the skill id only (no arguments)\n- When you invoke a skill, you will see <command-message>The \"{name}\" skill is loading</command-message>\n- The skill's prompt will expand and provide detailed instructions on how to complete the task\n- Examples:\n  - skill: \"pdf\" - invoke the pdf skill\n  - skill: \"data-analysis\" - invoke the data-analysis skill\n\nImportant:\n- Only use skills listed in <available_skills> below\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n</skills_instructions>\n\n<available_skills>\n<skill>\n<name>\nxlsx-viewer\n</name>\n<description>\nExcel (.xlsx) 文件查询和分析工具。使用场景：查看配置数据、分析 Excel 文件内容、搜索特定表格内容、提取表格数据。触发关键词：查看xlsx、搜索excel、查询配置、xlsx查看、表格搜索、配置数据、找找配置\n</description>\n<location>\nproject\n</location>\n</skill>\n<skill>\n<name>\nunity-log\n</name>\n<description>\n查询 Unity 编辑器日志与截图 Game 视图. 触发关键词:Unity:日志,Unity log,Unity:截图,Unity screenshot\n</description>\n<location>\nproject\n</location>\n</skill>\n<skill>\n<name>\nunity-k3-prefab\n</name>\n<description>\nK3框架预制体查询与编辑工具. 触发关键词:Unity,K3预制体,K3 prefab,K3UI,UI\n</description>\n<location>\nproject\n</location>\n</skill>\n</available_skills>",
    "input_schema": {
      "type": "object",
      "properties": {
        "skill": {
          "type": "string",
          "description": "The skill id (no arguments). E.g., \"pdf\", \"data-analysis\", or \"helloagents/analyze\""
        }
      },
      "required": [
        "skill"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  },
  {
    "name": "subagent-agent_reviewer",
    "description": "reviewer: 负责专门审查的子Agent.提供:用户需求,审核范围,涉及文件等信息;产出:审核报告.",
    "input_schema": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "CRITICAL: Provide COMPLETE context from main session. Sub-agent has NO access to main conversation history. Include all relevant: (1) Task requirements and objectives, (2) Known file locations and code structure, (3) Business logic and constraints, (4) Code patterns or examples, (5) Dependencies and relationships. Be specific and comprehensive - sub-agent cannot ask for clarification from main session."
        }
      },
      "required": [
        "prompt"
      ]
    }
  },
  {
    "name": "skill-execute",
    "description": "Execute a skill within the main conversation\n\n<skills_instructions>\nWhen users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.\n\nHow to use skills:\n- Invoke skills using this tool with the skill id only (no arguments)\n- When you invoke a skill, you will see <command-message>The \"{name}\" skill is loading</command-message>\n- The skill's prompt will expand and provide detailed instructions on how to complete the task\n- Examples:\n  - skill: \"pdf\" - invoke the pdf skill\n  - skill: \"data-analysis\" - invoke the data-analysis skill\n\nImportant:\n- Only use skills listed in <available_skills> below\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n</skills_instructions>\n\n<available_skills>\n<skill>\n<name>\nxlsx-viewer\n</name>\n<description>\nExcel (.xlsx) 文件查询和分析工具。使用场景：查看配置数据、分析 Excel 文件内容、搜索特定表格内容、提取表格数据。触发关键词：查看xlsx、搜索excel、查询配置、xlsx查看、表格搜索、配置数据、找找配置\n</description>\n<location>\nproject\n</location>\n</skill>\n<skill>\n<name>\nunity-log\n</name>\n<description>\n查询 Unity 编辑器日志与截图 Game 视图. 触发关键词:Unity:日志,Unity log,Unity:截图,Unity screenshot\n</description>\n<location>\nproject\n</location>\n</skill>\n<skill>\n<name>\nunity-k3-prefab\n</name>\n<description>\nK3框架预制体查询与编辑工具. 触发关键词:Unity,K3预制体,K3 prefab,K3UI,UI\n</description>\n<location>\nproject\n</location>\n</skill>\n</available_skills>",
    "input_schema": {
      "type": "object",
      "properties": {
        "skill": {
          "type": "string",
          "description": "The skill id (no arguments). E.g., \"pdf\", \"data-analysis\", or \"helloagents/analyze\""
        }
      },
      "required": [
        "skill"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    }
  }
]


显然是工具搜索后出现了多个重复的工具
还需要注意,先要看一看已经有了哪些工具,避免搜索出来的工具重复添加,也会造成最终发送出去的工具重复.