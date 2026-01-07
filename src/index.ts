#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v12.0 - HYBRID INTELLIGENCE (CORS FIXED)");
console.log("==========================================================");

// ============================================================================
// CONFIGURATION
// ============================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DB_CONFIG = {
  user: process.env.DB_USER || 'niku',
  password: process.env.DB_PASSWORD || 'niku',
  server: process.env.DB_SERVER || '16.16.83.171',
  database: process.env.DB_NAME || 'niku',
  requestTimeout: 60000,
  options: { 
    encrypt: false, 
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: { max: 20, min: 2, idleTimeoutMillis: 30000 }
};

// ============================================================================
// DATABASE CONNECTION
// ============================================================================
let pool: sql.ConnectionPool | null = null;

async function getPool() {
  if (pool?.connected) return pool;
  try {
    pool = await new sql.ConnectionPool(DB_CONFIG).connect();
    console.log('✅ Database Connected');
    pool.on('error', (err: any) => console.error('Pool Error:', err));
    return pool;
  } catch (err) {
    console.error('❌ DB Fail:', err);
    throw err;
  }
}

// ============================================================================
// DYNAMIC OBJECT DISCOVERY
// ============================================================================
interface ClarityObject { code: string; type: string; table: string; }
let clarityObjects: Map<string, ClarityObject> = new Map();

async function loadClarityObjects() {
  console.log('[Objects] Smart Mapping...');
  try {
    const db = await getPool();
    const query = `
      SELECT 
        o.CODE, 
        o.NAME,
        ISNULL(s.OBJECT_TYPE_CODE, 'OBJECT') as OBJECT_TYPE_CODE,
        o.DATABASE_TABLE
      FROM ODF_OBJECTS o
      LEFT JOIN CMN_SEC_OBJECTS s ON s.OBJECT_CODE = o.CODE
      WHERE o.IS_ACTIVE = 1
    `;
    
    const result = await db.request().query(query);
    
    result.recordset.forEach((row: any) => {
      const code = row.CODE.toUpperCase();
      let table = row.DATABASE_TABLE;
      
      // Intelligent fallback
      if (!table) {
        if (code === 'PROJECT') table = 'INV_INVESTMENTS';
        else if (code === 'TASK') table = 'PRTASK';
        else if (code === 'RESOURCE') table = 'SRM_RESOURCES';
        else table = `ODF_CA_${code}`;
      }
      
      clarityObjects.set(code, {
        code: code,
        type: row.OBJECT_TYPE_CODE,
        table: table
      });
    });

    console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error) {
    console.warn('⚠️ [Objects] Using fallback.');
    clarityObjects.set('PROJECT', { code: 'PROJECT', type: 'XOG', table: 'INV_INVESTMENTS' });
    clarityObjects.set('TASK', { code: 'TASK', type: 'XOG', table: 'PRTASK' });
    clarityObjects.set('RESOURCE', { code: 'RESOURCE', type: 'XOG', table: 'SRM_RESOURCES' });
  }
}

// ============================================================================
// TOOL 1: SERVER SQL (THE BRAIN)
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  const forbidden = ['INSERT','UPDATE','DELETE','DROP','ALTER','TRUNCATE'];
  const upperSQL = sqlQuery.toUpperCase();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `))) {
    return '❌ Security: Modifications forbidden. Use browser actions.';
  }

  try {
    const db = await getPool();
    console.log(`[SQL-BRAIN] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) return 'No results found.';
    return JSON.stringify(result.recordset.slice(0, 100), null, 2);
  } catch (e: any) { 
    return `❌ SQL Error: ${e.message}`; 
  }
}

// ============================================================================
// TOOL 2: BROWSER ACTION (THE HANDS)
// ============================================================================
async function triggerBrowserAction(
  method: string, 
  endpoint: string, 
  body: any, 
  sendUpdate: any
): Promise<string> {
  const browserUrl = `/ppm/rest/v1${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  
  console.log(`[BROWSER-CMD] ${method} ${browserUrl}`);
  
  // Send command to browser
  sendUpdate({
    type: 'client_execute',
    data: { 
      method, 
      url: browserUrl, 
      body, 
      headers: { 'Content-Type': 'application/json' } 
    }
  });

  return `✅ **Command Sent to Browser**
  
I've instructed your browser to execute:
\`${method} ${browserUrl}\`
  
Check your browser console (F12) for the result!`;
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are Clarity Hybrid Intelligence.

🧠 **SERVER (Your Brain)**:
- Answer questions using SQL directly
- Fast & reliable database access
- Use for: counting, listing, analyzing

✋ **BROWSER (Your Hands)**:
- Execute write operations (CREATE/UPDATE)
- Uses user's session cookies
- Use for: task creation, updates

💡 **Examples**:
Q: "How many tasks?"
→ execute_server_sql("SELECT COUNT(*) FROM PRTASK")

Q: "Create task 'test' in project 'this_proj'"
→ Step 1: execute_server_sql("SELECT ID FROM INV_INVESTMENTS WHERE CODE='this_proj'")
→ Step 2: trigger_browser_action("POST", "/projects/{id}/tasks", {...})

**Critical Rules:**
- ALWAYS use WITH(NOLOCK) in SQL
- ALWAYS use TOP instead of LIMIT
- ALWAYS find numeric ID before REST calls
- READ from server, WRITE from browser`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'execute_server_sql',
        description: 'Execute SQL query on server. Fast & reliable. Use for ALL reading.',
        parameters: { 
          type: 'object', 
          properties: { 
            sqlQuery: { 
              type: 'string',
              description: 'MS SQL query with WITH(NOLOCK) and TOP'
            } 
          }, 
          required: ['sqlQuery'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'trigger_browser_action',
        description: 'Send command to browser to execute REST API. Use for CREATE/UPDATE.',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] 
            },
            endpoint: { 
              type: 'string',
              description: 'API endpoint with numeric ID, e.g., /projects/5004001/tasks'
            },
            body: { 
              type: 'object',
              description: 'JSON payload'
            }
          },
          required: ['method', 'endpoint']
        }
      }
    }
  ];

  let messages: any[] = [
    { role: 'system', content: systemPrompt }, 
    { role: 'user', content: userMessage }
  ];

  let iteration = 0;
  while (iteration < 10) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Processing... (${iteration}/10)` });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${OPENAI_API_KEY}` 
      },
      body: JSON.stringify({ 
        model: 'gpt-4o', 
        messages, 
        tools,
        tool_choice: 'auto'
      })
    });

    const data: any = await response.json();
    const msg = data.choices?.[0]?.message;

    if (!msg) throw new Error('Invalid AI response');

    if (msg.tool_calls?.length > 0) {
      messages.push(msg);
      
      for (const call of msg.tool_calls) {
        const fn = call.function.name;
        const args = JSON.parse(call.function.arguments);
        
        let res = '';
        if (fn === 'execute_server_sql') {
          sendUpdate({ type: 'tool', data: `🧠 Server Brain (SQL)` });
          res = await executeServerSQL(args.sqlQuery);
        } 
        else if (fn === 'trigger_browser_action') {
          sendUpdate({ type: 'tool', data: `✋ Browser Hands (REST)` });
          res = await triggerBrowserAction(args.method, args.endpoint, args.body, sendUpdate);
        }
        
        sendUpdate({ type: 'step', data: '✅ Done' });
        
        messages.push({ 
          role: 'tool', 
          tool_call_id: call.id, 
          content: res 
        });
      }
      
      continue;
    }

    if (msg.content) {
      sendUpdate({ type: 'complete', data: msg.content });
      return msg.content;
    }
    
    break;
  }
  
  return 'Maximum iterations reached';
}

// ============================================================================
// SERVER SETUP (CORS FIXED!)
// ============================================================================
const app = express();

// CRITICAL: CORS must be BEFORE routes!
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    version: 'v12.0-hybrid-cors-fixed',
    database: pool?.connected ? 'connected' : 'disconnected',
    objects: clarityObjects.size,
    features: [
      'hybrid-intelligence',
      'server-sql-brain',
      'browser-rest-hands',
      'cors-enabled',
      'smart-object-mapping'
    ]
  });
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  console.log('[Chat] Request received');
  
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  
  const send = (d: any) => {
    res.write(`data: ${JSON.stringify(d)}\n\n`);
  };
  
  try { 
    await runAIAgentLoop(req.body.message, send); 
  } catch (e: any) { 
    send({ type: 'error', data: e.message }); 
  }
  
  res.end();
});

const PORT = 3001; // Fixed port
app.listen(PORT, async () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 Clarity MCP v12.0 HYBRID INTELLIGENCE`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`✅ CORS: Enabled for Extension`);
  console.log(`🧠 Mode: Hybrid (Server Brain + Browser Hands)`);
  console.log('==========================================================');
  console.log('');
  
  await getPool();
  await loadClarityObjects();
});
