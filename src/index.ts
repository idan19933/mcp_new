#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import https from 'https';
import http from 'http';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v6.1 - SELF-HEALING EDITION (Smart Schema)");
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
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// ============================================================================
// DIAGNOSTIC: CONNECTIVITY PROBE (Runs on Startup)
// ============================================================================
async function probeConnectivity() {
  console.log(`[Probe] Checking REST API accessibility at ${CLARITY_BASE_URL}...`);
  return new Promise((resolve) => {
    const req = http.get(`${CLARITY_BASE_URL}/niku/nu`, (res) => {
      console.log(`[Probe] ✅ REST Service is REACHABLE (Status: ${res.statusCode})`);
      resolve(true);
    });
    req.on('error', (e) => {
      console.error(`[Probe] ❌ REST Service UNREACHABLE: ${e.message}`);
      console.error(`[Probe] ⚠️ Note: SQL will work, but REST (Task creation) will fail.`);
      resolve(false);
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

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
// HELPER: SMART SCHEMA SUGGESTER (SELF-HEALING!)
// ============================================================================
async function findSimilarColumns(tableName: string, targetCol: string): Promise<string> {
  try {
    const db = await getPool();
    const result = await db.request().query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = '${tableName}' 
      AND (
        COLUMN_NAME LIKE '%${targetCol}%' 
        OR COLUMN_NAME LIKE '%STATUS%' 
        OR COLUMN_NAME LIKE '%ACTIVE%'
        OR COLUMN_NAME LIKE '%OPEN%'
      )
      ORDER BY COLUMN_NAME
    `);
    
    if (result.recordset.length > 0) {
      return result.recordset.map((r: any) => r.COLUMN_NAME).join(', ');
    }
    return "No similar columns found.";
  } catch { 
    return "Unable to check schema."; 
  }
}

// ============================================================================
// SMART COOKIE FORMATTER
// ============================================================================
function formatSessionCookie(rawValue: any): string | null {
  if (!rawValue) return null;
  let val = String(rawValue).trim();

  if (val.includes('JSESSIONID=')) {
    const match = val.match(/JSESSIONID=([^;]+)/);
    if (match) val = match[1];
  }
  else if (val.startsWith('sessionId=')) {
    val = val.replace('sessionId=', '');
  }

  val = val.replace(/['";]/g, '');
  return `JSESSIONID=${val}`;
}

// ============================================================================
// TOOL 1: DYNAMIC SQL (WITH SELF-HEALING!)
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
    
    // --- SMART ERROR HANDLING - SELF-HEALING! ---
    if (error.message.includes("Invalid column name")) {
      const badColMatch = error.message.match(/'([^']+)'/);
      const badCol = badColMatch ? badColMatch[1] : "unknown";
      
      // Extract table name from query
      const tableMatch = sqlQuery.match(/FROM\s+([A-Z0-9_]+)/i);
      const tableName = tableMatch ? tableMatch[1] : null;

      let suggestion = "";
      if (tableName) {
        // Special handling for "ACTIVE" confusion
        if (badCol.toUpperCase() === 'IS_ACTIVE') {
           if (tableName.toUpperCase().includes('PRTASK')) {
             suggestion = "For Tasks, use 'PRSTATUS != 2' (2=Completed) OR 'IS_OPEN_FOR_TE = 1'.";
           }
           else if (tableName.toUpperCase().includes('INV_INVESTMENTS')) {
             suggestion = "For Projects, 'IS_ACTIVE' should exist. Try checking the exact column name with get_schema.";
           }
           else {
             const similar = await findSimilarColumns(tableName, 'ACTIVE');
             suggestion = `Similar columns in ${tableName}: [${similar}]`;
           }
        } else {
           // Generic column search
           const similar = await findSimilarColumns(tableName, badCol.substring(0, 4));
           suggestion = `Similar columns in ${tableName}: ${similar}`;
        }
      }

      return `❌ SQL Schema Error: Column '${badCol}' not found${tableName ? ` in table '${tableName}'` : ''}.

💡 SMART TIP: ${suggestion}

🔧 ACTION: Update your query with the correct column name and retry automatically.`;
    }

    return `❌ SQL Error: ${error.message}`; 
  }
}

// ============================================================================
// TOOL 2: REST API
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
  const url = `${CLARITY_BASE_URL}${cleanEndpoint}`;

  console.log(`[REST] ${method} ${url}`);
  if (body) console.log(`[REST] Body:`, JSON.stringify(body, null, 2));

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

    if (url.startsWith('https')) {
      fetchOptions.agent = insecureAgent;
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();
    
    console.log(`[REST] Status: ${response.status}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        return `❌ Error 404: Endpoint not found. 

💡 TIP: Make sure you're using numeric ID, not string code.
Example: /ppm/rest/v1/projects/5004001/tasks (not /projects/this_proj/tasks)`;
      }
      return `❌ API Error (${response.status}): ${text.substring(0, 400)}`;
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
- Check if Clarity server is reachable from this network
- Verify CLARITY_URL: ${CLARITY_BASE_URL}
- Check firewall/VPN settings`;
  }
}

// ============================================================================
// TOOL 3: SCHEMA HELPER
// ============================================================================
async function getObjectSchema(objectCode: string): Promise<string> {
  const obj = clarityObjects.get(objectCode.toUpperCase());
  if (!obj) return `Object '${objectCode}' not found. Available objects: ${Array.from(clarityObjects.keys()).slice(0, 10).join(', ')}...`;
  
  try {
    const db = await getPool();
    const q = `
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = '${obj.tableName}'
      ORDER BY ORDINAL_POSITION
    `;
    const res = await db.request().query(q);
    
    return JSON.stringify({ 
      object: obj.objectName, 
      table: obj.tableName, 
      columnCount: res.recordset.length,
      columns: res.recordset 
    }, null, 2);
  } catch (e: any) { 
    return `Error getting schema: ${e.message}`; 
  }
}

// ============================================================================
// AI AGENT LOOP (SELF-HEALING BRAIN!)
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sessionCookie: string | null, 
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Expert with SELF-HEALING abilities.

🕵️‍♂️ **CRITICAL: "ACTIVE" LOGIC BY OBJECT TYPE:**

**Tasks (PRTASK):**
- ❌ DO NOT use 'IS_ACTIVE' (doesn't exist!)
- ✅ Use: \`PRSTATUS != 2\` (2 = Completed)
- ✅ Or: \`IS_OPEN_FOR_TE = 1\` (Open for time entry)

**Projects (INV_INVESTMENTS):**
- ✅ Use: \`IS_ACTIVE = 1\`
- If fails, use get_schema to check exact column name

**Resources (SRM_RESOURCES):**
- ✅ Use: \`IS_ACTIVE = 1\`

🛠️ **SELF-HEALING WORKFLOW:**

1. **Try your best query first**
2. **If it fails with "Invalid column":**
   - READ the error message carefully
   - The system suggests the correct column
   - IMMEDIATELY retry with the corrected column
   - DO NOT ask the user for help
3. **Success!**

💡 **EXAMPLE - Self-Healing in Action:**

User: "How many active tasks?"

Attempt 1:
\`SELECT COUNT(*) FROM PRTASK WHERE IS_ACTIVE = 1\`
→ ❌ Error: "Column 'IS_ACTIVE' not found. TIP: Use 'PRSTATUS != 2' or 'IS_OPEN_FOR_TE = 1'"

Attempt 2 (AUTO-RETRY):
\`SELECT COUNT(*) FROM PRTASK WHERE PRSTATUS != 2\`
→ ✅ Success! Returns count

🎯 **ID-FIRST FOR REST:**
- Always get numeric ID via SQL before REST calls
- Example: \`SELECT ID FROM INV_INVESTMENTS WHERE CODE='proj'\`
- Then: POST /ppm/rest/v1/projects/{ID}/tasks

⚠️ **RULES:**
- Use WITH(NOLOCK) in SQL queries
- Use TOP (not LIMIT)
- Self-correct automatically when schema errors occur
- Never give up after first error - always retry with fix`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute SELECT query. If it fails with schema error, the system will suggest fixes - retry immediately with the correction!',
        parameters: {
          type: 'object',
          properties: { 
            sqlQuery: { 
              type: 'string',
              description: 'MS SQL SELECT query with WITH(NOLOCK) and TOP'
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
        description: 'Call Clarity REST API. CRITICAL: Use numeric IDs (not string codes) in paths!',
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
              description: 'JSON payload for POST/PUT'
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
        description: 'Get database schema (columns, types) for any object. Use this to verify column names BEFORE writing SQL.',
        parameters: {
          type: 'object',
          properties: { 
            objectCode: { 
              type: 'string',
              description: 'Object code like task, project, resource, etc.'
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

  await probeConnectivity();
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
        sendUpdate({ type: 'info', data: '🔐 Session Ready' });
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
      version: 'v6.1-self-healing',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      features: [
        'self-healing-sql',
        'smart-schema-detection',
        'auto-error-recovery',
        'connectivity-probe',
        'id-first-logic',
        'cookie-cleaning',
        'ssl-bypass'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v6.1 SELF-HEALING EDITION`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o (Self-Healing)`);
    console.log(`🔧 Features: Auto-recovery + Smart Schema + Connectivity Probe`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
