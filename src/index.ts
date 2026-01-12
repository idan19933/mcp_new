#!/usr/bin/env node
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v19.1 - SERVER-SIDE EXECUTION");
console.log("==========================================================");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CLARITY_BASE_URL = process.env.CLARITY_BASE_URL || 'http://16.16.83.171/ppm/rest/v1';
const CLARITY_AUTH_TOKEN = process.env.CLARITY_AUTH_TOKEN || 'YOUR_AUTH_TOKEN_HERE';

console.log('🌐 Clarity URL:', CLARITY_BASE_URL);
console.log('🔑 Auth Token:', CLARITY_AUTH_TOKEN.substring(0, 20) + '...');

let cachedObjects: any = null;
let cachedAttributes: Map<string, any> = new Map();

// ============================================================================
// CLARITY REST API CLIENT - Server makes the calls
// ============================================================================
async function callClarityAPI(endpoint: string): Promise<any> {
  const url = `${CLARITY_BASE_URL}${endpoint}`;
  
  console.log(`[API] GET ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'accept': 'application/json',
      'authtoken': CLARITY_AUTH_TOKEN
    }
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  
  return response.json();
}

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
      description: 'Query data from a Clarity object. Returns all matching records (no limit).',
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
            description: 'Filter expression in Clarity syntax, e.g., "(isActive = true)". Leave empty to get all records.'
          }
        },
        required: ['objectName', 'fields']
      }
    }
  }
];

// ============================================================================
// TOOL HANDLERS - Server executes directly
// ============================================================================
async function handleToolCall(toolCall: any): Promise<string> {
  const { name, arguments: args } = toolCall.function;
  const parsedArgs = JSON.parse(args);
  
  console.log(`[Tool] ${name}`);
  console.log(`[Tool] Args:`, parsedArgs);
  
  try {
    switch (name) {
      case 'get_objects': {
        if (cachedObjects) {
          console.log('[Cache] Returning cached objects');
          return JSON.stringify(cachedObjects);
        }
        
        const result = await callClarityAPI('/describe?filter=((extensions in (\'inv\')))');
        cachedObjects = result;
        return JSON.stringify(result);
      }
      
      case 'get_object_attributes': {
        const { objectName } = parsedArgs;
        
        if (cachedAttributes.has(objectName)) {
          console.log(`[Cache] Returning cached attributes for ${objectName}`);
          return JSON.stringify(cachedAttributes.get(objectName));
        }
        
        const result = await callClarityAPI(`/describeAttributes?filter=(resourceName='${objectName}')`);
        cachedAttributes.set(objectName, result);
        return JSON.stringify(result);
      }
      
      case 'query_object': {
        const { objectName, fields, filter } = parsedArgs;
        const fieldsParam = fields.join(',');
        const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : '';
        
        // NO LIMIT - get all results
        const result = await callClarityAPI(`/${objectName}?fields=${fieldsParam}${filterParam}`);
        
        console.log(`[Query] Got ${result.length || 0} records`);
        return JSON.stringify(result);
      }
      
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (error: any) {
    console.error(`[Tool Error] ${name}:`, error.message);
    return `Error: ${error.message}`;
  }
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, send: (data: any) => void) {
  const messages: any[] = [
    {
      role: 'system',
      content: `You are a helpful Clarity PPM assistant.

WORKFLOW:
1. For "available objects": use get_objects()
2. Before querying: call get_object_attributes(objectName) to learn fields
3. Then: use query_object() with correct fields

IMPORTANT NOTES:
- query_object returns ALL matching records (no limit)
- Use filters wisely to narrow results when needed
- For counting/aggregation: you can process the full result set

CLARITY FILTER SYNTAX:
- Basic: (field = 'value')
- Multiple: (field1 = 'a') and (field2 = 'b')
- LIKE: (name like '%search%')
- IS NOT NULL: (field is not null)

Provide clear, helpful, data-driven responses.`
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
      send({ type: 'tool_call', data: `Using: ${toolName}` });
      
      for (const toolCall of assistantMessage.tool_calls) {
        const result = await handleToolCall(toolCall);
        
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

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '19.1.0-server-side',
    mode: 'server-execution',
    clarity: CLARITY_BASE_URL,
    auth: 'server-token',
    timestamp: new Date().toISOString()
  });
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
  console.log(`🚀 CLARITY MCP v19.1 - SERVER-SIDE EXECUTION`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔌 Mode: Server executes all REST calls`);
  console.log(`🌐 Clarity: ${CLARITY_BASE_URL}`);
  console.log(`🔑 Auth: Server-side token`);
  console.log('==========================================================');
  console.log('');
  console.log('✅ Server Ready - No client-side execution needed');
  console.log('');
});
