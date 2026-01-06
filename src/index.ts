#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v5.1 - PRODUCTION (OPENAI + REST + SQL)");
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
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: { max: 20, min: 2, idleTimeoutMillis: 30000 }
};

// Clarity Base URL for REST calls
const CLARITY_BASE_URL = process.env.CLARITY_URL || `http://${DB_CONFIG.server}:8080`; 

// ============================================================================
// EXPANDED TABLE MAP
// ============================================================================
const TABLE_MAP: Record<string, string> = {
  'PROJECT': 'INV_INVESTMENTS',
  'IDEA': 'INV_INVESTMENTS',
  'INVESTMENT': 'INV_INVESTMENTS',
  'RESOURCE': 'SRM_RESOURCES',
  'TASK': 'PRTASK',
  'ASSIGNMENT': 'PRASSIGNMENT',
  'TEAM': 'PRTEAM',
  'TIMESHEET': 'PRTIMESHEET',
  'TIMESLICE': 'PRTIMESLICE',
  'ROLE': 'SRM_RESOURCES',
  'RISK': 'RIM_RISKS',
  'ISSUE': 'RIM_ISSUES',
  'CHANGE': 'RIM_RISKS',
  'STATUS_REPORT': 'COP_PRJ_STATUSRPT',
  'FINANCIAL_PLAN': 'FIN_PLANS',
  'COST_PLAN': 'FIN_COST_PLAN_DETAILS',
  'BENEFIT_PLAN': 'FIN_BENEFIT_PLANS',
  'TRANSACTION': 'FIN_TRANSACTIONS',
  'BUDGET': 'FIN_FINANCIALS',
  'RATE_MATRIX': 'RATE_MATRIX',
  'DEPARTMENT': 'CMN_DEPARTMENTS',
  'LOCATION': 'CMN_LOCATIONS',
  'OBS_UNIT': 'PRJ_OBS_UNITS',
  'OBS_ASSOCIATION': 'PRJ_OBS_ASSOCIATIONS',
  'PROCESS': 'BPM_DEF_PROCESSES',
  'PROCESS_RUN': 'BPM_RUN_PROCESSES',
  'LOOKUP': 'CMN_LOOKUPS_V',
  'USER': 'CMN_SEC_USERS',
  'GROUP': 'CMN_SEC_GROUPS',
  'VENDOR': 'ODF_CA_VENDOR',
  'CONTRACT': 'ODF_CA_CONTRACT',
  'APPLICATION': 'ODF_CA_APPLICATION'
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
    console.error('❌ DB Connection Failed:', err);
    throw err;
  }
}

// ============================================================================
// OBJECT LOADING
// ============================================================================
interface ClarityObject {
  objectCode: string;
  objectName: string;
  tableName: string;
}

let clarityObjects: Map<string, ClarityObject> = new Map();

async function loadClarityObjects() {
  console.log('[Objects] Building object map...');
  try {
    const db = await getPool();
    const result = await db.request().query("SELECT code, name FROM ODF_OBJECTS WHERE is_active = 1");
    
    result.recordset.forEach((obj: any) => {
      const code = (obj.code || '').toUpperCase();
      const name = obj.name || code;
      if (!code) return;
      let tableName = TABLE_MAP[code] || `ODF_CA_${code}`;
      clarityObjects.set(code, { objectCode: code, objectName: name, tableName: tableName });
    });
    console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error: any) {
    console.warn('⚠️ [Objects] DB load failed. Using hardcoded map.');
    Object.entries(TABLE_MAP).forEach(([code, table]) => {
      clarityObjects.set(code, { objectCode: code, objectName: code, tableName: table });
    });
  }
}

// ============================================================================
// TOOL 1: DYNAMIC SQL (READ ONLY)
// ============================================================================
async function executeDynamicQuery(sqlQuery: string): Promise<string> {
  const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'EXEC'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security: Only SELECT queries allowed in this tool.';
  }
  if (forbidden.some(word => upperSQL.includes(` ${word} `))) {
    return `❌ Security: '${forbidden.find(w => upperSQL.includes(w))}' not allowed.`;
  }
  if (upperSQL.includes('LIMIT ')) {
    return `❌ SYNTAX ERROR: Use 'TOP n' instead of 'LIMIT n' (MS SQL).`;
  }

  try {
    const db = await getPool();
    console.log(`[SQL-READ] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) return 'Query executed. No results found.';
    if (result.recordset.length > 100) {
      return JSON.stringify(result.recordset.slice(0, 100), null, 2) + `\n\n... (${result.recordset.length} total)`;
    }
    return JSON.stringify(result.recordset, null, 2);
  } catch (error: any) {
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 2: CUSTOM OBJECT UPDATE (WRITE)
// ============================================================================
async function executeCustomObjectUpdate(sqlQuery: string): Promise<string> {
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  if (!upperSQL.startsWith('UPDATE') && !upperSQL.startsWith('INSERT')) {
    return '❌ Security: Only UPDATE or INSERT allowed.';
  }
  const targetTableMatch = upperSQL.match(/(UPDATE|INTO)\s+(ODF_CA_\w+)/);
  if (!targetTableMatch) {
    return '❌ Security: You can only update Custom Objects (ODF_CA_*). System tables are protected.';
  }

  const tableName = targetTableMatch[2];
  console.log(`[SQL-WRITE] Targeting custom table: ${tableName}`);

  try {
    const db = await getPool();
    const result = await db.request().query(sqlQuery);
    return `✅ Success: ${result.rowsAffected[0]} rows affected in ${tableName}`;
  } catch (error: any) {
    return `❌ SQL Update Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 3: REST API CALLER (IMPROVED)
// ============================================================================
async function callClarityREST(
  method: string, 
  endpoint: string, 
  body: any, 
  sessionCookie: string | null
): Promise<string> {
  if (!sessionCookie) {
    return '❌ Error: No Active Session. REST API requires authentication. Please log in via the Extension.';
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${CLARITY_BASE_URL}${cleanEndpoint}`;

  console.log(`[REST] ${method} ${url}`);
  console.log(`[REST] Session: ${sessionCookie.substring(0, 20)}...`);

  try {
    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie, // CRITICAL: Passes JSESSIONID
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    
    console.log(`[REST] Response Status: ${response.status}`);
    
    if (!response.ok) {
       return `❌ REST Error (${response.status}): ${text}`;
    }

    try {
      const json = JSON.parse(text);
      return JSON.stringify(json, null, 2);
    } catch {
      return text; // Return raw if not JSON
    }

  } catch (error: any) {
    return `❌ Network Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 4: SCHEMA HELPER
// ============================================================================
async function getObjectSchema(objectCode: string): Promise<string> {
  const obj = clarityObjects.get(objectCode.toUpperCase());
  if (!obj) return `Object '${objectCode}' not found.`;

  try {
    const db = await getPool();
    const check = await db.request().query(`SELECT OBJECT_ID('${obj.tableName}') as ID`);
    if (!check.recordset[0]?.ID) return `Table '${obj.tableName}' does not exist.`;
    
    const q = `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${obj.tableName}' ORDER BY ORDINAL_POSITION`;
    const res = await db.request().query(q);
    
    return JSON.stringify({ 
      object: obj.objectName, 
      table: obj.tableName, 
      columns: res.recordset 
    }, null, 2);
  } catch (e: any) { return `Error: ${e.message}`; }
}

// ============================================================================
// AI AGENT LOOP (OPENAI GPT-4o)
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sessionCookie: string | null,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Architect & Developer with full access.

🎯 CAPABILITIES:

1. **SQL Read**: Use 'run_read_sql' for data analysis and reporting.
2. **SQL Write**: Use 'run_custom_sql_update' for Custom Objects (ODF_CA_*) only.
3. **REST API**: Use 'call_rest_api' for System Objects (Projects, Tasks, Lookups, etc.).
   ⚠️ **CRITICAL**: REST requires active session. If you get "No Active Session", inform the user to log in.

🔗 CLARITY JOIN PATTERNS:

**Project to Task:**
\`\`\`sql
SELECT p.NAME, COUNT(t.PRID) as Tasks
FROM INV_INVESTMENTS p WITH(NOLOCK)
JOIN PRTASK t WITH(NOLOCK) ON p.ID = t.PRPROJECTID
GROUP BY p.NAME
\`\`\`

**Project to Manager:**
\`\`\`sql
SELECT p.NAME, r.FULL_NAME as Manager
FROM INV_INVESTMENTS p WITH(NOLOCK)
JOIN SRM_RESOURCES r WITH(NOLOCK) ON p.MANAGER_ID = r.ID
\`\`\`

**Search Strategy:**
When searching for a project/resource by name or code:
\`\`\`sql
WHERE (CODE = 'search_term' OR NAME LIKE '%search_term%')
\`\`\`

📡 REST API PATTERNS:

**Create Task in Project:**
1. First, find project code via SQL
2. Then call: POST /ppm/rest/v1/projects/{projectCode}/tasks
   Body: {code: "TASK001", name: "Task Name", status: "NOT_STARTED"}

**Create Project:**
POST /ppm/rest/v1/projects
Body: {code: "PRJ001", name: "Project Name", managerId: "admin"}

**Get Project:**
GET /ppm/rest/v1/projects/{projectCode}

**Create Lookup:**
POST /ppm/rest/v1/lookups
Body: {lookupType: "STATUS", lookupValue: "Active"}

🛠️ WORKFLOW EXAMPLE:

User: "Create task 'ai_test' in project 'this_proj'"

Step 1: Find project code
\`\`\`sql
SELECT CODE FROM INV_INVESTMENTS WITH(NOLOCK)
WHERE NAME = 'this_proj' OR CODE = 'this_proj'
\`\`\`

Step 2: Create task via REST
\`\`\`
call_rest_api(
  method: "POST",
  endpoint: "/ppm/rest/v1/projects/{code_from_step1}/tasks",
  body: {code: "ai_test", name: "ai_test", status: "NOT_STARTED"}
)
\`\`\`

⚠️ CRITICAL RULES:
- Always use MS SQL syntax: TOP (not LIMIT), WITH(NOLOCK)
- Always verify project/resource codes via SQL before REST calls
- If REST returns "No Active Session", tell user to log in
- Never UPDATE system tables via SQL - use REST instead`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute SELECT query to read and analyze data. Read-only.',
        parameters: {
          type: 'object',
          properties: { 
            sqlQuery: { 
              type: 'string', 
              description: 'MS SQL SELECT query with TOP and WITH(NOLOCK)' 
            } 
          },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_custom_sql_update',
        description: 'Execute UPDATE or INSERT on Custom Objects (ODF_CA_*) only.',
        parameters: {
          type: 'object',
          properties: { 
            sqlQuery: { 
              type: 'string', 
              description: 'UPDATE ODF_CA_... or INSERT INTO ODF_CA_... query' 
            } 
          },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'call_rest_api',
        description: 'Make REST API call to Clarity. Requires active session (user must be logged in).',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
              description: 'HTTP method'
            },
            endpoint: { 
              type: 'string', 
              description: 'API endpoint like /ppm/rest/v1/projects/{code}/tasks'
            },
            body: { 
              type: 'object', 
              description: 'JSON body for POST/PUT/PATCH'
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
        description: 'Get database schema (columns and types) for any Clarity object.',
        parameters: {
          type: 'object',
          properties: { 
            objectCode: { 
              type: 'string', 
              description: 'Object code like project, task, vendor, etc.' 
            } 
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
          else if (fn === 'run_custom_sql_update') {
            res = await executeCustomObjectUpdate(args.sqlQuery);
          }
          else if (fn === 'call_rest_api') {
            res = await callClarityREST(args.method, args.endpoint, args.body, sessionCookie);
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
    const { message, session } = req.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // --------------------------------------------------------------------------
      // ROBUST SESSION HANDLING
      // --------------------------------------------------------------------------
      let sessionCookie: string | null = null;

      // Method 1: Direct cookies string (most common)
      if (session?.cookies) {
        sessionCookie = session.cookies;
      } 
      // Method 2: sessionId field (extension specific)
      else if (session?.sessionId) {
        sessionCookie = `JSESSIONID=${session.sessionId}`;
      } 
      // Method 3: Generic id field
      else if (session?.id) {
        sessionCookie = `JSESSIONID=${session.id}`;
      }

      if (sessionCookie) {
        console.log('[Session] Found session cookie');
        sendUpdate({ type: 'info', data: '🔐 Session Active (REST Enabled)' });
      } else {
        console.log('[Session] No session found');
        sendUpdate({ type: 'info', data: '🔓 Guest Mode (SQL Read-Only)' });
      }

      await runAIAgentLoop(message, sessionCookie, sendUpdate);
      
    } catch (error: any) {
      sendUpdate({ type: 'error', data: error.message });
    }

    res.end();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ready',
      version: 'v5.1-production-openai',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      features: [
        'sql-read',
        'sql-write-custom',
        'rest-api',
        'robust-session',
        'schema-discovery'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v5.1 PRODUCTION (OpenAI)`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o`);
    console.log(`🛡️ Features: SQL + REST + Robust Sessions`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
