#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v17.4 - STRICT REST ENFORCER");
console.log("==========================================================");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DB_CONFIG = {
  user: process.env.DB_USER || 'niku',
  password: process.env.DB_PASSWORD || 'niku',
  server: process.env.DB_SERVER || '16.16.83.171',
  database: process.env.DB_NAME || 'niku',
  requestTimeout: 60000,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  pool: { max: 20, min: 2, idleTimeoutMillis: 30000 }
};

// ============================================================================
// ROBUST CONNECTION
// ============================================================================
let pool: sql.ConnectionPool | null = null;
let dbConnected = false;

async function getPool() {
  if (pool?.connected) { dbConnected = true; return pool; }
  try {
    console.log('🔌 Connecting to Database...');
    pool = await new sql.ConnectionPool(DB_CONFIG).connect();
    console.log('✅ Database Connected Successfully');
    dbConnected = true;
    pool.on('error', (err: any) => { console.error('Pool Error:', err); dbConnected = false; });
    return pool;
  } catch (err: any) {
    console.error(`⚠️ Database Connection Failed: ${err.message}`);
    console.log('⚠️ Server starting in "Resilient Mode"');
    dbConnected = false;
    return null;
  }
}

// ============================================================================
// HYBRID OBJECT MAP
// ============================================================================
interface ClarityObject { code: string; name: string; table: string; }
let clarityObjects: Map<string, ClarityObject> = new Map();

const CORE_MAPPING: Record<string, string> = {
  'PROJECT': 'INV_INVESTMENTS',
  'IDEA': 'INV_INVESTMENTS',
  'TASK': 'PRTASK',
  'RESOURCE': 'SRM_RESOURCES',
  'TEAM': 'PRTEAM',
  'TIMESHEET': 'PRTIMESHEET',
  'ASSIGNMENT': 'PRASSIGNMENT',
  'USER': 'CMN_SEC_USERS',
  'CHANGE': 'CHG_INVESTMENTS',
  'INCIDENT': 'INC_INCIDENTS',
  'ISSUE': 'ISS_ISSUES',
  'RISK': 'RISK_RISKS',
  'PROCESS': 'BPM_PROCESSES'
};

async function loadClarityObjects() {
  console.log('[Objects] Loading core map...');
  
  Object.entries(CORE_MAPPING).forEach(([code, table]) => {
    clarityObjects.set(code, { code, name: code, table });
  });
  
  console.log(`✅ Core map: ${clarityObjects.size} objects`);

  if (!dbConnected) {
    console.log('⚠️ Skipping dynamic loading (DB offline)');
    return;
  }

  try {
    const db = await getPool();
    if (!db) return;
    
    const result = await db.request().query("SELECT CODE FROM ODF_OBJECTS");
    result.recordset.forEach((row: any) => {
      const code = row.CODE.toUpperCase();
      const table = CORE_MAPPING[code] || `ODF_CA_${code}`;
      if (!clarityObjects.has(code)) {
        clarityObjects.set(code, { code, name: code, table });
      }
    });
    
    console.log(`✅ Map Loaded: ${clarityObjects.size} objects total`);
  } catch (e: any) { 
    console.warn(`⚠️ Dynamic mapping failed (Using core only)`); 
  }
}

// ============================================================================
// TOOLS (The Enforcer)
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  if (!dbConnected) {
    await getPool();
    if (!dbConnected) {
      return '⚠️ DB Offline. Cannot verify data.';
    }
  }
  
  // 🛑 FIREWALL: STRICTLY BLOCK WRITES 🛑
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE'];
  const upperSQL = sqlQuery.toUpperCase();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `) || upperSQL.includes(`\n${w} `) || upperSQL.startsWith(w))) {
    return `⛔ STRICT SECURITY BLOCK:

You tried to run: "${sqlQuery.substring(0, 100)}..."

Writing to Clarity via SQL is FORBIDDEN because it corrupts the database (missing IDs, auditing, slices).

👉 YOU MUST USE 'trigger_browser_action' (REST API) TO CREATE OR UPDATE DATA.

Example:
trigger_browser_action('POST', '/projects/5004001/tasks', { name: 'Task Name' })`;
  }

  try {
    const db = await getPool();
    if (!db) return '❌ DB Offline';
    
    console.log(`[SQL] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed. No results found.';
    }
    
    return JSON.stringify(result.recordset.slice(0, 100), null, 2);
  } catch (e: any) { 
    return `❌ SQL Error: ${e.message}`; 
  }
}

async function investigateTable(tableName: string): Promise<string> {
  if (!dbConnected) return `⚠️ DB Offline.`;
  
  try {
    const db = await getPool();
    if (!db) return 'DB Disconnected';
    
    const cols = await db.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE 
      FROM INFORMATION_SCHEMA.COLUMNS WITH(NOLOCK)
      WHERE TABLE_NAME = '${tableName}' 
      ORDER BY ORDINAL_POSITION
    `);
    
    if (cols.recordset.length === 0) {
      return `Table '${tableName}' not found.`;
    }
    
    const colList = cols.recordset.map((c: any) => c.COLUMN_NAME).slice(0, 20);
    
    return `✅ Table: ${tableName} (${cols.recordset.length} columns)
Cols: ${colList.join(', ')}${cols.recordset.length > 20 ? '...' : ''}`;
    
  } catch (e: any) { 
    return `Investigation failed: ${e.message}`; 
  }
}

async function lookupObject(objectCode: string): Promise<string> {
  const code = objectCode.toUpperCase();
  const obj = clarityObjects.get(code);
  
  if (!obj) {
    return `❌ Object '${objectCode}' not found.`;
  }
  
  return `✅ Object: ${obj.code}
Table: ${obj.table}`;
}

async function triggerBrowserAction(
  method: string, 
  endpoint: string, 
  body: any, 
  sendUpdate: any
): Promise<string> {
  const browserUrl = `/ppm/rest/v1${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
  
  // 🧠 SMART DEFAULTS FOR TASKS
  if (endpoint.includes('tasks') && method === 'POST') {
    if (!body.code) {
      body.code = `TASK_${Date.now().toString().slice(-6)}`; // Auto Code
    }
    if (!body.start) {
      body.start = new Date().toISOString();
    }
    if (!body.finish) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      body.finish = tomorrow.toISOString();
    }
    if (!body.status) {
      body.status = '0'; // '0' = Not Started
    }
    if (!body.priority) {
      body.priority = 10;
    }
    if (!body.isOpenForTimeEntry) {
      body.isOpenForTimeEntry = true;
    }
  }
  
  console.log(`[Browser-CMD] ${method} ${browserUrl}`);
  console.log(`[Browser-Body]`, JSON.stringify(body, null, 2));
  
  sendUpdate({
    type: 'client_execute',
    data: { 
      method, 
      url: browserUrl, 
      body, 
      headers: { 'Content-Type': 'application/json' } 
    }
  });
  
  return `🚀 REST Command Sent: ${method} ${browserUrl}

👉 Now checking database for confirmation...`;
}

// ============================================================================
// AI AGENT LOOP (Strict REST Enforcer)
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  
  if (clarityObjects.size === 0) { 
    await getPool(); 
    await loadClarityObjects(); 
  }

  const dbStatus = dbConnected ? '✅ DB ONLINE' : '⚠️ DB OFFLINE';

  const systemPrompt = `You are **Clarity Master** - A strict REST-only assistant.

STATUS: ${dbStatus}

🛡️ **THE LAW (ABSOLUTE RULES):**

1. **NEVER WRITE SQL.** 
   - Do NOT use INSERT, UPDATE, or DELETE
   - The server will BLOCK you with error message
   - SQL is READ-ONLY for finding IDs and verification

2. **CREATE/UPDATE = REST ONLY.**
   - You MUST use \`trigger_browser_action\`
   - This is the ONLY way to modify data

3. **READ = SQL.**
   - Use \`execute_server_sql\` to find IDs and verify data
   - Use it to search metadata (lookups, NSQL)

🚀 **TASK CREATION WORKFLOW (3 Steps):**

**Step 1: Find Parent ID (SQL)**
User: "Create task in 'this_projd'"
You: \`SELECT ID, CODE, NAME FROM INV_INVESTMENTS WITH(NOLOCK) WHERE NAME LIKE '%this_projd%' OR CODE LIKE '%this_projd%'\`
Result: ID = 5004001

**Step 2: Create via REST (Browser)**
You: \`trigger_browser_action('POST', '/projects/5004001/tasks', { name: 'Maya' })\`
Note: System auto-fills dates/codes/status if missing

**Step 3: Verify Creation (SQL)**
You: \`SELECT TOP 5 ID, PRNAME, PRCODE FROM PRTASK WITH(NOLOCK) WHERE PRPROJECTID = 5004001 ORDER BY PRCREATED_DATE DESC\`
If found → Success! Report to user.

🔍 **SEARCHING METADATA:**
- Lookups/NSQL: \`SELECT * FROM CMN_NSQL_QUERIES WITH(NOLOCK) WHERE nsql_text LIKE '%KEYWORD%'\`
- Lookup Types: \`SELECT * FROM CMN_LOOKUP_TYPES WITH(NOLOCK) WHERE LOOKUP_TYPE LIKE '%KEYWORD%'\`
- Use LIKE search, not JOIN (columns vary by version)

⚠️ **CRITICAL:**
- ALWAYS use \`WITH(NOLOCK)\` in SELECT
- ALWAYS use \`TOP 100\` to limit results
- If you get SECURITY BLOCK error → use trigger_browser_action instead
- Never give up after one failed tool`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'execute_server_sql',
        description: 'READ-ONLY SQL. Used to find IDs, search Metadata (Lookups/NSQL), and Verify creation. CANNOT write data.',
        parameters: { 
          type: 'object', 
          properties: { 
            sqlQuery: { type: 'string' } 
          }, 
          required: ['sqlQuery'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'lookup_object',
        description: 'Get table name for standard object codes.',
        parameters: { 
          type: 'object', 
          properties: { 
            objectCode: { type: 'string' } 
          }, 
          required: ['objectCode'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'investigate_table',
        description: 'Check columns of a specific table.',
        parameters: { 
          type: 'object', 
          properties: { 
            tableName: { type: 'string' } 
          }, 
          required: ['tableName'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'trigger_browser_action',
        description: 'REST API. The ONLY way to Create/Update/Delete data in Clarity.',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['POST', 'PUT', 'DELETE'] 
            },
            endpoint: { type: 'string' },
            body: { type: 'object' }
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
  const MAX_ITERATIONS = 12;
  
  while (iteration < MAX_ITERATIONS) { 
    iteration++;
    sendUpdate({ type: 'thinking', data: `Reasoning... (${iteration}/${MAX_ITERATIONS})` });

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
          let args;
          
          try {
            args = JSON.parse(call.function.arguments);
          } catch (e) {
            console.error('[Tool] Parse error:', call.function.arguments);
            args = {};
          }
          
          sendUpdate({ type: 'tool', data: `🔧 ${fn}` });
          
          let res = '';
          try {
            if (fn === 'lookup_object') {
              res = await lookupObject(args.objectCode || '');
            }
            else if (fn === 'execute_server_sql') {
              res = await executeServerSQL(args.sqlQuery || '');
            }
            else if (fn === 'investigate_table') {
              res = await investigateTable(args.tableName || '');
            }
            else if (fn === 'trigger_browser_action') {
              res = await triggerBrowserAction(
                args.method || 'POST', 
                args.endpoint || '/', 
                args.body, 
                sendUpdate
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
        
        continue; // Next iteration
        
      } else {
        // Final answer
        sendUpdate({ type: 'complete', data: msg.content });
        return msg.content;
      }
      
    } catch (e: any) {
      console.error('[AI] Error:', e);
      sendUpdate({ type: 'error', data: `AI error: ${e.message}` });
      return `Error: ${e.message}`;
    }
  }
  
  return 'Investigation complete (max iterations reached)';
}

// ============================================================================
// SERVER SETUP
// ============================================================================
const app = express();

app.use(cors({ 
  origin: '*', 
  methods: ['GET', 'POST', 'OPTIONS'], 
  allowedHeaders: ['Content-Type'] 
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    version: 'v17.4-strict-rest-enforcer',
    database: dbConnected ? 'online' : 'offline',
    mode: dbConnected ? 'smart-mode' : 'remote-control-mode',
    objects: clarityObjects.size,
    features: [
      'strict-rest-enforcement',
      'sql-write-firewall',
      'auto-task-fields',
      'multi-step-reasoning',
      'like-search'
    ]
  });
});

const PORT = parseInt(process.env.PORT || '3001');
const HOST = '0.0.0.0';

app.post('/api/chat', async (req, res) => {
  console.log('[Chat] Request received');
  
  res.writeHead(200, { 
    'Content-Type': 'text/event-stream', 
    'Cache-Control': 'no-cache', 
    'Connection': 'keep-alive', 
    'Access-Control-Allow-Origin': '*' 
  });
  
  const send = (d: any) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  
  try { 
    await runAIAgentLoop(req.body.message, send); 
  } catch (e: any) { 
    console.error('[Chat] Error:', e);
    send({ type: 'error', data: e.message }); 
  }
  
  res.end();
});

app.listen(PORT, HOST, async () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 CLARITY MCP v17.4 STRICT REST ENFORCER`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🛡️ Features: REST-Only, SQL Firewall, Auto Defaults`);
  console.log('==========================================================');
  console.log('');
  
  await getPool();
  await loadClarityObjects();
  
  console.log('');
  console.log('==========================================================');
  console.log(`✅ Server Ready`);
  console.log(`📊 DB: ${dbConnected ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`🗺️ Objects: ${clarityObjects.size}`);
  console.log(`🛡️ SQL: READ-ONLY (Writes blocked)`);
  console.log('==========================================================');
  console.log('');
});
