#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v15.0 - UNIVERSAL TRUTH EDITION");
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
// OBJECT MAP (Hardcoded - No DATABASE_TABLE column exists!)
// ============================================================================
interface ClarityObject { 
  code: string; 
  name: string; 
  table: string; 
}

let clarityObjects: Map<string, ClarityObject> = new Map();

// Known Core Mappings (These NEVER change in Clarity)
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
  console.log('[Universal] Mapping System Objects...');
  try {
    const db = await getPool();
    
    // Query only CODE and NAME (DATABASE_TABLE doesn't exist!)
    const query = `
      SELECT CODE, NAME 
      FROM ODF_OBJECTS WITH(NOLOCK)
      WHERE IS_ACTIVE = 1
    `;
    
    const result = await db.request().query(query);
    
    result.recordset.forEach((row: any) => {
      const code = row.CODE.toUpperCase();
      let table = CORE_MAPPING[code];
      
      // If not a core object, assume Custom Object pattern
      if (!table) {
        table = `ODF_CA_${code}`;
      }
      
      clarityObjects.set(code, {
        code: code,
        name: row.NAME,
        table: table
      });
    });

    console.log(`✅ [Universal] Mapped ${clarityObjects.size} objects`);
    console.log(`   Core Objects: ${Object.keys(CORE_MAPPING).length} (hardcoded)`);
    console.log(`   Custom Objects: ${clarityObjects.size - Object.keys(CORE_MAPPING).length} (ODF_CA_ pattern)`);

  } catch (error: any) {
    console.error(`❌ [Universal] Mapping failed: ${error.message}`);
    console.log('[Universal] Using minimal fallback...');
    
    // Minimal fallback
    Object.entries(CORE_MAPPING).forEach(([code, table]) => {
      clarityObjects.set(code, {
        code: code,
        name: code,
        table: table
      });
    });
  }
}

// ============================================================================
// TOOL 1: TABLE INVESTIGATOR (Schema Discovery)
// ============================================================================
async function investigateTable(tableName: string): Promise<string> {
  try {
    const db = await getPool();
    
    // 1. Verify table exists
    const check = await db.request().query(`
      SELECT OBJECT_ID('${tableName}') as ID
    `);
    
    if (!check.recordset[0].ID) {
      return `❌ Table '${tableName}' does not exist in database.`;
    }

    // 2. Get ALL columns
    const cols = await db.request().query(`
      SELECT 
        COLUMN_NAME, 
        DATA_TYPE, 
        CHARACTER_MAXIMUM_LENGTH,
        IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS WITH(NOLOCK)
      WHERE TABLE_NAME = '${tableName}'
      ORDER BY ORDINAL_POSITION
    `);
    
    // 3. Categorize columns
    const allCols = cols.recordset.map((c: any) => c.COLUMN_NAME);
    
    const keyCols = allCols.filter((c: string) => 
      c.includes('ID') || c.includes('NAME') || c.includes('CODE')
    );
    
    const statusCols = allCols.filter((c: string) => 
      c.includes('STATUS') || c.includes('ACTIVE') || c.includes('STATE')
    );
    
    const dateCols = allCols.filter((c: string) => 
      c.includes('DATE') || c.includes('TIME')
    );

    return `✅ **Table: ${tableName}**

**Total Columns:** ${allCols.length}

**Key Columns:**
${keyCols.length > 0 ? keyCols.join(', ') : 'None found'}

**Status Columns:**
${statusCols.length > 0 ? statusCols.join(', ') : 'None found'}

**Date Columns:**
${dateCols.length > 0 ? dateCols.slice(0, 5).join(', ') : 'None found'}

**All Columns (first 50):**
${allCols.slice(0, 50).join(', ')}`;

  } catch (e: any) { 
    return `❌ Error investigating table: ${e.message}`; 
  }
}

// ============================================================================
// TOOL 2: COLUMN SEARCH (Find specific columns)
// ============================================================================
async function findColumn(tableName: string, keyword: string): Promise<string> {
  try {
    const db = await getPool();
    
    const query = `
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS WITH(NOLOCK)
      WHERE TABLE_NAME = '${tableName}' 
      AND COLUMN_NAME LIKE '%${keyword.toUpperCase()}%'
      ORDER BY COLUMN_NAME
    `;
    
    const res = await db.request().query(query);
    
    if (res.recordset.length === 0) {
      return `No columns found in '${tableName}' matching '${keyword}'.

**Suggestion:** Try broader keywords like:
- For active records: STATUS, STATE, OPEN
- For names: NAME, TITLE, DESCRIPTION
- For codes: CODE, KEY, ID`;
    }
    
    const found = res.recordset.map((r: any) => 
      `${r.COLUMN_NAME} (${r.DATA_TYPE})`
    ).join(', ');
    
    return `Found ${res.recordset.length} column(s): ${found}`;
    
  } catch (e: any) { 
    return `❌ Error searching columns: ${e.message}`; 
  }
}

// ============================================================================
// TOOL 3: OBJECT LOOKUP (Get table for object code)
// ============================================================================
async function lookupObject(objectCode: string): Promise<string> {
  const code = objectCode.toUpperCase();
  const obj = clarityObjects.get(code);
  
  if (!obj) {
    return `❌ Object '${objectCode}' not found.

**Available objects:** ${Array.from(clarityObjects.keys()).slice(0, 20).join(', ')}...`;
  }
  
  return `✅ **Object: ${obj.code}**
**Name:** ${obj.name}
**Table:** ${obj.table}

**Next:** Use investigate_table('${obj.table}') to see columns.`;
}

// ============================================================================
// TOOL 4: SQL EXECUTION
// ============================================================================
async function executeServerSQL(sqlQuery: string): Promise<string> {
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE'];
  const upperSQL = sqlQuery.toUpperCase();
  
  if (forbidden.some(w => upperSQL.includes(` ${w} `) || upperSQL.includes(`\n${w} `))) {
    return '❌ Security: Read-only mode. Use browser actions for writes.';
  }
  
  try {
    const db = await getPool();
    console.log(`[SQL] ${sqlQuery}`);
    
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed successfully. No results found.';
    }
    
    return JSON.stringify(result.recordset.slice(0, 100), null, 2);
    
  } catch (e: any) { 
    return `❌ SQL Error: ${e.message}

**Tip:** Check:
- Table name spelling
- Column name spelling  
- Use WITH(NOLOCK) for reads
- Use TOP instead of LIMIT`; 
  }
}

// ============================================================================
// TOOL 5: BROWSER COMMAND (Remote Control)
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
  
  return `✅ **Command sent to browser**

**Action:** ${method} ${browserUrl}

**Check browser console (F12) for execution result!**`;
}

// ============================================================================
// AI AGENT LOOP (Multi-turn Reasoning)
// ============================================================================
async function runAIAgentLoop(userMessage: string, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are **Clarity Sherlock** - A database detective.

🔍 **YOUR INVESTIGATION METHOD:**

1. **TRANSLATE**: Object code → Table name
   - Use lookup_object('PROJECT') → INV_INVESTMENTS
   
2. **VERIFY**: Check table structure
   - Use investigate_table('INV_INVESTMENTS') → See all columns
   
3. **SEARCH**: Find specific columns
   - Use find_column('PRTASK', 'STATUS') → PRSTATUS
   
4. **EXECUTE**: Run perfect SQL
   - execute_server_sql("SELECT...") → Results

🧠 **CORE TABLE MAP:**
- PROJECT/IDEA → INV_INVESTMENTS
- TASK → PRTASK
- RESOURCE → SRM_RESOURCES
- ASSIGNMENT → PRASSIGNMENT
- Custom Objects → ODF_CA_{CODE}

💡 **INVESTIGATION PATTERN:**

User: "How many active tasks?"

Step 1: lookup_object('TASK')
→ Table: PRTASK

Step 2: find_column('PRTASK', 'ACTIVE')
→ No results

Step 3: find_column('PRTASK', 'STATUS')
→ Found: PRSTATUS

Step 4: execute_server_sql
→ SELECT COUNT(*) FROM PRTASK WITH(NOLOCK) WHERE PRSTATUS != 2

⚠️ **CRITICAL RULES:**
- ALWAYS use WITH(NOLOCK) in SELECT
- Use TOP not LIMIT
- Find numeric IDs before REST calls
- Explain your investigation steps
- If column not found, try broader keywords`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_object',
        description: 'Get table name for an object code (PROJECT, TASK, etc.)',
        parameters: { 
          type: 'object', 
          properties: { 
            objectCode: { 
              type: 'string',
              description: 'Object code like PROJECT, TASK, RESOURCE'
            } 
          }, 
          required: ['objectCode'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'investigate_table',
        description: 'Get all columns and structure of a table',
        parameters: { 
          type: 'object', 
          properties: { 
            tableName: { 
              type: 'string',
              description: 'Table name like INV_INVESTMENTS, PRTASK'
            } 
          }, 
          required: ['tableName'] 
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'find_column',
        description: 'Search for column name by keyword in a specific table',
        parameters: { 
          type: 'object', 
          properties: { 
            tableName: { 
              type: 'string',
              description: 'Table name to search'
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
        description: 'Execute SELECT query on database',
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
        description: 'Send command to browser for CREATE/UPDATE operations',
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

  // Multi-turn reasoning loop (up to 10 iterations)
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

    // Tool calls - continue investigation
    if (msg.tool_calls?.length > 0) {
      messages.push(msg);
      
      for (const call of msg.tool_calls) {
        const fn = call.function.name;
        const args = JSON.parse(call.function.arguments);
        
        sendUpdate({ type: 'tool', data: `🔍 ${fn}` });
        
        let res = '';
        try {
          if (fn === 'lookup_object') {
            res = await lookupObject(args.objectCode);
          }
          else if (fn === 'investigate_table') {
            res = await investigateTable(args.tableName);
          }
          else if (fn === 'find_column') {
            res = await findColumn(args.tableName, args.keyword);
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
          
          sendUpdate({ type: 'step', data: '✅' });
        } catch (e: any) {
          res = `Error: ${e.message}`;
          sendUpdate({ type: 'step', data: '❌' });
        }
        
        messages.push({ 
          role: 'tool', 
          tool_call_id: call.id, 
          content: res 
        });
      }
      
      // Continue loop for next iteration
      continue;
    }

    // Final answer
    if (msg.content) {
      sendUpdate({ type: 'complete', data: msg.content });
      return msg.content;
    }
    
    break;
  }
  
  return 'Investigation complete (max iterations reached)';
}

// ============================================================================
// SERVER SETUP
// ============================================================================
const app = express();

// CORS first!
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ready',
    version: 'v15.0-universal-truth',
    database: pool?.connected ? 'connected' : 'disconnected',
    objects: clarityObjects.size,
    coreObjects: Object.keys(CORE_MAPPING).length,
    features: [
      'hardcoded-mapping',
      'schema-investigation',
      'column-search',
      'multi-turn-reasoning',
      'remote-control'
    ]
  });
});

// Chat endpoint
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
  console.log(`🚀 Clarity MCP v15.0 UNIVERSAL TRUTH`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`🕵️ Investigation: Schema-based discovery`);
  console.log(`🗺️ Mapping: Hardcoded core + ODF_CA_ pattern`);
  console.log(`🎮 Control: Remote browser execution`);
  console.log('==========================================================');
  console.log('');
  
  await getPool();
  await loadClarityObjects();
});
