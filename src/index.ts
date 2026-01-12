#!/usr/bin/env node
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v20.0 - BROWSER EXECUTION (WITH RESPONSE)");
console.log("==========================================================");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CLARITY_BASE_URL = process.env.CLARITY_BASE_URL || 'http://16.16.83.171/ppm/rest/v1';

console.log('🌐 Clarity URL:', CLARITY_BASE_URL);
console.log('🔑 Auth: Browser session (no token needed)');

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
      description: 'Get list of all available Clarity objects (projects, tasks, resources, etc.)',
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
      description: 'Get all fields/attributes for a specific Clarity object',
      parameters: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description: 'Name of the object (e.g., "project", "task", "resource")'
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
      description: 'Query data from a Clarity object. Returns all matching records.',
      parameters: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description: 'Name of the object to query'
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of fields to return'
          },
          filter: {
            type: 'string',
            description: 'Filter expression in Clarity syntax. Leave empty to get all records.'
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
      content: `You are a helpful Clarity PPM assistant.

All REST API calls execute in the user's browser using their session cookies.

WORKFLOW:
1. For "available objects": use get_objects()
2. Before querying: call get_object_attributes(objectName) to learn fields
3. Then: use query_object() with correct fields

IMPORTANT:
- query_object returns ALL matching records (no limit)
- Use filters to narrow results when needed
- You can process full result sets for counting/analysis

CLARITY FILTER SYNTAX:
- Basic: (field = 'value')
- Multiple: (field1 = 'a') and (field2 = 'b')
- LIKE: (name like '%search%')
- IS NOT NULL: (field is not null)

Provide clear, data-driven answers.`
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
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        tools,
        temperature: 0.7
      })
    });
    
    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }
    
    const data: any = await response.json();
    const choice = data.choices[0];
    const assistantMessage = choice.message;
    
    messages.push(assistantMessage);
    
    if (choice.finish_reason === 'tool_calls') {
      const toolName = assistantMessage.tool_calls[0].function.name;
      send({ type: 'tool_call', data: `Requesting browser: ${toolName}` });
      
      for (const toolCall of assistantMessage.tool_calls) {
        try {
          // This will wait for browser response
          const result = await handleToolCall(toolCall, send);
          
          console.log(`[Tool Result] Got ${result.length} chars`);
          
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
        } catch (error: any) {
          console.error(`[Tool Error]`, error.message);
          
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: ${error.message}`
          });
        }
      }
      
      continue;
    }
    
    if (choice.finish_reason === 'stop') {
      send({ type: 'complete', data: assistantMessage.content });
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
