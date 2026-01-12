#!/usr/bin/env node
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v19.0 - REST API Edition");
console.log("==========================================================");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CLARITY_BASE_URL = process.env.CLARITY_BASE_URL || 'http://16.16.83.171/ppm/rest/v1';

// ============================================================================
// CLARITY REST API CLIENT
// ============================================================================
interface ClarityCredentials {
  authtoken: string;
  contextId?: string;
}

let cachedObjects: any = null;
let cachedAttributes: Map<string, any> = new Map();

async function callClarityAPI(
  endpoint: string, 
  credentials: ClarityCredentials,
  method: 'GET' | 'POST' = 'GET',
  body?: any
): Promise<any> {
  const url = `${CLARITY_BASE_URL}${endpoint}`;
  
  const headers: any = {
    'accept': 'application/json, text/plain, */*',
    'authtoken': credentials.authtoken,
  };
  
  if (credentials.contextId) {
    headers['x-api-context-id'] = credentials.contextId;
  }
  
  if (method === 'POST' && body) {
    headers['content-type'] = 'application/json';
  }
  
  console.log(`[API] ${method} ${url}`);
  
  const options: any = {
    method,
    headers,
  };
  
  if (method === 'POST' && body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    
    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error: any) {
    console.error('[API] Error:', error.message);
    throw error;
  }
}

// ============================================================================
// TOOLS - REST API BASED
// ============================================================================

/**
 * Get all available objects from Clarity
 */
async function getObjects(credentials: ClarityCredentials): Promise<string> {
  try {
    if (cachedObjects) {
      return JSON.stringify(cachedObjects, null, 2);
    }
    
    const data = await callClarityAPI(
      '/describe?filter=((extensions in (\'inv\')))',
      credentials
    );
    
    cachedObjects = data;
    
    const summary = {
      totalCount: data._totalCount || data._recordsReturned,
      objects: data._results?.map((obj: any) => ({
        code: obj.code,
        name: obj.name,
        isCustom: obj.isCustom
      })) || []
    };
    
    return JSON.stringify(summary, null, 2);
  } catch (error: any) {
    return `❌ Error getting objects: ${error.message}`;
  }
}

/**
 * Get attributes (fields) for a specific object
 */
async function getObjectAttributes(
  objectName: string, 
  credentials: ClarityCredentials
): Promise<string> {
  try {
    // Check cache first
    if (cachedAttributes.has(objectName)) {
      return JSON.stringify(cachedAttributes.get(objectName), null, 2);
    }
    
    const data = await callClarityAPI(
      `/describeAttributes?filter=(resourceName = '${objectName}') and (honorFieldLevelSecurity = true)&limit=1500`,
      credentials
    );
    
    cachedAttributes.set(objectName, data);
    
    const summary = {
      object: objectName,
      totalCount: data._recordsReturned,
      attributes: data._results?.map((attr: any) => ({
        name: attr.name,
        label: attr.label,
        dataType: attr.dataType,
        isRequired: attr.isRequired,
        isReadOnly: attr.isReadOnly,
        isCustom: attr.isCustom
      })) || []
    };
    
    return JSON.stringify(summary, null, 2);
  } catch (error: any) {
    return `❌ Error getting attributes: ${error.message}`;
  }
}

/**
 * Query data from a Clarity object
 */
async function queryObject(
  objectName: string,
  fields: string[],
  filter: string | null,
  credentials: ClarityCredentials
): Promise<string> {
  try {
    let endpoint = `/${objectName}`;
    const params: string[] = [];
    
    if (fields && fields.length > 0) {
      params.push(`fields=${fields.join(',')}`);
    }
    
    if (filter) {
      params.push(`filter=${encodeURIComponent(filter)}`);
    }
    
    params.push('limit=100');
    
    if (params.length > 0) {
      endpoint += '?' + params.join('&');
    }
    
    const data = await callClarityAPI(endpoint, credentials);
    
    return JSON.stringify(data, null, 2);
  } catch (error: any) {
    return `❌ Error querying object: ${error.message}`;
  }
}

/**
 * Get a single record by ID
 */
async function getRecord(
  objectName: string,
  recordId: string,
  credentials: ClarityCredentials
): Promise<string> {
  try {
    const endpoint = `/${objectName}/${recordId}`;
    const data = await callClarityAPI(endpoint, credentials);
    return JSON.stringify(data, null, 2);
  } catch (error: any) {
    return `❌ Error getting record: ${error.message}`;
  }
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  credentials: ClarityCredentials,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';

  const systemPrompt = `You are **Clarity REST API Assistant** - An expert in Clarity PPM REST API.

🎯 **YOUR PURPOSE:**
- Help users query Clarity data via REST API
- Guide users through the API structure
- Build proper API queries

🔍 **AVAILABLE TOOLS:**
1. \`get_objects\` - List all available Clarity objects
2. \`get_object_attributes\` - Get fields/columns for an object
3. \`query_object\` - Query data from an object
4. \`get_record\` - Get a specific record by ID

📊 **WORKFLOW:**
1. First, use \`get_objects\` to see available objects
2. Then, use \`get_object_attributes\` to see what fields exist
3. Finally, use \`query_object\` to get the actual data

🔎 **FILTERS:**
- Use Clarity filter syntax: \`(field = 'value')\`
- Multiple conditions: \`(field1 = 'value1') and (field2 = 'value2')\`
- LIKE search: \`(name like '%search%')\`

💡 **EXAMPLES:**

User: "What objects are available?"
You: \`get_objects()\`

User: "What fields does the projects object have?"
You: \`get_object_attributes('projects')\`

User: "Find all active projects"
You: \`query_object('projects', ['name', 'code', 'status'], '(isActive = true)')\`

User: "Find project with code PRJ001"
You: \`query_object('projects', ['name', 'code', 'manager'], '(code = \\'PRJ001\\')')\`

⚠️ **IMPORTANT:**
- ALWAYS start with \`get_objects\` if you don't know the object name
- ALWAYS use \`get_object_attributes\` before querying to know field names
- Use proper Clarity field names (like 'name', 'code', 'isActive')
- Filters must use Clarity syntax with parentheses`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'get_objects',
        description: 'Get list of all available Clarity objects',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_object_attributes',
        description: 'Get attributes (fields) for a specific Clarity object',
        parameters: {
          type: 'object',
          properties: {
            objectName: {
              type: 'string',
              description: 'Name of the object (e.g., "projects", "tasks")'
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
        description: 'Query data from a Clarity object',
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
              description: 'Fields to retrieve'
            },
            filter: {
              type: 'string',
              description: 'Clarity filter syntax, e.g., "(name like \'%test%\')"'
            }
          },
          required: ['objectName']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_record',
        description: 'Get a specific record by ID',
        parameters: {
          type: 'object',
          properties: {
            objectName: { type: 'string' },
            recordId: { type: 'string' }
          },
          required: ['objectName', 'recordId']
        }
      }
    }
  ];

  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  let iteration = 0;
  const MAX_ITERATIONS = 10;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `🤔 Reasoning... (${iteration}/${MAX_ITERATIONS})` });

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages,
          tools
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data: any = await response.json();
      const msg = data.choices?.[0]?.message;

      if (!msg) break;

      if (msg.tool_calls) {
        messages.push(msg);

        for (const call of msg.tool_calls) {
          const fn = call.function.name;
          let args: any = {};

          try {
            args = JSON.parse(call.function.arguments);
          } catch (e) {
            console.error('[Tool] Parse error:', call.function.arguments);
          }

          sendUpdate({ type: 'tool', data: `🔧 ${fn}` });

          let res = '';
          try {
            if (fn === 'get_objects') {
              res = await getObjects(credentials);
            }
            else if (fn === 'get_object_attributes') {
              res = await getObjectAttributes(args.objectName || '', credentials);
            }
            else if (fn === 'query_object') {
              res = await queryObject(
                args.objectName || '',
                args.fields || [],
                args.filter || null,
                credentials
              );
            }
            else if (fn === 'get_record') {
              res = await getRecord(
                args.objectName || '',
                args.recordId || '',
                credentials
              );
            }
            else {
              res = `Unknown tool: ${fn}`;
            }

            sendUpdate({ type: 'step', data: '✅ Done' });
          } catch (e: any) {
            console.error(`[Tool] Error in ${fn}:`, e);
            res = `Error: ${e.message}`;
            sendUpdate({ type: 'step', data: '❌ Error' });
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: res
          });
        }

        continue;

      } else {
        sendUpdate({ type: 'complete', data: msg.content });
        return msg.content;
      }

    } catch (e: any) {
      console.error('[AI] Error:', e);
      sendUpdate({ type: 'error', data: `AI error: ${e.message}` });
      return `Error: ${e.message}`;
    }
  }

  return 'Search complete (max iterations reached)';
}

// ============================================================================
// SERVER
// ============================================================================
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    version: 'v19.0-rest-api',
    mode: 'rest-api',
    features: [
      'get-objects',
      'get-attributes',
      'query-data',
      'get-record',
      'ai-powered'
    ]
  });
});

const PORT = parseInt(process.env.PORT || '3001');
const HOST = '0.0.0.0';

app.post('/api/chat', async (req, res) => {
  console.log('[Chat] Request received');

  // Extract credentials from request
  const { message, credentials } = req.body;

  if (!credentials || !credentials.authtoken) {
    res.status(400).json({ error: 'Missing credentials (authtoken required)' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const send = (d: any) => res.write(`data: ${JSON.stringify(d)}\n\n`);

  try {
    await runAIAgentLoop(message, credentials, send);
  } catch (e: any) {
    console.error('[Chat] Error:', e);
    send({ type: 'error', data: e.message });
  }

  res.end();
});

app.listen(PORT, HOST, () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 CLARITY MCP v19.0 REST API`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔌 Mode: REST API`);
  console.log(`🌐 Clarity: ${CLARITY_BASE_URL}`);
  console.log('==========================================================');
  console.log('');
  console.log('✅ Server Ready - Waiting for requests with credentials');
  console.log('');
});
