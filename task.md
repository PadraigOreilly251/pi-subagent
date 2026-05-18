# Modifying the existing pi subagent code to fit a llama.cpp driven system

You are currently in a repository that is an open source implementation of pi-subagents. It wont currently work for our tasks due to tricky context invalidation due to local LLMs.

Several implementations of sub-agents used by `pi` will often operate solely under the assumption that all sub agents either:
    - are cloud models with no prompt processing penalities
    - are operating on a different llama.cpp slot (hence not sharing kv cache on VRAM)

You are running locally on my computer, taking up my VRAM in combination with your kv cache. This means that cache corruption due to system prompt changes will force full prompt reprocessing.

Here is a practical example:

- We are in a pi coding session
- Your kv cache can store up to 150k kv token pairs that have already been computed. 
- Each kv slot represents an input prompt that gets tokenized (the k) and the LLMs (you) output tokenized
- So after 20-30 prompts, with many actions taken, the kv size can be large. 
- LLMs are stateless, thus if the input/ouput chain looks like: i1 -> o1 -> i2 -> o2 -> i3 -> o3 then for i4, we MUST recreate the entire state starting from i1. If you just pass in i4 by itself, the entire tokenization/vectors change
- llama.cpp is smart, since the newest prompt depends on all of the previous ones, llama.cpp will simply use the latest state from o3 to perform 1 forward pass for i4, meaning no prompt reprocessing

Here's where things go wrong (three ways):

First:
- You spawn a sub-agent, and the plugin that we are using will modify the system prompt + include all context (when in fork mode)
- This means that the sub-agent will then have to reprocess the entire prompt and invalidate the kv cache
- Then when it finishes and returns to the main agent (you) because the previous kv cache was invalidated, llama.cpp reprocesses everything (if i1 is changed, then o1-on and i1-in are all invalid)

Second:
- You spawn a sub-agent, but the sub agent only inherits chat context (stable kv kept)
- Sub agent finishes working quickly because nothing was fully reprocessed, returns results to main agent
- The plugin updates the MAIN AGENTS system prompt indicating that it has a sub-agent, thus breaking all of the kv cache. 

Third:
- Sub agent spawns with NO previous context, invalidates kv cache, bad news

The fix that I want:

- Any sub agent that is spawned MUST inherit the exact same system prompt and conversation history as the main agent
- A sub agent that finishes its task will return the results to the main agent
- For the entire sub-agent run, here was the kv cache:
    - [main agent kv cache state] -> [sub agent NEW kv cache state]
- But now the main agent has a stale kv cache right? Yes, BUT llama.cpp saves the day:
    - Here is the current kv cache in VRAM after sub agent finishes and responds to main agent
    - [main agent kv cache state] -> [sub agent kv cache state] -> [sub agent result (this is the latest input)]
    - But the main agent actually only sees this from its convo history (missing the stuff the sub-agent saw/did):
    - [main agent kv cache state] -> [sub agent result (this is the latest input)]
    - llama.cpp will systematically find the latest state in the kv cache where the prefixes match, and then only process inputs from that point forward
    - Thus the kv cache becomes: [main agent kv cache state (already computed!)] -> [sub agent result]
    - And only the sub-agent result is computed!

# Core requirements in V1:

- All sub agents will fork from current main agent context (meaning they get the entire previous conversation)
- All sub agents will NOT have a custom system prompt! They will use the exact same system prompt as main agent
- We communicate with sub agents via user messages to inform them of their task
    - Eg: When a sub agent spawns it will see: [all conversation context] -> [SUB-AGENT-TASK: You are operating as a sub-agent to accomplish this task: "task goes here"] <- this is a user message NOT a system or developer message
- When a sub agent is done it will simply send a message back to the main agent with work done and processed for the main agent to read
- Similar to the `[telegram]` tags we have, there will be one more tag introduced: `[sub-agent-task]` and maybe `[sub-agent-response]` if we dont use sub-agents as a tool (not sure yet)
- An example conversation using all three:
    - User: "[telegram]: Can you spawn a sub agent to summarize this directory: /fake/dir"
    - Assistant: "Sure thing!" (this is the latest message in the assistants conversation + future tool call/result below)
    - Tool call: `spawn_forked_subagent("Summarize this directory: /fake/dir")`
    - **BEGIN SUB-AGENT PROCESS** (it sees its task statement as a user message, not via system prompt)
    - User: "[sub-agent-task]: You are operating in sub-agent mode. Complete the following task and send one message with all results and files written (if any) back to the main agent"
    - Assistant: "Absolutely! I'm on it."
    - sub agent makes tool calls and learns about /fake/dir to complete task
    - sub agent finishes and sends message to Assistant as tool result (maybe, architecture might change)
    - **END SUB-AGENT PROCESS**
    - The sub-agents message can either be sent as a user message with the `[sub-agent-response]` tag OR returned as a tool result (preferred)

To start please familiarize yourself with the /home/bbilbro/pi-subagent project. Once you know the code base we will use it as a base and add it to our own pi agent build once modified.

For version 1 start by producing a comprehensive design document that outlines files to be created/modified and the entire start to finish flow of conversations.
It will be a highly technical design doc that can be used in a fresh session to fully implement the sub agent plugin by another agent. 
Questions to answer:
- What should the main agent see as a response from the sub agent? Tool calls, files read, files modified, or just a summary/response?
- What the best approach is for sub agent response: tool call and tool result or a user message tag? I would take inspiration from the pi-agent plugin we are modifying to make this decision.
- Timeout/error handling is important as well. We do not want to break the entire session if a sub agent fails.
- Input arguments to spawn_forked_subagent, not sure yet, make some proposals. 