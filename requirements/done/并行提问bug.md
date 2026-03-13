<!-- 当Agent 并行调用提问工具时
只弹出一个提问,用户回答后不会弹出第二个提问
导致卡死,esc也无法打断了 -->
<!-- 
并行调用两个子代理,让他们每人提个问题
用户回答第一个问题后,第二个问题没有弹出,卡主了

 ❯  通过了,只是我打断了子代理    你再试试 并行调用两个子代理,让他们每人提个问题      

 ❆ ⚡ subagent-agent_general
   └─ prompt: "你是子代理A. 请只做一件事: 实际调用一次 `askuser-ask_question`        
   工具,向用户提1个问题并给出..."

 ❆ ⚡ subagent-agent_general
   └─ prompt: "你是子代理B. 请只做一件事: 实际调用一次 `askuser-ask_question`        
   工具,向用户提1个问题并给出..."

 ❆ ⚇⚡ askuser-ask_question (question: "为便于我们快速定位这个bug,如果短期内无法彻底 
   修复,你更能接受哪种“降级/兜底策略”来保证你还能继续用(类似于App先...", options:    
   <array with 4 items>)

 ❆ ⚇⚡ askuser-ask_question (question: "为了并行定位你反馈的bug/异常体验,你现在最方便
   提供哪种“复现材料/使用感受”给我们?这能帮助我们快速还原现场并判断是...", options:  
   <array with 5 items>)

 ❆ ⚇✓ askuser-ask_question
     ├─ answer: 我可以提供: 复现步骤(从启动到出现问题...
     └─ selected: 我可以提供: 复现步骤(从启动到出现问题... -->