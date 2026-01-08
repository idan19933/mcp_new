#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v18.0 - READ-ONLY (Queries Only)");
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
// TOOLS - READ-ONLY
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  if (!dbConnected) {
    await getPool();
    if (!dbConnected) {
      return '⚠️ DB Offline. Cannot query data.';
    }
  }
  
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'CREATE'];
  const upperSQL = sqlQuery.toUpperCase();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `) || upperSQL.includes(`\n${w} `) || upperSQL.startsWith(w))) {
    return `⛔ SECURITY BLOCK: This is a READ-ONLY system. Only SELECT queries allowed.`;
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
    
    const colList = cols.recordset.map((c: any) => c.COLUMN_NAME).slice(0, 30);
    
    return `✅ Table: ${tableName} (${cols.recordset.length} columns)
Columns: ${colList.join(', ')}${cols.recordset.length > 30 ? '...' : ''}`;
    
  } catch (e: any) { 
    return `Investigation failed: ${e.message}`; 
  }
}

async function lookupObject(objectCode: string): Promise<string> {
  const code = objectCode.toUpperCase();
  const obj = clarityObjects.get(code);
  
  if (!obj) {
    return `❌ Object '${objectCode}' not found. Try: execute_server_sql("SELECT CODE FROM ODF_OBJECTS WITH(NOLOCK) WHERE CODE LIKE '%${objectCode}%'")`;
  }
  
  return `✅ Object: ${obj.code}
Table: ${obj.table}`;
}

// ============================================================================
// AI AGENT LOOP - READ-ONLY
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  
  if (clarityObjects.size === 0) { 
    await getPool(); 
    await loadClarityObjects(); 
  }

  const dbStatus = dbConnected ? '✅ DB ONLINE' : '⚠️ DB OFFLINE';

  const systemPrompt = `You are **Clarity Master** - A READ-ONLY database assistant.

STATUS: ${dbStatus}

🎯 **YOUR PURPOSE:**
- Answer questions about Clarity data
- Find information in the database
- Analyze data and provide insights
- Search for projects, tasks, resources, etc.

🔍 **AVAILABLE TOOLS:**
1. \`execute_server_sql\` - Run SELECT queries
2. \`lookup_object\` - Find table names for objects
3. \`investigate_table\` - See table columns

⚠️ **CRITICAL RULES:**
- This is READ-ONLY! You can only SELECT data, not modify it
- ALWAYS use \`WITH(NOLOCK)\` in SELECT queries
- ALWAYS use \`TOP 100\` to limit results
- Use LIKE for flexible searching: \`WHERE NAME LIKE '%search%'\`

📊 **COMMON QUERIES:**

**Find Projects:**
\`SELECT TOP 10 ID, CODE, NAME FROM INV_INVESTMENTS WITH(NOLOCK) WHERE NAME LIKE '%keyword%'\`

**Count Projects:**
\`SELECT COUNT(*) as total FROM INV_INVESTMENTS WITH(NOLOCK)\`

**Find Tasks:**
\`SELECT TOP 10 PRID, PRNAME, PRPROJECTID FROM PRTASK WITH(NOLOCK) WHERE PRNAME LIKE '%keyword%'\`

**Find Lookups:**
\`SELECT TOP 10 LOOKUP_TYPE, LOOKUP_NAME FROM CMN_LOOKUP_TYPES WITH(NOLOCK) WHERE LOOKUP_TYPE LIKE '%keyword%'\`

**Search NSQL:**
\`SELECT TOP 10 QUERY_CODE, NSQL_TEXT FROM CMN_NSQL_QUERIES WITH(NOLOCK) WHERE NSQL_TEXT LIKE '%keyword%'\`

🧠 **SEARCH STRATEGY:**
1. If user asks about an object → use \`lookup_object\` first
2. Then use \`execute_server_sql\` to query the table
3. For metadata (lookups, queries) → search directly with SQL
4. Always provide clear, concise answers

💡 **EXAMPLES:**

User: "How many projects?"
You: \`execute_server_sql("SELECT COUNT(*) as total FROM INV_INVESTMENTS WITH(NOLOCK)")\`

User: "Find charge code lookup"
You: \`execute_server_sql("SELECT * FROM CMN_LOOKUP_TYPES WITH(NOLOCK) WHERE LOOKUP_TYPE LIKE '%CHARGE%'")\`

User: "Show me tasks in project this_proj"
You: \`execute_server_sql("SELECT p.ID FROM INV_INVESTMENTS p WITH(NOLOCK) WHERE p.CODE LIKE '%this_proj%'")\`
Then: \`execute_server_sql("SELECT TOP 10 PRID, PRNAME FROM PRTASK WITH(NOLOCK) WHERE PRPROJECTID = [found_id]")\``;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'execute_server_sql',
        description: 'Run READ-ONLY SQL queries (SELECT only)',
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
        description: 'Find table name for a Clarity object code',
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
        description: 'Get column information for a table',
        parameters: { 
          type: 'object', 
          properties: { 
            tableName: { type: 'string' } 
          }, 
          required: ['tableName'] 
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
  allowedHeaders: ['Content-Type'] 
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    version: 'v18.0-read-only',
    database: dbConnected ? 'online' : 'offline',
    mode: 'read-only',
    objects: clarityObjects.size,
    features: [
      'sql-queries',
      'table-investigation',
      'object-lookup',
      'read-only-enforced',
      'multi-step-reasoning'
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
  console.log(`🚀 CLARITY MCP v18.0 READ-ONLY`);
  console.log(`📡 Server: http://${HOST}:${PORT}`);
  console.log(`🏥 Health: http://${HOST}:${PORT}/health`);
  console.log(`📖 Mode: READ-ONLY (Queries Only)`);
  console.log('==========================================================');
  console.log('');
  
  await getPool();
  await loadClarityObjects();
  
  console.log('');
  console.log('==========================================================');
  console.log(`✅ Server Ready`);
  console.log(`📊 DB: ${dbConnected ? 'ONLINE' : 'OFFLINE'}`);
  console.log(`🗺️ Objects: ${clarityObjects.size}`);
  console.log(`🔒 Mode: READ-ONLY`);
  console.log('==========================================================');
  console.log('');
});
