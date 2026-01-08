#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v17.3 - SEARCH ENGINE (Smart NSQL Finder)");
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
// TOOLS
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  if (!dbConnected) {
    await getPool();
    if (!dbConnected) {
      return '⚠️ DB Offline. Cannot verify data.';
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
    return `❌ Object '${objectCode}' not found. Try searching via SQL.`;
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
  
  // Auto-add required fields for task creation
  if (endpoint.includes('tasks') && method === 'POST') {
    if (!body.start) body.start = new Date().toISOString();
    if (!body.finish) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      body.finish = tomorrow.toISOString();
    }
    if (!body.status) body.status = 'NOT_STARTED';
  }
  
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
  
  return `🚀 Command sent to browser: ${method} ${browserUrl}

⚠️ **WAIT & VERIFY:** Check database for result.`;
}

// ============================================================================
// AI AGENT LOOP (The Search Engine Brain)
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  
  if (clarityObjects.size === 0) { 
    await getPool(); 
    await loadClarityObjects(); 
  }

  const dbStatus = dbConnected ? '✅ DB ONLINE' : '⚠️ DB OFFLINE';

  const systemPrompt = `You are **Clarity Master** - A smart search engine for Clarity PPM.

STATUS: ${dbStatus}

🔍 **SEARCH STRATEGY (How to find things):**

1. **FINDING NSQL FOR LOOKUPS:**
   - The Lookup ID is often INSIDE the SQL text itself!
   - **Smart Search:** \`SELECT query_code, nsql_text FROM CMN_NSQL_QUERIES WITH(NOLOCK) WHERE nsql_text LIKE '%LOOKUP_ID_HERE%'\`
   - Example: Looking for 'LOOKUP_CHARGE_CODES'? Search: \`WHERE nsql_text LIKE '%LOOKUP_CHARGE_CODES%'\`
   - **DO NOT** try to join tables unless you're 100% sure of column names

2. **FINDING LOOKUP DEFINITIONS:**
   - Search: \`SELECT * FROM CMN_LOOKUP_TYPES WITH(NOLOCK) WHERE LOOKUP_TYPE LIKE '%SEARCH_TERM%'\`

3. **FINDING LOOKUP VALUES:**
   - Search: \`SELECT * FROM CMN_LOOKUPS_V WITH(NOLOCK) WHERE LOOKUP_TYPE = 'EXACT_TYPE' AND LANGUAGE_CODE = 'en'\`

4. **FINDING OBJECT TABLES:**
   - Use \`lookup_object\` first
   - If fails: \`SELECT code FROM ODF_OBJECTS WITH(NOLOCK) WHERE code LIKE '%SEARCH%'\`

5. **CREATING TASKS/RECORDS:**
   - Use \`trigger_browser_action\`
   - Always verify afterwards with SQL

⚠️ **CRITICAL RULES:**
- ALWAYS use \`WITH(NOLOCK)\`
- ALWAYS use \`TOP 100\` to limit results  
- Use LIKE search for flexible matching
- Never give up after one failed tool
- Verify all creations with SELECT query`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'execute_server_sql',
        description: 'Run SQL query. Best tool for searching NSQL, Lookups, and verification.',
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
        description: 'Check table names for standard objects.',
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
        description: 'Send Create/Update command to browser.',
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
    version: 'v17.3-search-engine',
    database: dbConnected ? 'online' : 'offline',
    mode: dbConnected ? 'smart-mode' : 'remote-control-mode',
    objects: clarityObjects.size,
    features: [
      'like-search',
      'nsql-finder',
      'auto-task-fields',
      'multi-step-reasoning',
      'smart-search-engine'
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
  console.log(`🚀 CLARITY MCP v17.3 SEARCH ENGINE`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`🔍 Features: LIKE Search, Smart NSQL Finder, Auto Fields`);
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
