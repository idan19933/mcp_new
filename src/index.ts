#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import https from 'https';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v9.0 - AXIOS EDITION (Robust REST)");
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

const CLARITY_BASE_URL = process.env.CLARITY_URL || `http://${DB_CONFIG.server}:8080`; 

// AXIOS INSTANCE (Bypasses SSL, Handles Proxies, More Robust)
const apiClient = axios.create({
  baseURL: CLARITY_BASE_URL,
  timeout: 15000, // 15s timeout
  httpsAgent: new https.Agent({ 
    rejectUnauthorized: false 
  }),
  proxy: false, // Force direct connection (change if using proxy)
  maxRedirects: 5,
  validateStatus: (status) => status < 600 // Don't throw on 4xx/5xx
});

// ============================================================================
// TABLE MAP
// ============================================================================
const TABLE_MAP: Record<string, string> = {
  'PROJECT': 'INV_INVESTMENTS',
  'IDEA': 'INV_INVESTMENTS',
  'TASK': 'PRTASK',
  'RESOURCE': 'SRM_RESOURCES',
  'TEAM': 'PRTEAM',
  'TIMESHEET': 'PRTIMESHEET',
  'RISK': 'RIM_RISKS',
  'ISSUE': 'RIM_ISSUES',
  'DEPARTMENT': 'CMN_DEPARTMENTS',
  'LOOKUP': 'CMN_LOOKUPS_V',
  'USER': 'CMN_SEC_USERS',
  'VENDOR': 'ODF_CA_VENDOR',
  'CONTRACT': 'ODF_CA_CONTRACT'
};

interface ClarityObject { 
  objectCode: string; 
  objectName: string; 
  tableName: string; 
}

let clarityObjects: Map<string, ClarityObject> = new Map();

// ============================================================================
// DATABASE
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

async function loadClarityObjects() {
  console.log('[Objects] Building object map...');
  try {
    const db = await getPool();
    const result = await db.request().query("SELECT code, name FROM ODF_OBJECTS WHERE is_active = 1");
    result.recordset.forEach((obj: any) => {
      const code = (obj.code || '').toUpperCase();
      if (!code) return;
      let tableName = TABLE_MAP[code] || `ODF_CA_${code}`;
      clarityObjects.set(code, { 
        objectCode: code, 
        objectName: obj.name || code, 
        tableName 
      });
    });
    console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects`);
  } catch (error) {
    console.warn('⚠️ [Objects] Using hardcoded map.');
    Object.entries(TABLE_MAP).forEach(([k, v]) => {
      clarityObjects.set(k, { objectCode: k, objectName: k, tableName: v });
    });
  }
}

// ============================================================================
// SMART COOKIE FORMATTER
// ============================================================================
function formatSessionCookie(rawValue: any): string | null {
  if (!rawValue) return null;
  let val = String(rawValue).trim();

  console.log(`[Cookie] Raw: ${val.substring(0, 30)}...`);

  if (val.includes('JSESSIONID=')) {
    const match = val.match(/JSESSIONID=([^;]+)/);
    if (match) val = match[1];
  }
  else if (val.startsWith('sessionId=')) {
    val = val.replace('sessionId=', '');
  }

  val = val.replace(/['";]/g, '');

  const formatted = `JSESSIONID=${val}`;
  console.log(`[Cookie] Formatted: ${formatted.substring(0, 30)}...`);
  
  return formatted;
}

// ============================================================================
// TOOL 1: DYNAMIC SQL (READ ONLY - SYSTEM TABLES PROTECTED)
// ============================================================================
async function executeDynamicQuery(sqlQuery: string): Promise<string> {
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'EXEC'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  // Block all write operations - must use REST for system tables
  if (forbidden.some(w => upperSQL.includes(` ${w} `))) {
    return `❌ Security Block: System tables must be updated via REST API only.

**Why?** Direct SQL writes bypass:
- Business logic (numbering, workflows)
- Auditing and history
- Data validation
- Process triggers

**Solution:** Use the REST API tool instead.`;
  }
  
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security: Only SELECT queries allowed.';
  }
  
  if (upperSQL.includes('LIMIT ')) {
    return `❌ SYNTAX: Use 'TOP n' instead of 'LIMIT n'.`;
  }

  try {
    const db = await getPool();
    console.log(`[SQL-READ] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed. No results found.';
    }
    
    return JSON.stringify(result.recordset.slice(0, 100), null, 2);
  } catch (error: any) {
    console.error(`[SQL Error] ${error.message}`);
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 2: REST API (AXIOS POWERED - MORE ROBUST!)
// ============================================================================
async function callClarityREST(
  method: string, 
  endpoint: string, 
  body: any, 
  sessionCookie: string | null
): Promise<string> {
  if (!sessionCookie) {
    return '❌ Error: No Active Session. Please log in via Extension.';
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  console.log(`[REST-AXIOS] ${method} ${CLARITY_BASE_URL}${cleanEndpoint}`);
  if (body) console.log(`[REST-AXIOS] Body:`, JSON.stringify(body, null, 2));
  
  try {
    const response = await apiClient.request({
      method: method,
      url: cleanEndpoint,
      data: body,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': sessionCookie,
        'Accept': 'application/json'
      }
    });

    console.log(`[REST-AXIOS] Success: ${response.status}`);
    
    // Axios automatically parses JSON
    return JSON.stringify(response.data, null, 2);

  } catch (error: any) {
    // DETAILED AXIOS ERROR LOGGING
    if (error.response) {
      // Server responded with error status (4xx, 5xx)
      console.error(`[REST Error] Status: ${error.response.status}`);
      console.error(`[REST Error] Data:`, error.response.data);
      
      if (error.response.status === 404) {
        return `❌ API Error 404: Endpoint not found.

**Common causes:**
- Wrong endpoint format
- Using string code instead of numeric ID
- Resource doesn't exist

**Check:**
- Endpoint: ${cleanEndpoint}
- Did you use numeric ID? (e.g., /projects/5004001/tasks)`;
      }
      
      return `❌ API Error (${error.response.status}): ${JSON.stringify(error.response.data, null, 2)}`;
      
    } else if (error.request) {
      // Request made but NO response received (Network Error)
      console.error(`[Network Error] No response from server`);
      console.error(`[Network Error] Code: ${error.code}`);
      console.error(`[Network Error] Message: ${error.message}`);
      
      return `❌ Network Error: Cannot reach Clarity server at ${CLARITY_BASE_URL}

**Error Code:** ${error.code || 'UNKNOWN'}
**Details:** ${error.message}

**Possible causes:**
- Server is down or unreachable
- Firewall blocking connection
- VPN not connected
- Wrong CLARITY_URL in environment

**If running on Railway:**
- Railway (cloud) cannot reach ${DB_CONFIG.server} (internal IP)
- Consider deploying locally on your network
- Or setup VPN/tunnel (Cloudflare Tunnel, Tailscale, etc.)`;
      
    } else {
      // Something else happened
      console.error(`[Client Error] ${error.message}`);
      return `❌ Client Error: ${error.message}`;
    }
  }
}

// ============================================================================
// TOOL 3: SCHEMA HELPER
// ============================================================================
async function getObjectSchema(objectCode: string): Promise<string> {
  const obj = clarityObjects.get(objectCode.toUpperCase());
  if (!obj) {
    return `Object '${objectCode}' not found. Available: ${Array.from(clarityObjects.keys()).slice(0, 10).join(', ')}...`;
  }
  
  try {
    const db = await getPool();
    const q = `
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = '${obj.tableName}'
      ORDER BY ORDINAL_POSITION
    `;
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
// AI AGENT LOOP
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sessionCookie: string | null, 
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Architect with strict security rules.

✅ **ARCHITECTURE RULES:**

1. **System Objects (Tasks, Projects, Issues, Risks):**
   - MUST be created/updated via **REST API**
   - SQL writes are STRICTLY FORBIDDEN
   - Why? Business logic, auditing, numbering, workflows

2. **Data Reading:**
   - Use **SQL** (faster, easier)
   - Always use WITH(NOLOCK) and TOP (not LIMIT)

3. **Custom Objects (ODF_CA_*):**
   - Can use SQL or REST
   - Prefer SQL for simplicity

🎯 **TASK CREATION WORKFLOW:**

Step 1: Find Parent Project ID via SQL
\`\`\`sql
SELECT ID, CODE, NAME 
FROM INV_INVESTMENTS WITH(NOLOCK)
WHERE CODE = 'project_code' OR NAME LIKE '%project_name%'
\`\`\`
Result: ID = 5004001

Step 2: Create Task via REST
\`\`\`
Method: POST
Endpoint: /ppm/rest/v1/projects/5004001/tasks
Body: {
  "code": "task_code",
  "name": "Task Name",
  "status": "NOT_STARTED",
  "priority": 10,
  "start": "2026-01-10T08:00:00",
  "finish": "2026-01-15T17:00:00"
}
\`\`\`

⚠️ **ERROR HANDLING:**

**Network Error:**
If REST fails with "Network Error", tell user:
"I cannot reach the Clarity server from this location. This is likely because:
- The server is on an internal network (${DB_CONFIG.server})
- This application is running in the cloud
- Solution: Deploy locally on your network or setup VPN/tunnel"

**404 Error:**
Check if you're using numeric ID (not string code) in the path.

🔗 **CRITICAL RULES:**
- ALWAYS use numeric IDs in REST paths (not string codes!)
- NEVER INSERT/UPDATE system tables via SQL
- READ the error messages and act on suggestions
- Self-correct when schema errors occur`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute SELECT query to read data and find IDs. Read-only.',
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
        name: 'call_rest_api',
        description: 'Call Clarity REST API using Axios (robust HTTP client). Use numeric IDs in paths!',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['GET', 'POST', 'PUT', 'DELETE']
            },
            endpoint: { 
              type: 'string',
              description: 'API endpoint with NUMERIC ID, e.g., /ppm/rest/v1/projects/5004001/tasks'
            },
            body: { 
              type: 'object',
              description: 'JSON payload'
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
        description: 'Get database schema for any object',
        parameters: {
          type: 'object',
          properties: { 
            objectCode: { type: 'string' } 
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
      let rawSession = session?.cookies || session?.sessionId || session?.id || null;
      const sessionCookie = formatSessionCookie(rawSession);

      if (sessionCookie) {
        console.log('[Session] Active - REST enabled');
        sendUpdate({ type: 'info', data: '🔐 Session Ready (Axios)' });
      } else {
        console.log('[Session] Guest mode');
        sendUpdate({ type: 'info', data: '🔓 Guest Mode' });
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
      version: 'v9.0-axios',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      httpClient: 'Axios (robust)',
      features: [
        'axios-http-client',
        'system-table-protection',
        'id-first-logic',
        'smart-cookie',
        'ssl-bypass',
        'detailed-errors'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v9.0 AXIOS EDITION`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o`);
    console.log(`🌐 HTTP: Axios (Robust + Proxy Support)`);
    console.log(`🛡️ Security: System Tables Protected (REST Only)`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
