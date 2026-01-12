#!/usr/bin/env node
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v19.0 - SESSION MODE (No Auth!)");
console.log("==========================================================");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CLARITY_BASE_URL = process.env.CLARITY_BASE_URL || 'http://16.16.83.171:8080';

console.log('🌐 Clarity URL:', CLARITY_BASE_URL);
console.log('🔑 Auth: Browser session cookies (NO TOKEN REQUIRED)');

let cachedObjects: any = null;
let cachedAttributes: Map<string, any> = new Map();

// ============================================================================
// AI TOOLS - Browser execution mode
// ============================================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_objects',
      description: 'Get list of all available Clarity objects. Executes in browser with session cookies.',
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
      description: 'Get all fields/attributes for a specific Clarity object. Executes in browser.',
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
      description: 'Query data from a Clarity object. Executes in browser with session.',
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
            description: 'Filter expression in Clarity syntax, e.g., "(isActive = true)"'
          }
        },
        required: ['objectName', 'fields']
      }
    }
  }
];

// ============================================================================
// TOOL HANDLERS - Send commands to browser
// ============================================================================
function handleToolCall(toolCall: any, send: (data: any) => void): Promise<string> {
  return new Promise((resolve) => {
    const { name, arguments: args } = toolCall.function;
    const parsedArgs = JSON.parse(args);
    
    console.log(`[Tool] ${name} - Browser will execute`);
    console.log(`[Tool] Args:`, parsedArgs);
    
    let endpoint = '';
    let method = 'GET';
    
    switch (name) {
      case 'get_objects':
        endpoint = '/niku/rest/v1/describe?filter=((extensions in (\'inv\')))';
        break;
        
      case 'get_object_attributes':
        const { objectName } = parsedArgs;
        endpoint = `/niku/rest/v1/describeAttributes?filter=(resourceName='${objectName}')`;
        break;
        
      case 'query_object':
        const { objectName: obj, fields, filter } = parsedArgs;
        const fieldsParam = fields.join(',');
        const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : '';
        endpoint = `/niku/rest/v1/${obj}?fields=${fieldsParam}${filterParam}&limit=100`;
        break;
        
      default:
        resolve(`Unknown tool: ${name}`);
        return;
    }
    
    console.log(`[Browser Command] ${method} ${endpoint}`);
    
    // Send command to browser
    send({
      type: 'client_execute',
      data: {
        url: endpoint,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      },
      callback_id: toolCall.id
    });
    
    // Placeholder - browser will execute and return result
    resolve(`[BROWSER_EXECUTING_${toolCall.id}]`);
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

IMPORTANT: All REST API calls execute in the user's browser using their session cookies. No authentication token needed.

WORKFLOW:
1. For "available objects": use get_objects()
2. Before querying: call get_object_attributes(objectName) to learn fields
3. Then: use query_object() with correct fields

CLARITY FILTER SYNTAX:
- Basic: (field = 'value')
- Multiple: (field1 = 'a') and (field2 = 'b')
- LIKE: (name like '%search%')

Provide clear, helpful responses.`
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
        const result = await handleToolCall(toolCall, send);
        
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
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

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '19.0.0-session',
    mode: 'browser-session',
    clarity: CLARITY_BASE_URL,
    auth: 'none-required',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/tools', (req, res) => {
  res.json({
    tools: tools.map(t => t.function.name),
    mode: 'browser-execution',
    auth: 'session-cookies'
  });
});

const PORT = parseInt(process.env.PORT || '3001');
const HOST = '0.0.0.0';

app.post('/api/chat', async (req, res) => {
  console.log('[Chat] ========================================');
  console.log('[Chat] Request received');
  console.log('[Chat] Body:', JSON.stringify(req.body, null, 2));
  console.log('[Chat] ========================================');

  const { message } = req.body;

  if (!message) {
    console.error('[Chat] ❌ Missing message in request body');
    res.status(400).json({ 
      error: 'Missing message',
      received: req.body,
      expected: { message: 'string' }
    });
    return;
  }

  console.log('[Chat] ✅ Message received:', message);
  console.log('[Chat] Using browser session mode - no auth needed');

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
    console.error('[Chat] ❌ Error:', e);
    send({ type: 'error', data: e.message });
  }

  res.end();
  console.log('[Chat] Stream ended');
});

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 CLARITY MCP v19.0 - SESSION MODE`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔌 Mode: Browser Session (NO AUTH TOKEN!)`);
  console.log(`🌐 Clarity: ${CLARITY_BASE_URL}`);
  console.log(`🔑 Auth: Browser cookies only`);
  console.log('==========================================================');
  console.log('');
  console.log('✅ Server Ready - Waiting for chat requests');
  console.log('   POST /api/chat with body: { "message": "your question" }');
  console.log('');
});
