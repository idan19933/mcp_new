#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v11.0 - REMOTE CONTROL EDITION");
console.log("==========================================================");

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

const CLARITY_BASE_URL = process.env.CLARITY_URL || `http://${DB_CONFIG.server}:8080`; 

// ============================================================================
// TABLE MAP
// ============================================================================
const TABLE_MAP: Record<string, string> = {
  'PROJECT': 'INV_INVESTMENTS',
  'IDEA': 'INV_INVESTMENTS',
  'TASK': 'PRTASK',
  'RESOURCE': 'SRM_RESOURCES',
  'TEAM': 'PRTEAM',
  'TIMESHEET': 'PRTIMESHEET',
  'RISK': 'RIM_RISKS',
  'ISSUE': 'RIM_ISSUES',
  'DEPARTMENT': 'CMN_DEPARTMENTS',
  'LOOKUP': 'CMN_LOOKUPS_V',
  'USER': 'CMN_SEC_USERS',
  'VENDOR': 'ODF_CA_VENDOR',
  'CONTRACT': 'ODF_CA_CONTRACT'
};

interface ClarityObject { 
  objectCode: string; 
  objectName: string; 
  tableName: string; 
}

let clarityObjects: Map<string, ClarityObject> = new Map();

// ============================================================================
// DATABASE
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
    console.error('❌ DB Connection Failed:', err);
    throw err;
  }
}

async function loadClarityObjects() {
  console.log('[Objects] Building object map...');
  try {
    const db = await getPool();
    const result = await db.request().query("SELECT code, name FROM ODF_OBJECTS WHERE is_active = 1");
    result.recordset.forEach((obj: any) => {
      const code = (obj.code || '').toUpperCase();
      if (!code) return;
      let tableName = TABLE_MAP[code] || `ODF_CA_${code}`;
      clarityObjects.set(code, { 
        objectCode: code, 
        objectName: obj.name || code, 
        tableName 
      });
    });
    console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error) {
    console.warn('⚠️ [Objects] Using hardcoded map.');
    Object.entries(TABLE_MAP).forEach(([k, v]) => {
      clarityObjects.set(k, { objectCode: k, objectName: k, tableName: v });
    });
  }
}

// ============================================================================
// TOOL 1: SQL READ (READ-ONLY)
// ============================================================================
async function executeDynamicQuery(sqlQuery: string): Promise<string> {
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'EXEC'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `))) {
    return '❌ Security: Read-only. Use browser command for writes.';
  }
  
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security: Only SELECT queries allowed.';
  }
  
  if (upperSQL.includes('LIMIT ')) {
    return `❌ SYNTAX: Use 'TOP n' instead of 'LIMIT n'.`;
  }

  try {
    const db = await getPool();
    console.log(`[SQL-READ] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed. No results found.';
    }
    
    return JSON.stringify(result.recordset.slice(0, 100), null, 2);
  } catch (error: any) {
    console.error(`[SQL Error] ${error.message}`);
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 2: CLIENT-SIDE EXECUTION GENERATOR (GENIUS!)
// ============================================================================
// This doesn't execute REST - it sends a command to the browser to execute it!
async function triggerClientExecution(
  method: string, 
  endpoint: string, 
  body: any, 
  sendUpdate: any
): Promise<string> {
  // Clean the endpoint
  const cleanEndpoint = endpoint.startsWith('/ppm/rest/v1') 
    ? endpoint 
    : `/ppm/rest/v1${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  
  console.log(`[BROWSER-CMD] Sending command: ${method} ${cleanEndpoint}`);
  
  // 1. Send the COMMAND Signal (Extension will listen for this!)
  const commandPayload = {
    type: 'client_execute', // Magic keyword the extension listens for
    data: {
      url: cleanEndpoint,
      method: method,
      body: body,
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }
  };
  
  // Send the command via the stream
  sendUpdate(commandPayload);
  
  console.log(`[BROWSER-CMD] Command sent successfully`);

  // 2. Return a text description for the Chat UI
  return `🚀 **COMMAND SENT TO YOUR BROWSER**

I've instructed your browser extension to execute:
\`${method} ${CLARITY_BASE_URL}${cleanEndpoint}\`

**What happens next:**
1. Your browser receives the command
2. Browser executes the REST call (using YOUR session cookies!)
3. Result appears in browser console/network tab

**Why this works:**
- Your browser CAN reach Clarity (you're logged in!)
- Browser has valid session cookies
- No firewall issues (request comes from browser)

Check your browser's Developer Tools (F12) → Console/Network tab to see the result!`;
}

// ============================================================================
// TOOL 3: SCHEMA HELPER
// ============================================================================
async function getObjectSchema(objectCode: string): Promise<string> {
  const obj = clarityObjects.get(objectCode.toUpperCase());
  if (!obj) {
    return `Object '${objectCode}' not found. Available: ${Array.from(clarityObjects.keys()).slice(0, 10).join(', ')}...`;
  }
  
  try {
    const db = await getPool();
    const q = `
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = '${obj.tableName}'
      ORDER BY ORDINAL_POSITION
    `;
    const res = await db.request().query(q);
    
    return JSON.stringify({ 
      object: obj.objectName, 
      table: obj.tableName, 
      columns: res.recordset 
    }, null, 2);
  } catch (e: any) { 
    return `Error: ${e.message}`; 
  }
}

// ============================================================================
// AI AGENT LOOP (REMOTE CONTROL BRAIN!)
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Architect with REMOTE CONTROL capabilities.

🎯 **ARCHITECTURE - "Remote Control" Mode:**

**How it works:**
1. **Server (You)**: Brain that finds IDs via SQL
2. **Browser (User)**: Executes REST API calls using their session
3. **No connectivity issues!** Browser can reach Clarity!

**Your Tools:**
1. **run_read_sql**: Find project IDs, resource IDs, etc. via SQL
2. **trigger_browser_action**: Send command to browser to execute REST API
3. **get_schema**: Check database schema

🚀 **WORKFLOW - Task Creation:**

**Step 1:** Find Project ID via SQL
\`\`\`sql
SELECT ID, CODE, NAME 
FROM INV_INVESTMENTS WITH(NOLOCK)
WHERE CODE = 'project_code' OR NAME LIKE '%project_name%'
\`\`\`
Result: {"ID": 5004001}

**Step 2:** Send Browser Command
\`\`\`
trigger_browser_action(
  method: "POST",
  endpoint: "/projects/5004001/tasks",
  body: {
    "code": "task_code",
    "name": "Task Name",
    "status": "NOT_STARTED",
    "priority": 10
  }
)
\`\`\`

**What happens:**
- Server sends command via event stream
- Browser extension intercepts command
- Browser executes fetch() with user's cookies
- Result appears in browser console

💡 **KEY ADVANTAGES:**
- ✅ No server connectivity issues
- ✅ Uses user's active session
- ✅ No VPN/firewall problems
- ✅ Browser can reach Clarity
- ✅ Automatic cookie handling

⚠️ **CRITICAL RULES:**
- ALWAYS use numeric IDs in endpoints (5004001 not "this_proj")
- endpoints like "/projects/5004001/tasks" (not full URL)
- Browser will add base URL automatically
- Tell user to check browser console for results

🔗 **COMMON ENDPOINTS:**
- Create Task: POST /projects/{id}/tasks
- Update Task: PUT /tasks/{id}
- Get Project: GET /projects/{id}
- Create Resource: POST /resources

**REMEMBER:** You're the brain, browser is the hands!`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Find IDs and data via SQL. Read-only.',
        parameters: {
          type: 'object',
          properties: { 
            sqlQuery: { 
              type: 'string',
              description: 'MS SQL SELECT with WITH(NOLOCK) and TOP'
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
        description: 'Send command to browser to execute REST API call. Browser handles authentication and connectivity!',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['GET', 'POST', 'PUT', 'DELETE']
            },
            endpoint: { 
              type: 'string',
              description: 'API endpoint like /projects/5004001/tasks (no base URL)'
            },
            body: { 
              type: 'object',
              description: 'JSON payload'
            }
          },
          required: ['method', 'endpoint']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_schema',
        description: 'Get database schema',
        parameters: {
          type: 'object',
          properties: { 
            objectCode: { type: 'string' } 
          },
          required: ['objectCode']
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
        messages: messages,
        tools: tools,
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
        sendUpdate({ type: 'tool', data: `🔧 ${fn}` });
        
        let res = '';
        try {
          if (fn === 'run_read_sql') {
            res = await executeDynamicQuery(args.sqlQuery);
          }
          else if (fn === 'trigger_browser_action') {
            res = await triggerClientExecution(args.method, args.endpoint, args.body, sendUpdate);
          }
          else if (fn === 'get_schema') {
            res = await getObjectSchema(args.objectCode);
          }
          else {
            res = `Unknown tool: ${fn}`;
          }
          
          sendUpdate({ type: 'step', data: '✅ Done' });
        } catch (e: any) { 
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
// HTTP SERVER
// ============================================================================
async function startHTTPServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3001');
  
  app.use(express.json());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  await getPool();
  await loadClarityObjects();

  app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      sendUpdate({ type: 'info', data: '🎮 Remote Control Mode Active' });
      await runAIAgentLoop(message, sendUpdate);
    } catch (error: any) {
      sendUpdate({ type: 'error', data: error.message });
    }

    res.end();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ready',
      version: 'v11.0-remote-control',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      mode: 'Remote Control (Browser Execution)',
      features: [
        'remote-control-mode',
        'browser-command-execution',
        'no-server-connectivity-required',
        'uses-browser-session',
        'bypasses-firewall',
        'id-first-logic',
        'sql-read-only'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v11.0 REMOTE CONTROL EDITION`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o`);
    console.log(`🎮 Mode: REMOTE CONTROL (Commands → Browser)`);
    console.log(`💡 Server = Brain | Browser = Hands`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
