 ❆ ⚡ ace-text_search
   ├─ pattern: "AGENTS.md"
   ├─ isRegex: false
   └─ maxResults: 20

 ❆ ⚡ ace-text_search
   ├─ pattern: "SiShangjiangli_config"
   ├─ isRegex: false
   ├─ fileGlob: "Code/Assets/LuaScripts/**/*.txt"
   └─ maxResults: 50

 ❆ 思考中...(gpt-5.3-codex · 7m 38s · ↓ 0 tokens)

上面这种情况是工具正在运行

❆ ⚇✓ filesystem-read
     └─ Read 144 lines of 2254 total

 ❆ ⚇✓ filesystem-read
     └─ Read 131 lines of 2254 total

 ❆ 思考中...(gpt-5.3-codex · 23m 22s · ↓ 0 tokens)

上面这种情况是工具已经运行结束

但此时的进度显示都是思考中,容易产生歧义。当工具正在运行时，或还没真正发送api前都应显示为“工作中”。
