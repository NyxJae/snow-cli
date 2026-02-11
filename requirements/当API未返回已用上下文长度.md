有时有些渠道不返回已用上下文长度,或上下文长度不合理
比如 
{
  "id": "msg_01Ff7rpFtzAHLDP5HkD6D1QB",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "toolu_01GWHkiWjpM8kkBd6WnoqDsE",
            "type": "function",
            "function": {
              "name": "filesystem-read",
              "arguments": "{\"filePath\": \"Code/Assets/LuaScripts/Logics/Daily/DailyDialog.txt\", \"startLine\": 200, \"endLine\": 227}"
            },
            "index": 0
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "object": "chat.completion",
  "created": 0,
  "model": "claude-opus-4-6",
  "usage": {
    "cache_creation_input_tokens": 35284,
    "prompt_tokens": 1,
    "completion_tokens": 111,
    "total_tokens": 112,
    "prompt_tokens_details": {
      "audio_tokens": 0,
      "cached_tokens": 12901
    },
    "completion_tokens_details": null
  }
}

{
  "id": "msg_01L6TtMoMPN3abnmTxpYoepj",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "好的, 上次的大块替换已撤销, 现在我需要先读取文件当前状态, 然后逐步小幅精确编辑.",
        "tool_calls": [
          {
            "id": "toolu_01RxSPeFsP2BWRZk2ky5vFUW",
            "type": "function",
            "function": {
              "name": "filesystem-read",
              "arguments": "{\"filePath\": \"F:\\\\UnityProject\\\\SL\\\\SL_402\\\\Code\\\\Assets\\\\Editor\\\\UnityAgentSkills\\\\SkillsExporter\\\\SkillConfigs\\\\SkillConfig_UnityK3Prefab.cs\"}"
            },
            "index": 0
          },
          {
            "id": "toolu_01GnRKN78TyhrNwMb62VE9pB",
            "type": "function",
            "function": {
              "name": "filesystem-read",
              "arguments": "{\"filePath\": \"F:\\\\UnityProject\\\\SL\\\\SL_402\\\\CurrentTaskPlan.md\"}"
            },
            "index": 1
          }
        ],
        "reasoning_content": "The user wants me to continue the task of modifying `SkillConfig_UnityK3Prefab.cs`. The previous large replacement was undone, and now I need to make small, precise edits one at a time. Let me first read the current state of the file to understand what needs to be changed."
      },
      "finish_reason": "tool_calls"
    }
  ],
  "object": "chat.completion",
  "created": 0,
  "model": "claude-opus-4-6",
  "usage": {
    "cache_creation_input_tokens": 42181,
    "prompt_tokens": 10,
    "completion_tokens": 288,
    "total_tokens": 298,
    "prompt_tokens_details": {
      "audio_tokens": 0,
      "cached_tokens": 0
    },
    "completion_tokens_details": null
  }
}

{
  "id": "d79374edc55d4dc92c8b096cc66920f9",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "filesystem-read:73",
            "type": "function",
            "function": {
              "name": "filesystem-read",
              "arguments": "{\"filePath\": \"F:/UnityProject/SL/SL_402/Code/Assets/Editor/UnityAgentSkills/Plugins/Prefab\"}"
            },
            "index": 0
          }
        ],
        "reasoning_content": "现在我发现 Prefab 插件文件夹没有笔记.我需要先探索一下现有的代码结构,然后规划制作计划并更新蓝图笔记.让我先查看 Prefab 插件的代码结构."
      },
      "finish_reason": "tool_calls"
    }
  ],
  "object": "chat.completion",
  "created": 1770725443,
  "model": "kimi-k2.5",
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "prompt_tokens_details": {
      "audio_tokens": 0,
      "cached_tokens": 0
    },
    "completion_tokens_details": null
  },
  "system_fingerprint": "fpv0_d4e01072"
}


因为系统提示词+角色定义+工具等,基本上就快10k了
如果少于1k token 我们就不用上游返回的,而是自己本地预估
否则会导致上下文超限
我尚不清楚本地预估token 时机哪里合适
可能是发送了api请求后,一边等待返回,一边计算token
或者是收到了api返回后,再计算token

你看看项目有没有类似逻辑
一定要看看 上下文压缩的逻辑,预估上下文长度,主要是为了上下文压缩



还是出现底部状态栏刚刚有计算出的token,然后又变回0 了

 │❆ ✓ filesystem-read
    └─ filePath: "f:/Projects/snow-cli/source"
      └─ Read 15 lines (lines 1-13)
 └─ 执行完成

 ❆ 思考中...(K2.5 · 27s · ↓ 0 tokens)

 ──────────────────────────────────────────────────────────────────────────────────────────── 
 ❯  询问我有关编程的任何问题...
 ──────────────────────────────────────────────────────────────────────────────────────────── 

  TODO (0/0)

 0.0% · 0 个token