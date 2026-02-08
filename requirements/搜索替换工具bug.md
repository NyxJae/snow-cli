
  "name": "filesystem-edit_search",
  "arguments": "{\"filePath\":\"F:/Projects/snow-cli/source/utils/execution/toolExecutor.ts\",
  
  \"searchContent\":\"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';\\nimport type {ImageContent} from '../../api/types.js';\\nimport type {MultimodalContent} from '../../mcp/types/filesystem.types.js';\\n//安全解析JSON，处理可能被拼接的多个JSON对象\\nfunction safeParseToolArguments(argsString: string): Record<string, any> {\\n\",
  
  \"replaceContent\":\"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';\\nimport type {ImageContent} from '../../api/types.js';\\nimport type {MultimodalContent} from '../../mcp/types/filesystem.types.js';\\n\\n// 临时调试日志(工具执行链路),写入项目启动目录下的 snow-image-debug.log.\\n// 注意:日志可能非常大,仅用于本地排障.\\nimport fs from 'fs';\\nimport path from 'path';\\n\\nconst TOOL_DEBUG_LOG_PATH = path.resolve(process.cwd(), 'snow-image-debug.log');\\n\\nfunction appendToolDebugLog(event: string, payload: any): void {\\n\\ttry {\\n\\t\\tfs.appendFileSync(\\n\\t\\t\\tTOOL_DEBUG_LOG_PATH,\\n\\t\\t\\tJSON.stringify(\\n\\t\\t\\t\\t{\\n\\t\\t\\t\\t\\tts: new Date().toISOString(),\\n\\t\\t\\t\\t\\tevent,\\n\\t\\t\\t\\t\\tpayload,\\n\\t\\t\\t\\t},\\n\\t\\t\\t\\tnull,\\n\\t\\t\\t\\t2,\\n\\t\\t\\t) + '\\\\n\\\\n',\\n\\t\\t\\t'utf8',\\n\\t\\t);\\n\\t} catch {\\n\\t\\t// 忽略日志错误,不能影响工具执行\\n\\t}\\n}\\n\\n//安全解析JSON，处理可能被拼接的多个JSON对象\\nfunction safeParseToolArguments(argsString: string): Record<string, any> {\\n\"}"
}
   

F:/Projects/snow-cli/source/utils/execution/toolExecutor.ts (modified) (side-by-side)

   @@ Lines 5-13 @@
   ----------------------------------- OLD ------------------------------------ |----------------------------------- NEW ------------------------------------ 

      5   import type {ConfirmationResult} from                                 |   5   import type {ConfirmationResult} from
   '../../ui/components/tools/ToolConfirmation.js';                              '../../ui/components/tools/ToolConfirmation.js';
      6   import type {ImageContent} from '../../api/types.js';                 |   6   import type {ImageContent} from '../../api/types.js';
      7   import type {MultimodalContent} from                                  |   7   import type {MultimodalContent} from
   '../../mcp/types/filesystem.types.js';                                        '../../mcp/types/filesystem.types.js';
                                                                                |   8 + 
                                                                                |   9 + // 临时调试日志(工具执行链路),写入项目启动目录下的 
                                                                                 snow-image-debug.log.
                                                                                |  10 + // 注意:日志可能非常大,仅用于本地排障.
                                                                                |  11 + import fs from 'fs';
                                                                                |  12 + import path from 'path';
                                                                                |  13 + 
                                                                                |  14 + const TOOL_DEBUG_LOG_PATH = path.resolve(process.cwd(), 
                                                                                 'snow-image-debug.log');
                                                                                |  15 + 
                                                                                |  16 + function appendToolDebugLog(event: string, payload: any): void {      
                                                                                |  17 +  try {
                                                                                |  18 +  fs.appendFileSync(
                                                                                |  19 +  TOOL_DEBUG_LOG_PATH,
                                                                                |  20 +  JSON.stringify(
                                                                                |  21 +  {
                                                                                |  22 +  ts: new Date().toISOString(),
                                                                                |  23 +  event,
                                                                                |  24 +  payload,
                                                                                |  25 +  },
                                                                                |  26 +  null,
                                                                                |  27 +  2,
                                                                                |  28 +  ) + '\n\n',
                                                                                |  29 +  'utf8',
                                                                                |  30 +  );
                                                                                |  31 +  } catch {
                                                                                |  32 +  // 忽略日志错误,不能影响工具执行
                                                                                |  33 +  }
                                                                                |  34 + }
                                                                                |  35 + 
      8   //安全解析JSON，处理可能被拼接的多个JSON对象                          |  36   //安全解析JSON，处理可能被拼接的多个JSON对象
      9   function safeParseToolArguments(argsString: string): Record<string,   |  37   function safeParseToolArguments(argsString: string): Record<string,   
   any> {                                                                        any> {
     10 -  if (!argsString || argsString.trim() === '') {                       |  38 + 
     11    return {};                                                           |  39    return {};
     12    }                                                                    |  40    }
     13                                                                         |  41




     37 行误被删除了


例子 1