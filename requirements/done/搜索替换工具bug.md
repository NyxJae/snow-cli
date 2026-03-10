"name": "filesystem-edit_search",
"arguments": "{\"filePath\":\"F:/Projects/snow-cli/source/utils/execution/toolExecutor.ts\",

\"searchContent\":\"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';\\nimport type {ImageContent} from '../../api/types.js';\\nimport type {MultimodalContent} from '../../mcp/types/filesystem.types.js';\\n//安全解析 JSON，处理可能被拼接的多个 JSON 对象\\nfunction safeParseToolArguments(argsString: string): Record<string, any> {\\n\",

\"replaceContent\":\"import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';\\nimport type {ImageContent} from '../../api/types.js';\\nimport type {MultimodalContent} from '../../mcp/types/filesystem.types.js';\\n\\n// 临时调试日志(工具执行链路),写入项目启动目录下的 snow-image-debug.log.\\n// 注意:日志可能非常大,仅用于本地排障.\\nimport fs from 'fs';\\nimport path from 'path';\\n\\nconst TOOL_DEBUG_LOG_PATH = path.resolve(process.cwd(), 'snow-image-debug.log');\\n\\nfunction appendToolDebugLog(event: string, payload: any): void {\\n\\ttry {\\n\\t\\tfs.appendFileSync(\\n\\t\\t\\tTOOL_DEBUG_LOG_PATH,\\n\\t\\t\\tJSON.stringify(\\n\\t\\t\\t\\t{\\n\\t\\t\\t\\t\\tts: new Date().toISOString(),\\n\\t\\t\\t\\t\\tevent,\\n\\t\\t\\t\\t\\tpayload,\\n\\t\\t\\t\\t},\\n\\t\\t\\t\\tnull,\\n\\t\\t\\t\\t2,\\n\\t\\t\\t) + '\\\\n\\\\n',\\n\\t\\t\\t'utf8',\\n\\t\\t);\\n\\t} catch {\\n\\t\\t// 忽略日志错误,不能影响工具执行\\n\\t}\\n}\\n\\n//安全解析 JSON，处理可能被拼接的多个 JSON 对象\\nfunction safeParseToolArguments(argsString: string): Record<string, any> {\\n\"}"
}

F:/Projects/snow-cli/source/utils/execution/toolExecutor.ts (modified) (side-by-side)

@@ Lines 5-13 @@
----------------------------------- OLD ------------------------------------ |----------------------------------- NEW ------------------------------------

      5   import type {ConfirmationResult} from                                 |   5   import type {ConfirmationResult} from

'../../ui/components/tools/ToolConfirmation.js'; '../../ui/components/tools/ToolConfirmation.js';
6 import type {ImageContent} from '../../api/types.js'; | 6 import type {ImageContent} from '../../api/types.js';
7 import type {MultimodalContent} from | 7 import type {MultimodalContent} from
'../../mcp/types/filesystem.types.js'; '../../mcp/types/filesystem.types.js';
| 8 +
| 9 + // 临时调试日志(工具执行链路),写入项目启动目录下的
snow-image-debug.log.
| 10 + // 注意:日志可能非常大,仅用于本地排障.
| 11 + import fs from 'fs';
| 12 + import path from 'path';
| 13 +
| 14 + const TOOL_DEBUG_LOG_PATH = path.resolve(process.cwd(),
'snow-image-debug.log');
| 15 +
| 16 + function appendToolDebugLog(event: string, payload: any): void {  
 | 17 + try {
| 18 + fs.appendFileSync(
| 19 + TOOL_DEBUG_LOG_PATH,
| 20 + JSON.stringify(
| 21 + {
| 22 + ts: new Date().toISOString(),
| 23 + event,
| 24 + payload,
| 25 + },
| 26 + null,
| 27 + 2,
| 28 + ) + '\n\n',
| 29 + 'utf8',
| 30 + );
| 31 + } catch {
| 32 + // 忽略日志错误,不能影响工具执行
| 33 + }
| 34 + }
| 35 +
8 //安全解析 JSON，处理可能被拼接的多个 JSON 对象 | 36 //安全解析 JSON，处理可能被拼接的多个 JSON 对象
9 function safeParseToolArguments(argsString: string): Record<string, | 37 function safeParseToolArguments(argsString: string): Record<string,  
 any> { any> {
10 - if (!argsString || argsString.trim() === '') { | 38 +
11 return {}; | 39 return {};
12 } | 40 }
13 | 41

     37 行误被删除了

例子 1

## 复现方法(误删下一行)

### 现象

- 当 `searchContent` 末尾带一个额外换行时,`filesystem-edit_search` 在某些长度场景会把下一行也吃进匹配范围,最终导致下一行被误删.
- 短文本场景常见表现是 `Search content not found`,长文本场景可能编辑成功但误删.

### 最小复现脚本

在项目根目录执行:

```bash
node --loader ts-node/esm --input-type=module <<'EOF'
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FilesystemMCPService} from './source/mcp/filesystem.ts';

async function reproCase(name, fillerLines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snow-misdel-'));
  const file = path.join(dir, 't.ts');
  const filler = Array.from({length: fillerLines}, (_, i) => `// filler-${i + 1}`);

  const originalLines = [
    "import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';",
    "import type {ImageContent} from '../../api/types.js';",
    "import type {MultimodalContent} from '../../mcp/types/filesystem.types.js';",
    ...filler,
    '//安全解析JSON，处理可能被拼接的多个JSON对象',
    'function safeParseToolArguments(argsString: string): Record<string, any> {',
    "\tif (!argsString || argsString.trim() === '') {",
    '\t\treturn {};',
    '\t}',
    '}',
    '',
  ];

  const searchContent = [
    "import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';",
    "import type {ImageContent} from '../../api/types.js';",
    "import type {MultimodalContent} from '../../mcp/types/filesystem.types.js';",
    ...filler,
    '//安全解析JSON，处理可能被拼接的多个JSON对象',
    'function safeParseToolArguments(argsString: string): Record<string, any> {',
    '', // 关键: 末尾空行,等价于参数字符串最后有 \n
  ].join('\n');

  const replaceContent = [
    "import type {ConfirmationResult} from '../../ui/components/tools/ToolConfirmation.js';",
    "import type {ImageContent} from '../../api/types.js';",
    "import type {MultimodalContent} from '../../mcp/types/filesystem.types.js';",
    ...filler,
    '',
    "import fs from 'fs';",
    "import path from 'path';",
    '',
    '//安全解析JSON，处理可能被拼接的多个JSON对象',
    'function safeParseToolArguments(argsString: string): Record<string, any> {',
    '',
  ].join('\n');

  await fs.writeFile(file, originalLines.join('\n'), 'utf8');
  const service = new FilesystemMCPService(dir);

  try {
    const result = await service.editFileBySearch('t.ts', searchContent, replaceContent);
    const out = await fs.readFile(file, 'utf8');
    const deleted = !out.includes("if (!argsString || argsString.trim() === '') {");
    console.log(`${name}: EDIT_OK deleted_if_line=${deleted}`);
    console.log(`${name}: match=${result.matchLocation.startLine}-${result.matchLocation.endLine}`);
  } catch (error) {
    const msg = String(error);
    const notFound = msg.includes('Search content not found');
    console.log(`${name}: EDIT_FAIL notFound=${notFound}`);
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

for (const n of [0, 3, 8, 15, 30, 60]) {
  await reproCase(`filler_${n}`, n);
}
EOF
```

### 预期输出特征

- `filler_0/3/8` 常见 `EDIT_FAIL notFound=true`.
- `filler_15/30/60` 常见 `EDIT_OK deleted_if_line=true`.
- 一旦出现 `deleted_if_line=true`,即说明发生了“误删下一行”.
