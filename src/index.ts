#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v5.2 - CONNECTIVITY FIX EDITION");
console.log("==========================================================");

// ============================================================================
// CONFIGURATION
// ============================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// Increased timeouts for slower internal networks
const DB_CONFIG = {
  user: process.env.DB_USER || 'niku',
  password: process.env.DB_PASSWORD || 'niku',
  server: process.env.DB_SERVER || '16.16.83.171',
  database: process.env.DB_NAME || 'niku',
  requestTimeout: 60000, // 60s timeout
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: { max: 20, min: 2, idleTimeoutMillis: 30000 }
};

const CLARITY_BASE_URL = process.env.CLARITY_URL || `http://${DB_CONFIG.server}:8080`; 

// SSL Agent to bypass "self-signed certificate" errors
const insecureAgent = new https.Agent({
  rejectUnauthorized: false
});

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
  'DEPARTMENT': 'CMN_DEPARTMENTS',
  'LOCATION': 'CMN_LOCATIONS',
  'OBS_UNIT': 'PRJ_OBS_UNITS',
  'PROCESS': 'BPM_DEF_PROCESSES',
  'LOOKUP': 'CMN_LOOKUPS_V',
  'USER': 'CMN_SEC_USERS',
  'VENDOR': 'ODF_CA_VENDOR',
  'CONTRACT': 'ODF_CA_CONTRACT'
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
    try {
      const result = await db.request().query("SELECT code, name FROM ODF_OBJECTS WHERE is_active = 1");
      result.recordset.forEach((obj: any) => {
        const code = (obj.code || '').toUpperCase();
        const name = obj.name || code;
        if (!code) return;
        let tableName = TABLE_MAP[code] || `ODF_CA_${code}`;
        clarityObjects.set(code, { objectCode: code, objectName: name, tableName: tableName });
      });
      console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects from DB`);
    } catch (dbErr: any) {
      console.warn('⚠️ [Objects] ODF_OBJECTS query failed. Using hardcoded map.');
      throw dbErr;
    }
  } catch (error: any) {
    // Fallback
    Object.entries(TABLE_MAP).forEach(([code, table]) => {
      clarityObjects.set(code, { objectCode: code, objectName: code, tableName: table });
    });
    console.log(`✅ [Objects] Fallback loaded ${clarityObjects.size} objects`);
  }
}

// ============================================================================
// HELPER: SMART COOKIE CLEANER
// ============================================================================
function formatSessionCookie(rawValue: any): string | null {
  if (!rawValue) return null;
  let val = String(rawValue).trim();

  console.log(`[Cookie] Raw input: ${val.substring(0, 30)}...`);

  // 1. If it already looks like "JSESSIONID=...", extract the ID part
  if (val.includes('JSESSIONID=')) {
    const match = val.match(/JSESSIONID=([^;]+)/);
    if (match) {
      val = match[1];
      console.log(`[Cookie] Extracted from JSESSIONID=: ${val.substring(0, 20)}...`);
    }
  }
  // 2. If it looks like "sessionId=...", strip that
  else if (val.startsWith('sessionId=')) {
    val = val.replace('sessionId=', '');
    console.log(`[Cookie] Stripped sessionId=: ${val.substring(0, 20)}...`);
  }

  // 3. Clean any remaining weird chars
  val = val.replace(/['";]/g, '');

  const formatted = `JSESSIONID=${val}`;
  console.log(`[Cookie] Final formatted: ${formatted.substring(0, 30)}...`);
  
  return formatted;
}

// ============================================================================
// TOOL 1: DYNAMIC SQL (READ ONLY)
// ============================================================================
async function executeDynamicQuery(sqlQuery: string): Promise<string> {
  const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'EXEC'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security: Only SELECT queries allowed.';
  }
  if (forbidden.some(w => upperSQL.includes(` ${w} `))) {
    return '❌ Security: Forbidden keyword detected.';
  }
  if (upperSQL.includes('LIMIT ')) {
    return `❌ SYNTAX ERROR: Use 'TOP n' instead of 'LIMIT n'.`;
  }

  try {
    const db = await getPool();
    console.log(`[SQL-READ] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) return 'Query executed. No results found.';
    if (result.recordset.length > 100) {
      return JSON.stringify(result.recordset.slice(0, 100), null, 2) + 
             `\n\n... (${result.recordset.length} total)`;
    }
    return JSON.stringify(result.recordset, null, 2);
  } catch (error: any) {
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 2: CUSTOM OBJECT UPDATE
// ============================================================================
async function executeCustomObjectUpdate(sqlQuery: string): Promise<string> {
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  if (!upperSQL.startsWith('UPDATE') && !upperSQL.startsWith('INSERT')) {
    return '❌ Security: Only UPDATE/INSERT allowed.';
  }
  
  const targetTableMatch = upperSQL.match(/(UPDATE|INTO)\s+(ODF_CA_\w+)/);
  if (!targetTableMatch) {
    return '❌ Security: Only ODF_CA_* tables allowed.';
  }

  try {
    const db = await getPool();
    console.log(`[SQL-WRITE] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    return `✅ Success: ${result.rowsAffected[0]} rows affected.`;
  } catch (error: any) {
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 3: REST API CALLER (Robust + SSL Bypass)
// ============================================================================
async function callClarityREST(
  method: string, 
  endpoint: string, 
  body: any, 
  sessionCookie: string | null
): Promise<string> {
  if (!sessionCookie) {
    return '❌ Error: No Active Session. Please login via Extension.';
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${CLARITY_BASE_URL}${cleanEndpoint}`;

  console.log(`[REST] ${method} ${url}`);
  console.log(`[REST] Cookie: ${sessionCookie.substring(0, 35)}...`);

  try {
    const fetchOptions: any = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    };

    // Add SSL bypass agent for HTTPS
    if (url.startsWith('https')) {
      fetchOptions.agent = insecureAgent;
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    
    console.log(`[REST] Response Status: ${response.status}`);
    
    if (!response.ok) {
       console.error(`[REST Error] ${response.status}: ${text.substring(0, 200)}`);
       return `❌ API Error (${response.status}): ${text.substring(0, 300)}`;
    }

    try {
      const json = JSON.parse(text);
      return JSON.stringify(json, null, 2);
    } catch {
      return text;
    }

  } catch (error: any) {
    console.error(`[Network Error] ${error.message}`);
    return `❌ Network Error: ${error.message}

**Troubleshooting:**
- Check URL: ${url}
- Verify VPN/Network access
- Ensure Clarity server is running
- Check firewall settings`;
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
    const q = `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE 
               FROM INFORMATION_SCHEMA.COLUMNS 
               WHERE TABLE_NAME = '${obj.tableName}' 
               ORDER BY ORDINAL_POSITION`;
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
// AI AGENT LOOP (GPT-4o)
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sessionCookie: string | null,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Architect.

🎯 GOAL: Manage Clarity data using SQL (Read) and REST (Write).

⚠️ RULES:
1. **SQL Read**: Use 'run_read_sql' for ALL queries. Always use WITH(NOLOCK) and TOP (not LIMIT).
2. **SQL Write**: ONLY for Custom Objects (ODF_CA_*) using 'run_custom_sql_update'.
3. **REST Write**: For System Objects (Tasks, Projects), use 'call_rest_api'.

🔗 REST API STRATEGY:
- **Create Task**: POST /ppm/rest/v1/tasks
  Body: { "code": "TASK001", "name": "Task Name", "projectCode": "PRJ123", "status": "NOT_STARTED" }
  
- **Create Project**: POST /ppm/rest/v1/projects
  Body: { "code": "PRJ001", "name": "Project Name", "managerUserName": "admin" }

- **Get Project**: GET /ppm/rest/v1/projects/{projectCode}

💡 WORKFLOW Example: "Create task 'test_task' in project 'my_project'"

Step 1: Find project code
\`\`\`sql
SELECT CODE FROM INV_INVESTMENTS WITH(NOLOCK)
WHERE CODE = 'my_project' OR NAME = 'my_project'
\`\`\`

Step 2: Create task via REST
\`\`\`
call_rest_api(
  method: "POST",
  endpoint: "/ppm/rest/v1/tasks",
  body: {
    "code": "test_task",
    "name": "test_task",
    "projectCode": "{code_from_step1}",
    "status": "NOT_STARTED"
  }
)
\`\`\`

🚨 CRITICAL:
- Always verify project/resource codes via SQL before REST calls
- Use flat endpoints (/ppm/rest/v1/tasks) over nested ones when possible
- If REST fails, check network/session in error message`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute SELECT query to read data. Read-only.',
        parameters: {
          type: 'object',
          properties: { 
            sqlQuery: { type: 'string', description: 'MS SQL SELECT with TOP and WITH(NOLOCK)' } 
          },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_custom_sql_update',
        description: 'Execute UPDATE/INSERT on Custom Objects (ODF_CA_*) only.',
        parameters: {
          type: 'object',
          properties: { 
            sqlQuery: { type: 'string', description: 'UPDATE ODF_CA_... or INSERT INTO ODF_CA_...' } 
          },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'call_rest_api',
        description: 'Call Clarity REST API. Requires active session.',
        parameters: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
            endpoint: { type: 'string', description: 'API endpoint like /ppm/rest/v1/tasks' },
            body: { type: 'object', description: 'JSON body for POST/PUT' }
          },
          required: ['method', 'endpoint']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_schema',
        description: 'Get table columns definition.',
        parameters: {
          type: 'object',
          properties: { objectCode: { type: 'string' } },
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
      // ROBUST COOKIE PARSING with Smart Cleaner
      let rawSession = session?.cookies || session?.sessionId || session?.id || null;
      const sessionCookie = formatSessionCookie(rawSession);

      if (sessionCookie) {
        sendUpdate({ type: 'info', data: '🔐 Session Active (REST Ready)' });
      } else {
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
      version: 'v5.2-connectivity-fix',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      features: [
        'sql-read',
        'sql-write-custom',
        'rest-api',
        'smart-cookie-cleaner',
        'ssl-bypass',
        'increased-timeouts'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v5.2 CONNECTIVITY FIX (OpenAI)`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o`);
    console.log(`🛡️ Fixes: Smart Cookie + SSL Bypass + Timeouts`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
