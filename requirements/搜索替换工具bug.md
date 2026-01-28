Agent有如下调用
"{\"filePath\":\"F:\\\\UnityProject\\\\SL\\\\SL_402\\\\Code\\\\Assets\\\\LuaScripts\\\\Logics\\\\LingShouMiJing\\\\LingShouMiJingDialog.txt\",\"replaceContent\":\"function dialog:OnScriptMsg(packagenum, msg)\\n\\tUnityEngine.Debug.Log(\\\"[LingShouMiJing] OnScriptMsg packagenum:\\\" .. packagenum .. \\\" info:\\\" .. LuaUtils.ReturnLuaTable(msg, \\\"OnScriptMsg\\\"))\\nend\",\"searchContent\":\"function dialog:OnScriptMsg(packagenum, msg)\\n\\tUnityEngine.Debug.Log(\\\"[LingShouMiJing] OnScriptMsg packagenum:\\\" .. packagenum .. \\\" info:\\\" .. LuaUtils.ReturnLuaTable(info, \\\"OnScriptMsg\\\"))\\nend\"}"

搜索编辑工具处理后

 ❆ ✓ filesystem-edit_search

   F:\UnityProject\SL\SL_402\Code\Assets\LuaScripts\Logics\LingShouMiJing\LingShouMiJingDialog.txt (modified) (side-by-side)

   @@ Lines 260-268 @@
   ----------------------------------- OLD------------------------------------ | ----------------------------------- NEW------------------------------------

    260    UnityEngine.Debug.Log("[LingShouMiJing] 刷新奖励列表 数量:" ..      |  260    UnityEngine.Debug.Log("[LingShouMiJing] 刷新奖励列表 数量:" ..
   #rewardList)                                                                  #rewardList)
    261    end                                                                 |  261    end
    262   end                                                                  |  262   end
    263 -                                                                      |
    264   function dialog:OnScriptMsg(packagenum, msg)                         |  263   function dialog:OnScriptMsg(packagenum, msg)
    265 -  UnityEngine.Debug.Log("[LingShouMiJing] OnScriptMsg packagenum:" .. |  264 +  UnityEngine.Debug.Log("[LingShouMiJing] OnScriptMsg packagenum:" ..
   packagenum .. " info:" .. LuaUtils.ReturnLuaTable(info, "OnScriptMsg"))       packagenum .. " info:" .. LuaUtils.ReturnLuaTable(msg, "OnScriptMsg"))
    266   end                                                                  |  265   end
                                                                               |  266 + end
    267                                                                        |  267
    268   return dialog                                                        |  268   return dialog


我看调用其实似乎没问题,但实际替换就是在 266行多了个 end

得看看搜索替换逻辑是否有误

source/mcp/filesystem.ts:2294