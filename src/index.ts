#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v13.0 - SHERLOCK ARCHITECT (Deep Discovery)");
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
// DYNAMIC OBJECT DISCOVERY (Sherlock Intelligence!)
// ============================================================================
interface ClarityObject { 
  code: string; 
  name: string; 
  type: string; 
  table: string; 
  source: string; 
}

let clarityObjects: Map<string, ClarityObject> = new Map();

async function loadClarityObjects() {
  console.log('[Sherlock] Investigating System Metadata...');
  try {
    const db = await getPool();
    
    // 1. INVESTIGATE OBJECTS (Safe query - no CMN_SEC_OBJECTS join)
    const objectQuery = `
      SELECT 
        CODE, 
        NAME,
        'OBJECT' as OBJECT_TYPE_CODE,
        DATABASE_TABLE
      FROM ODF_OBJECTS WITH(NOLOCK)
      WHERE IS_ACTIVE = 1
    `;
    
    const objResult = await db.request().query(objectQuery);
    
    objResult.recordset.forEach((row: any) => {
      const code = row.CODE.toUpperCase();
      let table = row.DATABASE_TABLE;
      
      // Fallback logic if database_table is null
      if (!table) {
        if (code === 'PROJECT') table = 'INV_INVESTMENTS';
        else if (code === 'IDEA') table = 'INV_INVESTMENTS';
        else if (code === 'TASK') table = 'PRTASK';
        else if (code === 'RESOURCE') table = 'SRM_RESOURCES';
        else table = `ODF_CA_${code}`;
      }
      
      clarityObjects.set(code, {
        code: code,
        name: row.NAME,
        type: row.OBJECT_TYPE_CODE,
        table: table,
        source: 'OBJECT'
      });
    });

    // 2. INVESTIGATE NSQL QUERIES (For Reports/Portlets)
    try {
      const nsqlQuery = `SELECT code, name FROM CMN_NSQL_QUERIES WITH(NOLOCK)`;
      const nsqlResult = await db.request().query(nsqlQuery);
      nsqlResult.recordset.forEach((row: any) => {
        const code = row.code.toUpperCase();
        if (!clarityObjects.has(code)) {
          clarityObjects.set(code, { 
            code, 
            name: row.name, 
            type: 'NSQL', 
            table: 'CMN_NSQL_QUERIES', 
            source: 'NSQL' 
          });
        }
      });
    } catch (e: any) {
      console.log('[Sherlock] NSQL investigation skipped:', e.message);
    }

    // 3. INVESTIGATE LOOKUPS
    try {
      const lookupQuery = `SELECT lookup_type, lookup_name FROM CMN_LOOKUP_TYPES WITH(NOLOCK)`;
      const lookupResult = await db.request().query(lookupQuery);
      lookupResult.recordset.forEach((row: any) => {
        const code = row.lookup_type.toUpperCase();
        if (!clarityObjects.has(code)) {
          clarityObjects.set(code, { 
            code, 
            name: row.lookup_name, 
            type: 'LOOKUP', 
            table: 'CMN_LOOKUPS_V', 
            source: 'LOOKUP' 
          });
        }
      });
    } catch (e: any) {
      console.log('[Sherlock] Lookup investigation skipped:', e.message);
    }

    console.log(`✅ [Sherlock] Investigation Complete: ${clarityObjects.size} definitions found.`);
  } catch (error: any) {
    console.error(`❌ [Sherlock] Investigation Failed: ${error.message}`);
    console.log('[Sherlock] Using minimal fallback...');
    
    // Minimal fallback
    clarityObjects.set('PROJECT', { code: 'PROJECT', name: 'Project', type: 'OBJECT', table: 'INV_INVESTMENTS', source: 'FALLBACK' });
    clarityObjects.set('TASK', { code: 'TASK', name: 'Task', type: 'OBJECT', table: 'PRTASK', source: 'FALLBACK' });
    clarityObjects.set('RESOURCE', { code: 'RESOURCE', name: 'Resource', type: 'OBJECT', table: 'SRM_RESOURCES', source: 'FALLBACK' });
  }
}

// ============================================================================
// TOOL 1: DEEP INVESTIGATION (The "Sherlock" Tool)
// ============================================================================
async function investigateObject(identifier: string): Promise<string> {
  try {
    const db = await getPool();
    const search = identifier.toUpperCase();
    
    let report = `🕵️ **Investigation Report: ${search}**\n\n`;

    // 1. Check Object Definition
    const obj = clarityObjects.get(search);
    if (obj) {
      report += `**Type:** ${obj.type} (${obj.source})\n`;
      report += `**Name:** ${obj.name}\n`;
      report += `**Table:** ${obj.table}\n`;
      
      // If it's a table, get column count
      if (obj.table && obj.table !== 'N/A' && !obj.table.includes('CMN_')) {
        try {
          const countRes = await db.request().query(`
            SELECT COUNT(*) as C 
            FROM INFORMATION_SCHEMA.COLUMNS WITH(NOLOCK)
            WHERE TABLE_NAME = '${obj.table}'
          `);
          report += `**Columns:** ${countRes.recordset[0].C} columns available.\n`;
        } catch (e) {
          report += `**Columns:** Unable to count.\n`;
        }
      }
    } else {
      report += `**Status:** Not found in system registry.\n`;
    }

    // 2. Check for NSQL (If it's a query)
    try {
      const nsqlRes = await db.request().query(`
        SELECT nsql_text 
        FROM CMN_NSQL_QUERIES WITH(NOLOCK)
        WHERE UPPER(code) = '${search}'
      `);
      if (nsqlRes.recordset.length > 0) {
        report += `\n📜 **NSQL Definition Found!**\n`;
        report += `Query is stored in CMN_NSQL_QUERIES table.\n`;
      }
    } catch (e) {
      // Skip if table doesn't exist
    }

    // 3. Check for Lookup Values
    try {
      const lookupRes = await db.request().query(`
        SELECT COUNT(*) as C 
        FROM CMN_LOOKUPS_V WITH(NOLOCK)
        WHERE UPPER(LOOKUP_TYPE) = '${search}' 
        AND LANGUAGE_CODE = 'en'
      `);
      if (lookupRes.recordset[0].C > 0) {
        report += `\n🔎 **Lookup Values:** Found ${lookupRes.recordset[0].C} active values.\n`;
        report += `Query table: CMN_LOOKUPS_V\n`;
      }
    } catch (e) {
      // Skip if table doesn't exist
    }

    // 4. Schema Fuzzy Match (Find key columns)
    if (obj && obj.table && !obj.table.includes('CMN_')) {
      try {
        const keyCols = await db.request().query(`
          SELECT COLUMN_NAME 
          FROM INFORMATION_SCHEMA.COLUMNS WITH(NOLOCK)
          WHERE TABLE_NAME = '${obj.table}' 
          AND (
            COLUMN_NAME LIKE '%ID%' 
            OR COLUMN_NAME LIKE '%NAME%' 
            OR COLUMN_NAME LIKE '%CODE%' 
            OR COLUMN_NAME LIKE '%STATUS%'
          )
          ORDER BY ORDINAL_POSITION
        `);
        const cols = keyCols.recordset.map((r:any) => r.COLUMN_NAME).slice(0, 10).join(', ');
        if (cols) {
          report += `\n🔑 **Key Columns:** ${cols}\n`;
        }
      } catch (e) {
        // Skip if error
      }
    }

    return report;

  } catch (e: any) { 
    return `❌ Investigation failed: ${e.message}`; 
  }
}

// ============================================================================
// TOOL 2: SMART COLUMN SEARCH
// ============================================================================
async function searchColumns(tableName: string, keyword: string): Promise<string> {
  try {
    const db = await getPool();
    const query = `
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS WITH(NOLOCK)
      WHERE TABLE_NAME = '${tableName}' 
      AND COLUMN_NAME LIKE '%${keyword}%'
      ORDER BY ORDINAL_POSITION
    `;
    const res = await db.request().query(query);
    
    if (res.recordset.length === 0) {
      return `No columns found in '${tableName}' matching '${keyword}'.`;
    }
    
    return JSON.stringify(res.recordset, null, 2);
  } catch (e: any) { 
    return `Error: ${e.message}`; 
  }
}

// ============================================================================
// TOOL 3: SQL EXECUTION
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE'];
  const upperSQL = sqlQuery.toUpperCase();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `))) {
    return '❌ Security: Read-only mode. Use browser actions for writes.';
  }
  
  try {
    const db = await getPool();
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

// ============================================================================
// TOOL 4: BROWSER COMMAND (Remote Control!)
// ============================================================================
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
  
  return `✅ Command sent to browser: ${method} ${browserUrl}\n\nCheck browser console (F12) for execution result.`;
}

// ============================================================================
// AI AGENT LOOP (Sherlock Brain!)
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are **Clarity Sherlock** - A database detective with deep investigation skills.

🕵️ **INVESTIGATION METHODOLOGY:**
1. NEVER guess table names or columns
2. ALWAYS investigate first using available tools
3. VERIFY findings before executing queries
4. EXPLAIN your reasoning

🔍 **YOUR TOOLS:**

1. **investigate_object(identifier)**: Find where data lives
   - Example: investigate_object('TASK') → Returns table: PRTASK
   - Use this FIRST for any object-related query

2. **search_columns(tableName, keyword)**: Find real column names
   - Example: search_columns('PRTASK', 'ACTIVE') → Finds actual column
   - Use when you need to find status, active, or any field

3. **execute_server_sql(query)**: Run SELECT queries
   - Use AFTER investigation
   - Always use WITH(NOLOCK) and TOP

4. **trigger_browser_action(method, endpoint, body)**: Create/Update via browser
   - Only for write operations
   - Browser has user's session

💡 **INVESTIGATION PATTERN:**

User: "How many active tasks?"

Step 1: investigate_object('TASK')
→ Found: Table is PRTASK

Step 2: search_columns('PRTASK', 'STATUS')  
→ Found: PRSTATUS column (not IS_ACTIVE!)

Step 3: execute_server_sql
→ SELECT COUNT(*) FROM PRTASK WITH(NOLOCK) WHERE PRSTATUS != 2

🎯 **KEY FACTS:**
- Tasks: Table = PRTASK, Active = PRSTATUS != 2
- Projects: Table = INV_INVESTMENTS, Active = IS_ACTIVE = 1
- Resources: Table = SRM_RESOURCES

⚠️ **RULES:**
- Always use WITH(NOLOCK) in queries
- Use TOP not LIMIT
- Find numeric IDs before REST calls
- Explain your investigation steps`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'investigate_object',
        description: 'Find metadata about any Clarity object (table name, type, columns). Use this FIRST!',
        parameters: { 
          type: 'object', 
          properties: { 
            identifier: { 
              type: 'string',
              description: 'Object code like PROJECT, TASK, RESOURCE'
            } 
          }, 
          required: ['identifier'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_columns',
        description: 'Search for column names in a table. Use to find STATUS, ACTIVE, NAME columns.',
        parameters: { 
          type: 'object', 
          properties: { 
            tableName: { 
              type: 'string',
              description: 'Database table name like PRTASK, INV_INVESTMENTS'
            }, 
            keyword: { 
              type: 'string',
              description: 'Search keyword like STATUS, ACTIVE, NAME'
            } 
          }, 
          required: ['tableName', 'keyword'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'execute_server_sql',
        description: 'Execute SELECT query. Use AFTER investigation.',
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
        description: 'Send command to browser for CREATE/UPDATE operations.',
        parameters: {
          type: 'object', 
          properties: { 
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PUT', 'DELETE']
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

  // Multi-step reasoning loop
  let iteration = 0;
  while (iteration < 10) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Investigating... (${iteration}/10)` });

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
        sendUpdate({ type: 'tool', data: `🔍 ${fn}` });
        
        let res = '';
        try {
          if (fn === 'investigate_object') {
            res = await investigateObject(args.identifier);
          }
          else if (fn === 'search_columns') {
            res = await searchColumns(args.tableName, args.keyword);
          }
          else if (fn === 'execute_server_sql') {
            res = await executeServerSQL(args.sqlQuery);
          }
          else if (fn === 'trigger_browser_action') {
            res = await triggerBrowserAction(args.method, args.endpoint, args.body, sendUpdate);
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
  
  return 'Investigation complete';
}

// ============================================================================
// SERVER SETUP
// ============================================================================
const app = express();

// CORS must be first!
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    version: 'v13.0-sherlock',
    database: pool?.connected ? 'connected' : 'disconnected',
    objects: clarityObjects.size,
    features: [
      'sherlock-investigation',
      'deep-discovery',
      'smart-column-search',
      'remote-control',
      'hybrid-intelligence'
    ]
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
    send({ type: 'error', data: e.message }); 
  }
  
  res.end();
});

const PORT = 3001;
app.listen(PORT, async () => {
  console.log('');
  console.log('==========================================================');
  console.log(`🚀 Clarity MCP v13.0 SHERLOCK ARCHITECT`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`🕵️ Mode: Deep Discovery + Investigation`);
  console.log(`🎮 Control: Remote Browser Execution`);
  console.log('==========================================================');
  console.log('');
  
  await getPool();
  await loadClarityObjects();
});
