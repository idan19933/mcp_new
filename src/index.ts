#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios'; // ROBUST HTTP CLIENT
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
    rejectUnauthorized: false // Bypass SSL errors
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
// TOOL 1: DYNAMIC SQL (READ ONLY - STRICT SECURITY!)
// ============================================================================
async function executeDynamicQuery(sqlQuery: string): Promise<string> {
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'EXEC'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  // STRICT: Block ALL write operations on system tables
  if (forbidden.some(w => upperSQL.includes(` ${w} `))) {
    return `❌ Security Block: Direct SQL writes are FORBIDDEN.

**Why?** Writing to system tables bypasses:
- Business logic (auto-numbering, workflows)
- Audit trails and history
- Data validation rules
- Process triggers and notifications

**Solution:** Use the REST API tool instead.
- REST API ensures data integrity
- Proper business logic execution
- Complete audit trail`;
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
// TOOL 2: REST API (AXIOS POWERED - SUPER ROBUST!)
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
1. Wrong endpoint format
2. Using string code instead of numeric ID
3. Resource doesn't exist

**Check:**
- Endpoint: ${cleanEndpoint}
- Are you using numeric ID? (e.g., /projects/5004001/tasks)
- Not string code (e.g., /projects/this_proj/tasks)`;
      }
      
      if (error.response.status === 401) {
        return `❌ API Error 401: Unauthorized.

**Possible causes:**
- Session expired
- Invalid session cookie
- User doesn't have permission

**Solution:** Log in again via the Extension`;
      }
      
      return `❌ API Error (${error.response.status}): ${JSON.stringify(error.response.data, null, 2)}`;
      
    } else if (error.request) {
      // Request made but NO response received (Network Error)
      console.error(`[Network Error] No response from server`);
      console.error(`[Network Error] Code: ${error.code}`);
      console.error(`[Network Error] Message: ${error.message}`);
      
      return `❌ Network Error: Cannot reach Clarity server

**Target:** ${CLARITY_BASE_URL}
**Error Code:** ${error.code || 'UNKNOWN'}
**Details:** ${error.message}

**This means:**
The server at ${DB_CONFIG.server}:8080 is unreachable from this location.

**Possible causes:**
1. Server is down or not responding
2. Firewall blocking the connection
3. VPN not connected
4. Wrong CLARITY_URL in environment variables

**If running on Railway/Cloud:**
- Railway (cloud) cannot reach ${DB_CONFIG.server} (internal IP)
- Internal IPs (16.x.x.x, 192.168.x.x, 10.x.x.x) are not accessible from cloud
- **Solution:** Deploy locally on your network OR setup VPN/tunnel

**Recommended Solutions:**
1. **Local Deployment:** Run the server on a computer in your network
2. **Cloudflare Tunnel:** Setup tunnel to expose internal service
3. **Tailscale VPN:** Connect Railway to your network via VPN
4. **Public IP/Domain:** If Clarity has a public URL, update CLARITY_URL`;
      
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

  const systemPrompt = `You are a Clarity PPM Architect with STRICT security rules.

✅ **ARCHITECTURE RULES (NON-NEGOTIABLE):**

1. **System Objects (Tasks, Projects, Issues, Risks):**
   - ✅ MUST be created/updated via **REST API**
   - ❌ SQL writes are **STRICTLY FORBIDDEN**
   - Why? Bypasses business logic, auditing, numbering, workflows

2. **Data Reading:**
   - ✅ Use **SQL** (faster, easier)
   - Always use WITH(NOLOCK) and TOP (not LIMIT)

3. **Custom Objects (ODF_CA_*):**
   - ✅ Can use SQL or REST
   - Prefer SQL for simplicity

🎯 **TASK CREATION WORKFLOW (ID-FIRST):**

**Step 1:** Find Parent Project ID via SQL
\`\`\`sql
SELECT ID, CODE, NAME 
FROM INV_INVESTMENTS WITH(NOLOCK)
WHERE CODE = 'project_code' OR NAME LIKE '%project_name%'
\`\`\`
Result: {"ID": 5004001, "CODE": "this_proj"}

**Step 2:** Create Task via REST (using numeric ID!)
\`\`\`
Method: POST
Endpoint: /ppm/rest/v1/projects/5004001/tasks
Body: {
  "code": "task_code",
  "name": "Task Name",
  "status": "NOT_STARTED",
  "priority": 10,
  "start": "2026-01-15T08:00:00",
  "finish": "2026-01-20T17:00:00"
}
\`\`\`

⚠️ **CRITICAL ERROR HANDLING:**

**Network Error (Most Common):**
If REST returns "Network Error: Cannot reach Clarity server":
→ Tell user: "I cannot reach the Clarity server from this location. The server (${DB_CONFIG.server}) appears to be on an internal network that's not accessible from where this application is running. Consider deploying locally on your network or setting up a VPN/tunnel solution."

**404 Error:**
→ Check: Are you using numeric ID (5004001) not string code (this_proj)?
→ Verify: Does the project/resource exist?

**401 Error:**
→ Session expired or invalid
→ Tell user to log in again

🔗 **REMEMBER:**
- ALWAYS use numeric IDs in REST paths (NEVER string codes!)
- NEVER INSERT/UPDATE system tables via SQL
- READ errors carefully and provide helpful guidance
- Be honest about network limitations`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute SELECT query to read data and find IDs. Read-only, write operations blocked.',
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
        description: 'Call Clarity REST API using Axios (robust HTTP). CRITICAL: Use numeric IDs in paths!',
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
        description: 'Get database schema for verification',
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
        console.log('[Session] Active - REST enabled (Axios)');
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
      version: 'v9.0-axios-final',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      httpClient: 'Axios (Production-Ready)',
      security: 'Strict (REST-Only for System Tables)',
      features: [
        'axios-http-client',
        'strict-security',
        'system-table-protection',
        'id-first-logic',
        'smart-cookie',
        'ssl-bypass',
        'detailed-network-errors'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v9.0 AXIOS EDITION (FINAL)`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o`);
    console.log(`🌐 HTTP: Axios (Robust + Production-Ready)`);
    console.log(`🛡️ Security: STRICT (REST-Only for System Tables)`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
