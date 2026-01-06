#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v5.0 - ARCHITECT EDITION (REST + SQL)");
console.log("==========================================================");

// ============================================================================
// CONFIGURATION
// ============================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

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
  // Core Objects
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
  
  // Governance & PMO
  'RISK': 'RIM_RISKS',
  'ISSUE': 'RIM_ISSUES',
  'CHANGE': 'RIM_RISKS',
  'STATUS_REPORT': 'COP_PRJ_STATUSRPT',
  
  // Financials
  'FINANCIAL_PLAN': 'FIN_PLANS',
  'COST_PLAN': 'FIN_COST_PLAN_DETAILS',
  'BENEFIT_PLAN': 'FIN_BENEFIT_PLANS',
  'TRANSACTION': 'FIN_TRANSACTIONS',
  'BUDGET': 'FIN_FINANCIALS',
  'RATE_MATRIX': 'RATE_MATRIX',
  
  // Organization & Metadata
  'DEPARTMENT': 'CMN_DEPARTMENTS',
  'LOCATION': 'CMN_LOCATIONS',
  'OBS_UNIT': 'PRJ_OBS_UNITS',
  'OBS_ASSOCIATION': 'PRJ_OBS_ASSOCIATIONS',
  
  // Process & Audit
  'PROCESS': 'BPM_DEF_PROCESSES',
  'PROCESS_RUN': 'BPM_RUN_PROCESSES',
  'PROCESS_STEP': 'BPM_RUN_STEPS',
  'AUDIT': 'CMN_AUDITS',
  
  // Lookups & Security
  'LOOKUP': 'CMN_LOOKUPS_V',
  'LOOKUP_VALUE': 'CMN_LOOKUPS_V', 
  'USER': 'CMN_SEC_USERS',
  'GROUP': 'CMN_SEC_GROUPS',
  'RIGHT': 'CMN_SEC_RIGHTS',
  
  // Common Custom Objects
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
    console.log(`[Objects] Found ${result.recordset.length} objects in ODF_OBJECTS`);

    result.recordset.forEach((obj: any) => {
      const code = (obj.code || '').toUpperCase();
      const name = obj.name || code;
      if (!code) return;
      
      let tableName = TABLE_MAP[code] || `ODF_CA_${code}`;
      
      clarityObjects.set(code, {
        objectCode: code,
        objectName: name,
        tableName: tableName
      });
    });

    console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error: any) {
    console.warn('⚠️ [Objects] DB load failed. Using hardcoded map only.');
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
    return '❌ Security: Only SELECT queries allowed in this tool. Use "run_custom_sql_update" for updates.';
  }
  
  if (forbidden.some(word => upperSQL.includes(` ${word} `))) {
    return `❌ Security: '${forbidden.find(w => upperSQL.includes(w))}' not allowed in read-only tool.`;
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
  
  // Must be UPDATE or INSERT
  if (!upperSQL.startsWith('UPDATE') && !upperSQL.startsWith('INSERT')) {
    return '❌ Security: Only UPDATE or INSERT allowed in this tool.';
  }

  // Must target Custom Objects (ODF_CA_)
  const targetTableMatch = upperSQL.match(/(UPDATE|INTO)\s+(ODF_CA_\w+)/);
  if (!targetTableMatch) {
    return '❌ Security: You can only update Custom Objects (tables starting with ODF_CA_). System tables are protected.';
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
    return '❌ Error: REST API calls require an active session. Please log in via the extension.';
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${CLARITY_BASE_URL}${cleanEndpoint}`;

  console.log(`[REST] ${method} ${url}`);

  try {
    const response = await fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    
    try {
      const json = JSON.parse(text);
      return JSON.stringify(json, null, 2);
    } catch {
      return text;
    }

  } catch (error: any) {
    return `❌ REST Error: ${error.message}`;
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
// AI AGENT LOOP (CLAUDE)
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sessionCookie: string | null,
  sendUpdate: (data: any) => void
) {
  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) return 'AI API not configured';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Architect & Developer with SQL + REST API capabilities.

🎯 YOUR CAPABILITIES:

1. **Read Data (SQL)**:
   - Use 'run_read_sql' for queries, analysis, and reporting
   - Always use MS SQL syntax: TOP (not LIMIT), WITH(NOLOCK)

2. **Update Custom Objects (SQL)**:
   - Use 'run_custom_sql_update' to UPDATE or INSERT into Custom Objects (ODF_CA_*)
   - NEVER update system tables (INV_*, CMN_*, SRM_*) via SQL - use REST for those

3. **System Object Updates (REST)**:
   - Use 'call_rest_api' to create/update system objects (projects, tasks, lookups, etc.)
   - REST API requires active session - if no session, user must login first

4. **Schema Discovery**:
   - Use 'get_schema' to check columns before writing SQL
   - Use 'list_tables' to see available objects

🔗 CLARITY JOIN PATTERNS:

**Projects to Tasks:**
\`\`\`sql
SELECT p.NAME, COUNT(t.PRID) as Tasks
FROM INV_INVESTMENTS p WITH(NOLOCK)
LEFT JOIN PRTASK t WITH(NOLOCK) ON p.ID = t.PRPROJECTID
GROUP BY p.NAME
\`\`\`

**Projects to Manager:**
\`\`\`sql
SELECT p.NAME, r.FULL_NAME as Manager
FROM INV_INVESTMENTS p WITH(NOLOCK)
LEFT JOIN SRM_RESOURCES r WITH(NOLOCK) ON p.MANAGER_ID = r.ID
\`\`\`

**Custom Object to Project:**
\`\`\`sql
SELECT c.*, p.NAME as ProjectName
FROM ODF_CA_CUSTOM c WITH(NOLOCK)
LEFT JOIN INV_INVESTMENTS p WITH(NOLOCK) ON c.ODF_PARENT_ID = p.ID
\`\`\`

📡 REST API EXAMPLES:

**Get Project:**
\`\`\`
method: GET
endpoint: /ppm/rest/v1/projects/{projectId}
\`\`\`

**Create Project:**
\`\`\`
method: POST
endpoint: /ppm/rest/v1/projects
body: {
  "code": "PRJ001",
  "name": "New Project",
  "managerId": "user123"
}
\`\`\`

**Update Task:**
\`\`\`
method: PUT
endpoint: /ppm/rest/v1/tasks/{taskId}
body: {
  "status": "completed"
}
\`\`\`

**Create Lookup:**
\`\`\`
method: POST
endpoint: /ppm/rest/v1/lookups
body: {
  "lookupType": "MY_STATUS",
  "lookupValue": "Active",
  "description": "Active Status"
}
\`\`\`

🛠️ DECISION RULES:

1. **For Reading**: Always use 'run_read_sql'
2. **For Custom Object Updates**: Use 'run_custom_sql_update'
3. **For System Object Updates**: Use 'call_rest_api'
4. **For Metadata (Lookups, Attributes, Fields)**: Use 'call_rest_api'

⚠️ IMPORTANT:
- REST requires active session (user must be logged in)
- SQL updates only work on ODF_CA_* tables
- Always check schema before complex queries
- Use TOP not LIMIT
- Always use WITH(NOLOCK)

💡 EXAMPLES:

Q: "How many projects?"
A: run_read_sql("SELECT COUNT(*) FROM INV_INVESTMENTS WITH(NOLOCK)")

Q: "Update status on my custom vendor object"
A: run_custom_sql_update("UPDATE ODF_CA_VENDOR SET status = 'Active' WHERE code = 'V001'")

Q: "Create a new project called Alpha"
A: call_rest_api(method="POST", endpoint="/ppm/rest/v1/projects", body={code:"ALPHA", name:"Alpha Project"})

Q: "Add a new lookup value for priority"
A: call_rest_api(method="POST", endpoint="/ppm/rest/v1/lookups", body={lookupType:"PRIORITY", lookupValue:"Critical"})`;

  const tools: any[] = [
    {
      name: 'run_read_sql',
      description: 'Execute a SELECT query to read and analyze data. Read-only.',
      input_schema: {
        type: 'object',
        properties: { 
          sqlQuery: { 
            type: 'string', 
            description: 'MS SQL Server SELECT query with TOP and WITH(NOLOCK)' 
          } 
        },
        required: ['sqlQuery']
      }
    },
    {
      name: 'run_custom_sql_update',
      description: 'Execute UPDATE or INSERT on Custom Objects (ODF_CA_* tables) only. System tables are protected.',
      input_schema: {
        type: 'object',
        properties: { 
          sqlQuery: { 
            type: 'string', 
            description: 'UPDATE ODF_CA_... or INSERT INTO ODF_CA_... query' 
          } 
        },
        required: ['sqlQuery']
      }
    },
    {
      name: 'call_rest_api',
      description: 'Make REST API call to Clarity for system object operations (create/update projects, tasks, lookups, etc.). Requires active session.',
      input_schema: {
        type: 'object',
        properties: {
          method: { 
            type: 'string', 
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method'
          },
          endpoint: { 
            type: 'string', 
            description: 'API endpoint like /ppm/rest/v1/projects or /ppm/rest/v1/tasks/{id}'
          },
          body: { 
            type: 'object', 
            description: 'JSON body for POST/PUT/PATCH requests' 
          }
        },
        required: ['method', 'endpoint']
      }
    },
    {
      name: 'get_schema',
      description: 'Get database schema (columns, types) for any Clarity object',
      input_schema: {
        type: 'object',
        properties: { 
          objectCode: { 
            type: 'string', 
            description: 'Object code like project, task, vendor, etc.' 
          } 
        },
        required: ['objectCode']
      }
    },
    {
      name: 'list_tables',
      description: 'List all available Clarity objects and their database tables',
      input_schema: { type: 'object', properties: {} }
    }
  ];

  let messages: any[] = [{ role: 'user', content: userMessage }];

  let iteration = 0;
  while (iteration < 10) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Processing... (${iteration}/10)` });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || OPENAI_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', // Or whichever model you have access to
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages,
        tools: tools
      })
    });

    const data: any = await response.json();
    if (!data.content) throw new Error('Invalid AI Response');

    const toolBlocks = data.content.filter((b: any) => b.type === 'tool_use');
    
    if (toolBlocks.length > 0) {
      messages.push({ role: 'assistant', content: data.content });
      const toolResults = [];

      for (const t of toolBlocks) {
        sendUpdate({ type: 'tool', data: `🔧 ${t.name}` });
        let res = '';
        try {
          if (t.name === 'run_read_sql') {
            res = await executeDynamicQuery(t.input.sqlQuery);
          }
          else if (t.name === 'run_custom_sql_update') {
            res = await executeCustomObjectUpdate(t.input.sqlQuery);
          }
          else if (t.name === 'call_rest_api') {
            res = await callClarityREST(t.input.method, t.input.endpoint, t.input.body, sessionCookie);
          }
          else if (t.name === 'get_schema') {
            res = await getObjectSchema(t.input.objectCode);
          }
          else if (t.name === 'list_tables') {
            const tables = Array.from(clarityObjects.values())
              .map(o => `${o.objectCode}: ${o.objectName} → ${o.tableName}`)
              .slice(0, 100);
            res = tables.join('\n');
            if (clarityObjects.size > 100) res += `\n... (${clarityObjects.size} total)`;
          }
          
          sendUpdate({ type: 'step', data: '✅ Done' });
        } catch (e: any) { 
          res = `Error: ${e.message}`; 
          sendUpdate({ type: 'step', data: '❌ Error' });
        }
        
        toolResults.push({ type: 'tool_result', tool_use_id: t.id, content: res });
      }
      
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const textBlock = data.content.find((b: any) => b.type === 'text');
    if (textBlock) {
      sendUpdate({ type: 'complete', data: textBlock.text });
      return textBlock.text;
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
      let sessionCookie = null;
      
      if (session?.cookies) {
        sessionCookie = session.cookies;
        sendUpdate({ type: 'info', data: '🔐 Session Active (REST Enabled)' });
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
      version: 'v5.0-architect',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'Claude Sonnet 4',
      clarityUrl: CLARITY_BASE_URL,
      features: [
        'sql-read',
        'sql-write-custom',
        'rest-api',
        'schema-discovery',
        'session-support'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v5.0 ARCHITECT RUNNING`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: Claude Sonnet 4`);
    console.log(`🛡️ Features: SQL Read + Custom Write + REST API`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
