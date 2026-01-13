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
      description: 'STEP 2: Get complete schema for a specific object. Returns ALL available fields with their types, descriptions, and constraints. ALWAYS call this before querying to know which fields exist. Use exact field names from this response in your queries.',
      parameters: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description: 'Exact name of the object from get_objects (e.g., "projects", "tasks", "resources", "ideas", "custPs")'
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
      endpoint = '/ppm/rest/v1/describe?filter=((extensions in (\'inv\')))';
      break;
      
    case 'get_object_attributes':
      const { objectName } = parsedArgs;
      endpoint = `/ppm/rest/v1/describeAttributes?filter=(resourceName+%3D+%27${objectName}%27)`;
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
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingToolCalls.delete(requestId);
      reject(new Error('Browser execution timeout (30s)'));
    }, 30000); // 30 second timeout
    
    pendingToolCalls.set(requestId, { resolve, reject, timeout });
  });
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, send: (data: any) => void) {
  const messages: any[] = [
    {
      role: 'system',
      content: `You are a Clarity PPM AI assistant. You can work with ANY object in the system.

## MANDATORY WORKFLOW (ALWAYS FOLLOW):

### Step 1: Discover Available Objects
- ALWAYS start with: get_objects()
- Find which object matches user's request
- Objects include: projects, tasks, resources, ideas, objectives, timesheets, risks, issues, portfolios, programs, custom objects, etc.

### Step 2: Learn Object's Fields
- ALWAYS call: get_object_attributes(objectName)
- Get complete list of available fields
- Match user's requested fields to actual field names
- Remember: field names are case-sensitive!

### Step 3: Query Data with Filters
- Call: query_object(objectName, fields, filter)
- Include ALL fields user asked for
- Add filters based on user's conditions
- Returns ALL matching records (no limit)

### Step 4: Present Results
- Format as: table, list, count, chart, summary
- Answer user's question clearly
- Show relevant data

## REAL EXAMPLES:

Example 1: "Show me all resources in Finance department"
1. get_objects() → find: resources
2. get_object_attributes('resources') → fields: name, department, email, role
3. query_object('resources', ['name', 'department', 'email'], '(department = "Finance")')
4. Present: table with name, email

Example 2: "Count how many tasks are overdue"
1. get_objects() → find: tasks
2. get_object_attributes('tasks') → fields: id, finishDate, status
3. query_object('tasks', ['id', 'finishDate'], '(finishDate < @today@) and (status != "Completed")')
4. Present: "Found 23 overdue tasks"

Example 3: "List all ideas with status Open"
1. get_objects() → find: ideas
2. get_object_attributes('ideas') → fields: name, status, submittedBy
3. query_object('ideas', ['name', 'submittedBy'], '(status = "Open")')
4. Present: list with names and submitters

Example 4: "Show me custom object custPs data"
1. get_objects() → find: custPs (custom object)
2. get_object_attributes('custPs') → get all custom fields
3. query_object('custPs', [fields], optional_filter)
4. Present: data

## FILTER SYNTAX:
- Equals: (field = 'value') or (field = 123)
- Not equals: (field != 'value')
- Comparison: (field > 100), (field < 100), (field >= 50)
- Like: (field LIKE '%search%')
- In list: (field IN ('a', 'b', 'c'))
- Multiple: (field1 = 'a') AND (field2 = 'b')
- Or: (field1 = 'a') OR (field2 = 'b')
- Null: (field is null) or (field is not null)

## IMPORTANT RULES:
1. NEVER assume field names - always call get_object_attributes() first
2. ALWAYS use exact field names from describeAttributes
3. For pluralization: 'project' → use 'projects', 'task' → use 'tasks'
4. Can work with ANY object - system objects OR custom objects
5. Present data clearly - use tables for multiple records, counts for numbers

You are smart, thorough, and data-driven. Follow the workflow exactly.`
    },
    {
      role: 'user',
      content: userMessage
    }
  ];
  
  send({ type: 'thinking', data: 'Processing...' });
  
  let iterations = 0;
  const maxIterations = 10;
  
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
        const waitTime = Math.pow(2, retries) * 1000; // Exponential backoff: 2s, 4s, 8s
        console.log(`[Retry ${retries}/${maxRetries}] Rate limited, waiting ${waitTime}ms...`);
        
        if (retries < maxRetries) {
          send({ type: 'thinking', data: `Rate limited, retrying in ${waitTime/1000}s...` });
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        } else {
          throw new Error('Rate limit exceeded. Please wait a moment and try again.');
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
      // Find tool use blocks
      const toolUseBlocks = data.content.filter((block: any) => block.type === 'tool_use');
      
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
          
          // Add tool result to messages (Claude format)
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: result
              }
            ]
          });
        } catch (error: any) {
          console.error(`[Tool Error]`, error.message);
          
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: `Error: ${error.message}`,
                is_error: true
              }
            ]
          });
        }
      }
      
      // Add assistant message with tool use
      messages.push({
        role: 'assistant',
        content: data.content
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
