#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v16.0 - UNSTOPPABLE EDITION");
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

// ============================================================================
// ROBUST CONNECTION (Never Crashes!)
// ============================================================================
let pool: sql.ConnectionPool | null = null;
let dbConnected = false;

async function getPool() {
  if (pool?.connected) {
    dbConnected = true;
    return pool;
  }
  
  try {
    console.log('🔌 Connecting to Database...');
    pool = await new sql.ConnectionPool(DB_CONFIG).connect();
    console.log('✅ Database Connected Successfully');
    dbConnected = true;
    pool.on('error', (err: any) => {
      console.error('Pool Error:', err);
      dbConnected = false;
    });
    return pool;
  } catch (err: any) {
    // v16 CHANGE: DO NOT THROW! Just log and continue.
    console.error(`⚠️ Database Connection Failed: ${err.message}`);
    console.log('⚠️ Server starting in "Resilient Mode" (Remote Control only)');
    dbConnected = false;
    return null;
  }
}

// ============================================================================
// HYBRID OBJECT MAP (v15 Smarts + v4 Reliability)
// ============================================================================
interface ClarityObject { code: string; name: string; table: string; }
let clarityObjects: Map<string, ClarityObject> = new Map();

// The "Bulldozer" Map (Always works)
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
  
  // Always load core map first (Zero dependency)
  Object.entries(CORE_MAPPING).forEach(([code, table]) => {
    clarityObjects.set(code, { code, name: code, table });
  });
  
  console.log(`✅ Core map loaded: ${clarityObjects.size} core objects`);

  if (!dbConnected) {
    console.log('⚠️ Skipping dynamic object loading (DB offline)');
    return;
  }

  try {
    const db = await getPool();
    if (!db) return;
    
    // Try to get dynamic objects (without NAME or IS_ACTIVE that don't exist)
    const result = await db.request().query("SELECT CODE FROM ODF_OBJECTS");
    
    result.recordset.forEach((row: any) => {
      const code = row.CODE.toUpperCase();
      // Use core mapping if exists, else generic ODF_CA_ pattern
      const table = CORE_MAPPING[code] || `ODF_CA_${code}`;
      
      if (!clarityObjects.has(code)) {
        clarityObjects.set(code, { code, name: code, table });
      }
    });
    
    console.log(`✅ Enhanced map: Total ${clarityObjects.size} objects (${clarityObjects.size - Object.keys(CORE_MAPPING).length} custom)`);
  } catch (e: any) { 
    console.warn(`⚠️ Dynamic mapping failed: ${e.message}`); 
    console.log('✅ Using core map only');
  }
}

// ============================================================================
// TOOLS (Smart Switching)
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  if (!dbConnected) {
    // Re-try connection just in case it was a temporary glitch
    await getPool();
    if (!dbConnected) {
      return '⚠️ Database is currently unreachable. I cannot run SQL analysis right now.';
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

// Schema Investigator (Only works if DB is online)
async function investigateTable(tableName: string): Promise<string> {
  if (!dbConnected) {
    return `⚠️ Cannot investigate schema (DB Offline). Assuming table '${tableName}' exists.`;
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
      return `Table '${tableName}' not found in database.`;
    }
    
    const colNames = cols.recordset.map((c: any) => c.COLUMN_NAME);
    const keyCols = colNames.filter((c: string) => 
      c.includes('ID') || c.includes('CODE') || c.includes('NAME')
    );
    
    return `✅ Table: ${tableName}
Columns: ${cols.recordset.length}
Key columns: ${keyCols.slice(0, 10).join(', ')}`;
    
  } catch (e: any) { 
    return `Investigation failed: ${e.message}`; 
  }
}

async function lookupObject(objectCode: string): Promise<string> {
  const code = objectCode.toUpperCase();
  const obj = clarityObjects.get(code);
  
  if (!obj) {
    return `❌ Object '${objectCode}' not found.

Available: ${Array.from(clarityObjects.keys()).slice(0, 20).join(', ')}...`;
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
  
  return `✅ Command sent to browser: ${method} ${browserUrl}

Check browser console (F12) for result!`;
}

// ============================================================================
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  
  // Ensure we try to load objects at least once
  if (clarityObjects.size === 0) {
    await getPool();
    await loadClarityObjects();
  }

  const dbStatus = dbConnected ? '✅ DB ONLINE (Smart Mode)' : '⚠️ DB OFFLINE (Remote Control Mode)';

  const systemPrompt = `You are **Clarity Assistant**.

STATUS: ${dbStatus}

🧠 **STRATEGY**:

1. **READ/ANALYSIS** (if DB is ONLINE):
   - Use lookup_object('PROJECT') to find table names
   - Use execute_server_sql to query data
   - Use investigate_table to check columns

2. **CREATE/UPDATE** (works always):
   - Use trigger_browser_action for all modifications
   - If DB offline and you need ID, ask user for numeric ID

💡 **TABLE MAP**:
- PROJECT/IDEA → INV_INVESTMENTS
- TASK → PRTASK  
- RESOURCE → SRM_RESOURCES
- Custom → ODF_CA_{CODE}

⚠️ **RULES**:
- Always use WITH(NOLOCK) in SELECT
- Use TOP not LIMIT
- Find numeric IDs before REST calls
- If DB offline, explain limitations`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_object',
        description: 'Get table name for object code',
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
        name: 'execute_server_sql',
        description: 'Run SQL query (only if DB online)',
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
        name: 'investigate_table',
        description: 'Check table schema',
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
        description: 'Send command to browser (works always)',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['GET', 'POST', 'PUT', 'DELETE'] 
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

    if (!msg) {
      throw new Error('Invalid AI response');
    }

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
              args.method || 'GET', 
              args.endpoint || '/', 
              args.body, 
              sendUpdate
            );
          }
          else {
            res = `Unknown tool: ${fn}`;
          }
          
          sendUpdate({ type: 'step', data: '✅' });
        } catch (e: any) {
          console.error(`[Tool] Error in ${fn}:`, e);
          res = `Error: ${e.message}`;
          sendUpdate({ type: 'step', data: '❌' });
        }
        
        messages.push({ 
          role: 'tool', 
          tool_call_id: call.id, 
          content: res 
        });
      }
      
      // Get final answer
      const finalRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${OPENAI_API_KEY}` 
        },
        body: JSON.stringify({ 
          model: 'gpt-4o', 
          messages 
        })
      });
      
      const finalData: any = await finalRes.json();
      sendUpdate({ type: 'complete', data: finalData.choices[0].message.content });
      
    } else {
      sendUpdate({ type: 'complete', data: msg.content });
    }
    
  } catch (e: any) {
    console.error('[AI] Error:', e);
    sendUpdate({ type: 'error', data: `AI error: ${e.message}` });
  }
}

// ============================================================================
// SERVER SETUP (Unstoppable)
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
    version: 'v16.0-unstoppable',
    database: dbConnected ? 'online' : 'offline',
    mode: dbConnected ? 'smart-mode' : 'remote-control-mode',
    objects: clarityObjects.size
  });
});

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

const PORT = parseInt(process.env.PORT || '3001');
const HOST = '0.0.0.0'; // ← CRITICAL: Listen on all interfaces (Railway needs this!)

app.listen(PORT, HOST, async () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 CLARITY MCP v16.0 UNSTOPPABLE`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log('==========================================================');
  console.log('');
  
  // We try to connect, but we DO NOT crash if it fails.
  await getPool(); 
  await loadClarityObjects();
  
  console.log('');
  console.log('==========================================================');
  console.log(`✅ Server is READY`);
  console.log(`📊 DB Status: ${dbConnected ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`🗺️ Objects: ${clarityObjects.size} mapped`);
  console.log(`🎯 Mode: ${dbConnected ? 'Smart Mode' : 'Remote Control Mode'}`);
  console.log('==========================================================');
  console.log('');
});
