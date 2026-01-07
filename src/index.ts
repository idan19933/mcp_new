#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v17.0 - DEEP DIVER (Lookups & NSQL)");
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
  
  // Always load core map first
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
// TOOLS
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  if (!dbConnected) {
    await getPool(); // Retry connection
    if (!dbConnected) {
      return '⚠️ Database is currently unreachable. I cannot run SQL analysis.';
    }
  }
  
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE'];
  const upperSQL = sqlQuery.toUpperCase();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `) || upperSQL.includes(`\n${w} `))) {
    return '❌ Security: SQL is Read-Only. Use browser actions for updates.';
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
  if (!dbConnected) {
    return `⚠️ DB Offline. Assuming table '${tableName}' exists.`;
  }
  
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
    return `❌ Object '${objectCode}' not found in ODF_OBJECTS.

💡 **SMART TIP:** 
- If you are looking for a LOOKUP, check table 'CMN_LOOKUP_TYPES'.
- If you are looking for NSQL, check table 'CMN_NSQL_QUERIES'.
- Try using 'execute_server_sql' to search those tables directly.`;
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
  
  console.log(`[Browser-CMD] ${method} ${browserUrl}`);
  
  sendUpdate({
    type: 'client_execute',
    data: { 
      method, 
      url: browserUrl, 
      body, 
      headers: { 'Content-Type': 'application/json' } 
    }
  });
  
  return `✅ Command sent to browser: ${method} ${browserUrl}`;
}

// ============================================================================
// AI AGENT LOOP (The New "Deep Diver" Brain)
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  
  if (clarityObjects.size === 0) { 
    await getPool(); 
    await loadClarityObjects(); 
  }

  const dbStatus = dbConnected ? '✅ DB ONLINE' : '⚠️ DB OFFLINE';

  const systemPrompt = `You are **Clarity Master** - A persistent investigator who NEVER gives up after one tool.

STATUS: ${dbStatus}

🧠 **KNOWLEDGE BASE (Where to find things):**

1. **Standard Objects** (Project, Task, etc.):
   - Use \`lookup_object('PROJECT')\` to find the table.
   - Table is usually \`INV_INVESTMENTS\` or \`PRTASK\`.

2. **Lookups & Lists**:
   - These are NOT objects. Do not use \`lookup_object\`.
   - **SEARCH THEM** using SQL:
     \`SELECT * FROM CMN_LOOKUP_TYPES WITH(NOLOCK) WHERE LOOKUP_TYPE LIKE '%Charge%'\`
   - Values are in \`CMN_LOOKUPS_V\`.

3. **NSQL Queries**:
   - Stored in table: \`CMN_NSQL_QUERIES\`.
   - Search them:
     \`SELECT code, nsql_text FROM CMN_NSQL_QUERIES WITH(NOLOCK) WHERE code LIKE '%Charge%'\`

4. **Process/Workflows**:
   - Stored in \`BPM_DEF_PROCESS_VERSIONS\` or \`BPM_RUN_PROCESSES\`.

🚀 **CRITICAL STRATEGY - YOU MUST FOLLOW THIS:**

Step 1: Try the most obvious tool first
Step 2: If that fails, IMMEDIATELY try alternative approach
Step 3: Keep trying until you find the answer
Step 4: ONLY give final answer after you've found real data

**EXAMPLE - Finding Lookups:**
User: "Find Active Charge Code lookup"

YOUR THINKING:
Iteration 1: Try lookup_object('Active Charge Code')
→ Result: Not found (because it's a lookup, not an object)
→ DECISION: Switch strategy!

Iteration 2: Search CMN_LOOKUP_TYPES
→ execute_server_sql("SELECT * FROM CMN_LOOKUP_TYPES WHERE LOOKUP_TYPE LIKE '%Charge%'")
→ Result: Found LOOKUP_TYPE = 'CHG_CODE'
→ DECISION: Now get the values!

Iteration 3: Get lookup values
→ execute_server_sql("SELECT * FROM CMN_LOOKUPS_V WHERE LOOKUP_TYPE = 'CHG_CODE'")
→ Result: Got 50 charge codes
→ DECISION: Now I have complete answer!

Iteration 4: Give final answer with data

⚠️ **ABSOLUTE RULES:**
- NEVER give final answer after just ONE tool call
- If lookup_object fails, ALWAYS try execute_server_sql
- Always use \`WITH(NOLOCK)\`
- Always use \`TOP 100\` or similar limit
- Keep going until you have REAL DATA to show the user`;


  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'execute_server_sql',
        description: 'Run ANY SQL query. Use this to search tables, lookups, and NSQL.',
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
        description: 'Check if something is a Standard Object (Project, Task). Fails for Lookups/NSQL.',
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
        description: 'Check columns of a known table.',
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
        description: 'Create/Update data via Browser.',
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
  while (iteration < 10) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Reasoning... (${iteration}/10)` });

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
// SERVER
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
    version: 'v17.0-deep-diver',
    database: dbConnected ? 'online' : 'offline',
    mode: dbConnected ? 'smart-mode' : 'remote-control-mode',
    objects: clarityObjects.size,
    features: [
      'deep-diving',
      'lookup-search',
      'nsql-search',
      'multi-strategy',
      'never-gives-up'
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
  console.log(`🚀 CLARITY MCP v17.0 DEEP DIVER`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔍 Features: Lookups, NSQL, Multi-Strategy Intelligence`);
  console.log('==========================================================');
  console.log('');
  
  await getPool();
  await loadClarityObjects();
  
  console.log('');
  console.log('==========================================================');
  console.log(`✅ Server Ready`);
  console.log(`📊 DB: ${dbConnected ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`🗺️ Objects: ${clarityObjects.size}`);
  console.log('==========================================================');
  console.log('');
});
