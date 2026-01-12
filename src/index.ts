#!/usr/bin/env node
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v19.0 - SESSION MODE (No Auth Token!)");
console.log("==========================================================");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CLARITY_BASE_URL = process.env.CLARITY_BASE_URL || 'http://16.16.83.171:8080';

console.log('🌐 Clarity URL:', CLARITY_BASE_URL);
console.log('🔑 Auth: Using browser session cookies (no token needed)');

let cachedObjects: any = null;
let cachedAttributes: Map<string, any> = new Map();

// ============================================================================
// AI TOOLS - These tell the AI to request browser-side execution
// ============================================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_objects',
      description: 'Get list of all available Clarity objects (projects, tasks, resources, etc.). This will execute in the browser using session cookies.',
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
  },
  {
    type: 'function',
    function: {
      name: 'get_record',
      description: 'Get a specific record by ID. Executes in browser.',
      parameters: {
        type: 'object',
        properties: {
          objectName: {
            type: 'string',
            description: 'Name of the object'
          },
          recordId: {
            type: 'string',
            description: 'ID of the record'
          }
        },
        required: ['objectName', 'recordId']
      }
    }
  }
];

// ============================================================================
// TOOL HANDLERS - Send commands to browser for execution
// ============================================================================
function handleToolCall(toolCall: any, send: (data: any) => void): Promise<string> {
  return new Promise((resolve) => {
    const { name, arguments: args } = toolCall.function;
    const parsedArgs = JSON.parse(args);
    
    console.log(`[Tool] ${name} - Requesting browser execution`);
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
        
      case 'get_record':
        const { objectName: object, recordId } = parsedArgs;
        endpoint = `/niku/rest/v1/${object}/${recordId}`;
        break;
        
      default:
        resolve(`Unknown tool: ${name}`);
        return;
    }
    
    // Send command to browser to execute
    console.log(`[Browser] Requesting: ${method} ${endpoint}`);
    
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
    
    // The browser will execute and we'll get result back
    // For now, return a placeholder that will be replaced
    resolve(`[WAITING_FOR_BROWSER_${toolCall.id}]`);
  });
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, send: (data: any) => void) {
  const messages: any[] = [
    {
      role: 'system',
      content: `You are a helpful assistant that helps users query Clarity PPM data.

IMPORTANT: All REST API calls will execute in the browser using the user's session cookies. No authentication token needed.

WORKFLOW:
1. If user asks about available objects, use get_objects()
2. Before querying any object, call get_object_attributes(objectName) to learn fields
3. Then use query_object() with correct field names

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
  
  send({ type: 'thinking', data: 'Processing your request...' });
  
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
    
    const data = await response.json();
    const choice = data.choices[0];
    const assistantMessage = choice.message;
    
    messages.push(assistantMessage);
    
    if (choice.finish_reason === 'tool_calls') {
      send({ 
        type: 'tool_call', 
        data: `Requesting browser to execute: ${assistantMessage.tool_calls[0].function.name}` 
      });
      
      for (const toolCall of assistantMessage.tool_calls) {
        // Send browser execution request
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

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '19.0.0-session',
    mode: 'session-cookies',
    clarity: CLARITY_BASE_URL,
    auth: 'browser-session'
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
  console.log('[Chat] Request received');

  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Missing message' });
    return;
  }

  console.log('[Chat] Using browser session mode - no auth token needed');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const send = (d: any) => res.write(`data: ${JSON.stringify(d)}\n\n`);

  try {
    await runAIAgentLoop(message, send);
  } catch (e: any) {
    console.error('[Chat] Error:', e);
    send({ type: 'error', data: e.message });
  }

  res.end();
});

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 CLARITY MCP v19.0 - SESSION MODE`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔌 Mode: Browser Session Cookies`);
  console.log(`🌐 Clarity: ${CLARITY_BASE_URL}`);
  console.log(`🔑 Auth: Using browser's logged-in session`);
  console.log('==========================================================');
  console.log('');
  console.log('✅ Server Ready - Browser will execute REST calls');
  console.log('');
});
