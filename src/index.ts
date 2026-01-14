#!/usr/bin/env node
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY AI ASSISTANT v24.0 - CLAUDE POWERED");
console.log("==========================================================");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const CLARITY_BASE_URL = process.env.CLARITY_BASE_URL || 'http://16.16.83.171/ppm/rest/v1';

console.log('🌐 Clarity URL:', CLARITY_BASE_URL);
console.log('🤖 AI: Claude Sonnet 4');
console.log('🔑 Auth: Browser session');

let cachedObjects: any = null;
let cachedAttributes: Map<string, any> = new Map();

// Store pending tool calls waiting for browser response
const pendingToolCalls = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timeout: NodeJS.Timeout;
}>();

// ============================================================================
// AI TOOLS
// ============================================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_objects',
      description: 'STEP 1: Get list of ALL available Clarity objects. Use this FIRST to discover what objects exist. Returns system objects (projects, tasks, resources, ideas, objectives, etc.) AND custom objects (custXxx). This is your starting point for ANY query.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_object_attributes',
      description: 'STEP 2: Get complete schema. Returns ALL fields with EXACT names you MUST use. ⚠️ CRITICAL: Use these exact field names in queries! Common mistakes: "code" → use "projectCode"/"resourceCode"/"taskCode" instead.',
      parameters: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description: 'Exact name from get_objects (plural: "projects", "tasks", "resources")'
          }
        },
        required: ['objectName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_object',
      description: 'STEP 3: Query actual data from an object. Returns ALL matching records (no pagination). Use exact field names from get_object_attributes. Apply filters to narrow results. This is how you get the actual data to answer the user.',
      parameters: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description: 'Object name from get_objects (plural form: "projects", "tasks", etc.)'
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact field names from get_object_attributes. Include all fields needed to answer the user.'
          },
          filter: {
            type: 'string',
            description: 'Optional Clarity NSQL filter. Examples: (status = "Open"), (department = "IT"), (finishDate < @today@). Leave empty for all records.'
          }
        },
        required: ['objectName', 'fields']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_project_tasks',
      description: '🚀 Get tasks for a specific project using nested endpoint. MUCH FASTER than filtering! First get project ID, then call this with the ID.',
      parameters: {
        type: 'object',
        properties: {
          projectId: {
            type: 'number',
            description: 'Project internal ID (get from projects query first)'
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task fields to return (e.g., ["name", "status", "percentComplete"])'
          },
          filter: {
            type: 'string',
            description: 'Optional filter for tasks'
          }
        },
        required: ['projectId', 'fields']
      }
    }
  }
];

// ============================================================================
// TOOL HANDLERS - Request browser execution
// ============================================================================
async function handleToolCall(toolCall: any, send: (data: any) => void): Promise<string> {
  const { name, arguments: args } = toolCall.function;
  const parsedArgs = JSON.parse(args);
  
  console.log(`[Tool] ${name}`);
  console.log(`[Tool] Args:`, parsedArgs);
  
  let endpoint = '';
  
  switch (name) {
    case 'get_objects':
      // Check cache first
      if (cachedObjects) {
        console.log('[Cache] Using cached objects');
        return JSON.stringify(cachedObjects);
      }
      endpoint = '/ppm/rest/v1/describe?filter=((extensions in (\'inv\')))';
      break;
      
    case 'get_object_attributes':
      const { objectName } = parsedArgs;
      
      // Check cache first
      if (cachedAttributes.has(objectName)) {
        console.log(`[Cache] Using cached attributes for ${objectName}`);
        return JSON.stringify(cachedAttributes.get(objectName));
      }
      
      endpoint = `/ppm/rest/v1/describeAttributes?filter=(resourceName+%3D+%27${objectName}%27)`;
      break;
      
    case 'get_project_tasks':
      const { projectId, fields: taskFields, filter: taskFilter } = parsedArgs;
      
      // Use nested endpoint: /projects/{projectId}/tasks
      const taskFieldsParam = taskFields.join(',');
      const taskFilterParam = taskFilter ? `&filter=${encodeURIComponent(taskFilter)}` : '';
      endpoint = `/ppm/rest/v1/projects/${projectId}/tasks?fields=${taskFieldsParam}${taskFilterParam}`;
      break;
      
    case 'query_object':
      const { objectName: obj, fields, filter } = parsedArgs;
      
      // Pluralize common object names
      const pluralMap: { [key: string]: string } = {
        'project': 'projects',
        'task': 'tasks',
        'resource': 'resources',
        'idea': 'ideas',
        'objective': 'objectives'
      };
      const objectPath = pluralMap[obj.toLowerCase()] || obj;
      
      const fieldsParam = fields.join(',');
      const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : '';
      endpoint = `/ppm/rest/v1/${objectPath}?fields=${fieldsParam}${filterParam}`;
      break;
      
    default:
      return `Unknown tool: ${name}`;
  }
  
  // Generate unique request ID
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`[Request ${requestId}] Sending to browser: ${endpoint}`);
  
  // Send command to browser
  send({
    type: 'client_execute',
    requestId: requestId,
    data: {
      url: endpoint,
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'x-api-concrete-object-code': 'false',
        'x-api-filter-ignore-timestamp': 'true',
        'x-api-include-auth': 'true',
        'x-api-include-instance-info': 'true',
        'x-api-rule-engine': 'ui',
        'x-api-virtual-rows': 'false'
      }
    }
  });
  
  // Wait for browser response (with timeout)
  const result: string = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingToolCalls.delete(requestId);
      reject(new Error('Browser execution timeout (30s)'));
    }, 30000); // 30 second timeout
    
    pendingToolCalls.set(requestId, { resolve, reject, timeout });
  });
  
  // Cache results for get_objects and get_object_attributes
  if (name === 'get_objects' && !cachedObjects) {
    cachedObjects = JSON.parse(result);
    console.log('[Cache] Stored objects');
  } else if (name === 'get_object_attributes') {
    const { objectName } = parsedArgs;
    if (!cachedAttributes.has(objectName)) {
      cachedAttributes.set(objectName, JSON.parse(result));
      console.log(`[Cache] Stored attributes for ${objectName}`);
    }
  }
  
  return result;
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, send: (data: any) => void) {
  const messages: any[] = [
    {
      role: 'system',
      content: `You are a Clarity PPM AI assistant. ULTRA CONCISE - ONE SENTENCE ONLY.

CRITICAL RULES:
1. Results are CACHED - don't call same tool twice!
2. If field gives 400 error - IMMEDIATELY try 'id' or 'name' field
3. If 3rd attempt fails - ANSWER WITH WHAT YOU HAVE
4. NEVER explain errors to user - just give best answer possible
5. ONE SENTENCE MAX - no explanations!

COMMON FIELDS (These work - verified):
**Tasks**: name, taskCode, start, finish, percentComplete, status, investmentId
**Projects**: name, code, manager, status, investmentId
**Resources**: fullName, resourceCode, emailAddress

⚠️ FIELDS THAT DON'T WORK:
- 'id' is SECURED on most objects - use 'name' or specific code fields instead
- 'projectCode' doesn't exist on projects - use 'code' instead
- 'taskCode' might be secured - use 'name' instead for counting

FALLBACK STRATEGY:
- Attempt 1: Try requested fields
- Attempt 2: If 400 error → Try ['id'] only  
- Attempt 3: If still fails → Answer "Unable to access this data"
- STOP - Don't waste more attempts!

OVERDUE TASKS STRATEGY:
1. Try: query_object('tasks', ['id'], '(finish < @today@) and (percentComplete < 100)')
2. If fails: query_object('tasks', ['id'], '(percentComplete < 100)') 
3. Answer with what you got: "X incomplete tasks (finish date not accessible)"

🚨 FOR TASKS IN A SPECIFIC PROJECT - USE get_project_tasks:

Step 1: Get project ID  
  query_object('projects', ['id'], '(code = "PROJECT_NAME")')
  Example result: {"id": 5004001}

Step 2: Use get_project_tasks with the ID
  get_project_tasks(projectId: 5004001, fields: ['name'])

This uses the nested endpoint: /projects/5004001/tasks
🚨 THIS IS THE FASTEST AND MOST RELIABLE WAY!

Example:
User: "how many tasks in this_proj"
Step 1: query_object('projects', ['id'], '(code = "this_proj")')
        → Got id: 5004001
Step 2: get_project_tasks(5004001, ['name'])
        → "**367 tasks** in this_proj."

EXAMPLES (FOLLOW EXACTLY):

Simple count:
User: "how many projects"
→ query_object('projects', ['name'])
→ "**41 projects**."

Tasks in project (USE get_project_tasks):
User: "tasks in this_proj"
→ Step 1: query_object('projects', ['id'], '(code = "this_proj")')
   Result: id = 5004001
→ Step 2: get_project_tasks(5004001, ['name'])
→ "**367 tasks** in this_proj."

Distribution (USE get_project_tasks):
User: "distribution of tasks in this_proj"
→ Step 1: query_object('projects', ['id'], '(code = "this_proj")')
   Result: id = 5004001  
→ Step 2: get_project_tasks(5004001, ['status'])
→ "**367 tasks**: 354 Not Started, 4 Started, 9 Completed."

Filtered tasks in project (USE get_project_tasks with filter):
User: "started tasks in this_proj"
→ Step 1: query_object('projects', ['id'], '(code = "this_proj")')
   Result: id = 5004001
→ Step 2: get_project_tasks(5004001, ['name'], '(status = "Started")')
→ "**4 started tasks** in this_proj."

Simple filter (no project):
User: "IT resources"  
→ query_object('resources', ['fullName'], '(departmentCode = "IT")')
→ "**5 resources** in IT."

RULES:
- ONE SENTENCE
- NO EXPLANATIONS
- GIVE BEST ANSWER POSSIBLE
- STOP AFTER 3 ATTEMPTS PER QUERY`
    },
    {
      role: 'user',
      content: userMessage
    }
  ];
  
  send({ type: 'thinking', data: 'Processing...' });
  
  let iterations = 0;
  const maxIterations = 15; // Increased from 10
  
  while (iterations < maxIterations) {
    iterations++;
    
    let retries = 0;
    const maxRetries = 3;
    let response;
    
    // Retry loop for rate limits
    while (retries < maxRetries) {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8096,
          messages: messages.filter((m: any) => m.role !== 'system'),
          system: messages.find((m: any) => m.role === 'system')?.content || '',
          tools: tools.map((t: any) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters
          }))
        })
      });
      
      // Handle rate limit (429)
      if (response.status === 429) {
        retries++;
        const waitTime = Math.pow(2, retries) * 2000; // Longer backoff: 4s, 8s, 16s
        console.log(`[Retry ${retries}/${maxRetries}] Rate limited, waiting ${waitTime}ms...`);
        
        if (retries < maxRetries) {
          send({ type: 'thinking', data: `Rate limited, waiting ${waitTime/1000}s...` });
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        } else {
          throw new Error('Rate limit exceeded. Please wait 1 minute and try again.');
        }
      }
      
      // Success or other error - break retry loop
      break;
    }
    
    if (!response || !response.ok) {
      const errorText = response ? await response.text() : 'unknown';
      throw new Error(`Claude API error: ${response?.status || 'unknown'} - ${errorText}`);
    }
    
    const data: any = await response.json();
    
    // Claude response format
    if (data.stop_reason === 'tool_use') {
      // First, add the assistant message with tool_use
      messages.push({
        role: 'assistant',
        content: data.content
      });
      
      // Find tool use blocks
      const toolUseBlocks = data.content.filter((block: any) => block.type === 'tool_use');
      
      // Collect all tool results
      const toolResults: any[] = [];
      
      for (const toolBlock of toolUseBlocks) {
        const toolName = toolBlock.name;
        send({ type: 'tool_call', data: `Requesting browser: ${toolName}` });
        
        try {
          // Create OpenAI-style tool call for compatibility
          const toolCall = {
            id: toolBlock.id,
            function: {
              name: toolBlock.name,
              arguments: JSON.stringify(toolBlock.input)
            }
          };
          
          const result = await handleToolCall(toolCall, send);
          console.log(`[Tool Result] Got ${result.length} chars`);
          
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: result
          });
        } catch (error: any) {
          console.error(`[Tool Error]`, error.message);
          
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: `Error: ${error.message}`,
            is_error: true
          });
        }
      }
      
      // Add all tool results in one user message
      messages.push({
        role: 'user',
        content: toolResults
      });
      
      continue;
    }
    
    if (data.stop_reason === 'end_turn' || data.stop_reason === 'stop_sequence') {
      // Extract text from content blocks
      const textBlocks = data.content.filter((block: any) => block.type === 'text');
      const responseText = textBlocks.map((block: any) => block.text).join('\n');
      
      send({ type: 'complete', data: responseText });
      break;
    }
  }
  
  if (iterations >= maxIterations) {
    send({ type: 'error', data: 'Max iterations reached' });
  }
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '20.0.0-browser-exec',
    mode: 'browser-execution-with-response',
    clarity: CLARITY_BASE_URL,
    auth: 'browser-session',
    timestamp: new Date().toISOString()
  });
});

// Endpoint for browser to send back results
app.post('/api/tool-response', (req, res) => {
  const { requestId, success, data, error } = req.body;
  
  console.log(`[Response ${requestId}] Received from browser`);
  
  const pending = pendingToolCalls.get(requestId);
  
  if (pending) {
    clearTimeout(pending.timeout);
    pendingToolCalls.delete(requestId);
    
    if (success) {
      console.log(`[Response ${requestId}] Success`);
      pending.resolve(JSON.stringify(data));
    } else {
      console.log(`[Response ${requestId}] Error: ${error}`);
      pending.reject(new Error(error || 'Browser execution failed'));
    }
    
    res.json({ received: true });
  } else {
    console.log(`[Response ${requestId}] Not found or already processed`);
    res.json({ received: false, reason: 'Request not found' });
  }
});

const PORT = parseInt(process.env.PORT || '3001');
const HOST = '0.0.0.0';

app.post('/api/chat', async (req, res) => {
  console.log('[Chat] Request received');
  
  const { message } = req.body;

  if (!message) {
    console.error('[Chat] Missing message');
    res.status(400).json({ error: 'Missing message' });
    return;
  }

  console.log('[Chat] Message:', message);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const send = (d: any) => {
    console.log('[Send]', d.type);
    res.write(`data: ${JSON.stringify(d)}\n\n`);
  };

  try {
    await runAIAgentLoop(message, send);
  } catch (e: any) {
    console.error('[Chat] Error:', e);
    send({ type: 'error', data: e.message });
  }

  res.end();
  console.log('[Chat] Done');
});

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 CLARITY MCP v20.0 - BROWSER EXECUTION`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔌 Mode: Browser executes, server waits for response`);
  console.log(`🌐 Clarity: ${CLARITY_BASE_URL}`);
  console.log(`🔑 Auth: Browser session cookies (automatic)`);
  console.log('==========================================================');
  console.log('');
  console.log('✅ Server Ready - Browser will execute and respond');
  console.log('');
});
