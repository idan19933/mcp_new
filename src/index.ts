#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v5.1 - OPENAI ARCHITECT (REST + SQL)");
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
// TOOL 3: REST API CALLER
// ============================================================================
async function callClarityREST(
  method: string, 
  endpoint: string, 
  body: any, 
  sessionCookie: string | null
): Promise<string> {
  if (!sessionCookie) {
    return '❌ Error: No Active Session. I cannot call the REST API without a session ID. Please ensure you are logged in via the Extension.';
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${CLARITY_BASE_URL}${cleanEndpoint}`;

  console.log(`[REST] ${method} ${url} (Session: ${sessionCookie.substring(0, 15)}...)`);

  try {
    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie, // CRITICAL: This passes the JSESSIONID
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    
    if (!response.ok) {
       return `❌ REST Error (${response.status}): ${text}`;
    }

    try {
      const json = JSON.parse(text);
      return JSON.stringify(json, null, 2);
    } catch {
      return text;
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
    
    const q = `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${obj.tableName}'`;
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
  if (!OPENAI_API_KEY) return 'AI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Architect & Developer.

  🎯 CAPABILITIES:
  1. **SQL Read**: Use 'run_read_sql' for analysis.
  2. **SQL Write**: Use 'run_custom_sql_update' for Custom Objects (ODF_CA_*) only.
  3. **REST API**: Use 'call_rest_api' for System Objects (Projects, Tasks, Lookups).
     - **CRITICAL**: This requires a session. If the tool returns "No Active Session", tell the user their session ID is missing.

  🔗 CLARITY CHEAT SHEET:
  - **Project -> Task**: \`INV_INVESTMENTS.ID = PRTASK.PRPROJECTID\`
  - **Manager**: \`INV_INVESTMENTS.MANAGER_ID = SRM_RESOURCES.USER_ID\`
  - **Search**: When searching for "this_proj", check \`WHERE CODE = 'this_proj' OR NAME = 'this_proj'\`.

  📡 REST API ENDPOINTS:
  - **Create Task**: POST /ppm/rest/v1/tasks (Body: {code, name, projectCode, ...})
  - **Create Project**: POST /ppm/rest/v1/projects
  - **Create Lookup**: POST /ppm/rest/v1/lookups

  💡 EXAMPLE SCENARIO: "Create task 'ai_test' in project 'this_proj'"
  1. **Find Project Code**: First, run SQL to find the 'code' for 'this_proj'.
     \`SELECT CODE FROM INV_INVESTMENTS WHERE NAME = 'this_proj' OR CODE = 'this_proj'\`
  2. **Call REST**: Use the project code found in step 1.
     \`call_rest_api(POST, /ppm/rest/v1/projects/{projectCode}/tasks, {code: "ai_test", name: "ai_test", status: "NOT_STARTED"})\`
  
  ⚠️ RULES:
  - Always use MS SQL Syntax (TOP, WITH(NOLOCK)).
  - Verify project codes via SQL before calling REST.
  `;

  // OpenAI Tool Definitions
  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute a SELECT query to read data. Read-only.',
        parameters: {
          type: 'object',
          properties: { sqlQuery: { type: 'string', description: 'MS SQL SELECT query' } },
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
          properties: { sqlQuery: { type: 'string', description: 'UPDATE ODF_CA_... query' } },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'call_rest_api',
        description: 'Make REST API call to Clarity for system object operations.',
        parameters: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            endpoint: { type: 'string', description: 'API endpoint, e.g., /ppm/rest/v1/projects' },
            body: { type: 'object', description: 'JSON body' }
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
    sendUpdate({ type: 'thinking', data: `Reasoning... (${iteration}/10)` });

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
    const msg = data.choices[0].message;

    if (msg.tool_calls) {
      messages.push(msg); // Add assistant's thought process
      
      for (const call of msg.tool_calls) {
        const fn = call.function.name;
        const args = JSON.parse(call.function.arguments);
        sendUpdate({ type: 'tool', data: `🔧 ${fn}` });
        
        let res = '';
        try {
          if (fn === 'run_read_sql') res = await executeDynamicQuery(args.sqlQuery);
          else if (fn === 'run_custom_sql_update') res = await executeCustomObjectUpdate(args.sqlQuery);
          else if (fn === 'call_rest_api') res = await callClarityREST(args.method, args.endpoint, args.body, sessionCookie);
          else if (fn === 'get_schema') res = await getObjectSchema(args.objectCode);
          
          sendUpdate({ type: 'step', data: '✅ Done' });
        } catch (e: any) { 
          res = `Error: ${e.message}`;
          sendUpdate({ type: 'step', data: '❌ Error' });
        }
        
        messages.push({ role: 'tool', tool_call_id: call.id, content: res });
      }
    } else {
      sendUpdate({ type: 'complete', data: msg.content });
      return msg.content;
    }
  }
  return 'Limit reached';
}

// ============================================================================
// SERVER
// ============================================================================
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.post('/api/chat', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = (d: any) => res.write(`data: ${JSON.stringify(d)}\n\n`);

  const { message, session } = req.body;
  
  // --------------------------------------------------------------------------
  // ROBUST SESSION HANDLING
  // --------------------------------------------------------------------------
  let sessionCookie: string | null = null;

  // 1. Check direct cookies string (Standard)
  if (session?.cookies) {
    sessionCookie = session.cookies;
  } 
  // 2. Check sessionId (Extension specific)
  else if (session?.sessionId) {
    sessionCookie = `JSESSIONID=${session.sessionId}`; // Format correctly
  } 
  // 3. Check generic id
  else if (session?.id) {
    sessionCookie = `JSESSIONID=${session.id}`;
  }

  if (sessionCookie) {
    send({ type: 'info', data: '🔐 Session Found (REST Enabled)' });
  } else {
    send({ type: 'info', data: '🔓 Guest Mode (SQL Read-Only)' });
  }

  try {
    await runAIAgentLoop(message, sessionCookie, send);
  } catch (e: any) {
    send({ type: 'error', data: e.message });
  }
  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`🚀 Clarity MCP v5.1 Listening on ${PORT}`);
  await getPool();
  await loadClarityObjects();
});
