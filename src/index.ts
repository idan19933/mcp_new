#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v5.4 - LEARNER EDITION (Real API Routes)");
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
// TABLE MAP
// ============================================================================
const TABLE_MAP: Record<string, string> = {
  'PROJECT': 'INV_INVESTMENTS',
  'IDEA': 'INV_INVESTMENTS',
  'INVESTMENT': 'INV_INVESTMENTS',
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
    return `❌ SYNTAX: Use 'TOP n' instead of 'LIMIT n'.`;
  }

  try {
    const db = await getPool();
    console.log(`[SQL-READ] ${sqlQuery}`);
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed. No results found.';
    }
    
    // Return up to 100 rows
    return JSON.stringify(result.recordset.slice(0, 100), null, 2);
  } catch (error: any) {
    console.error(`[SQL Error] ${error.message}`);
    return `❌ SQL Error: ${error.message}`;
  }
}

// ============================================================================
// TOOL 2: REST API (WITH "ID FIRST" LOGIC)
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
      console.error(`[REST Error] ${response.status}: ${text.substring(0, 300)}`);
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
- Check URL: ${url}
- Verify network/VPN access
- Ensure Clarity server is running`;
  }
}

// ============================================================================
// AI AGENT LOOP (LEARNER BRAIN - ID FIRST!)
// ============================================================================
async function runAIAgentLoop(
  userMessage: string, 
  sessionCookie: string | null, 
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY) return 'OpenAI API Key Missing';
  if (clarityObjects.size === 0) await loadClarityObjects();

  const systemPrompt = `You are a Clarity PPM Developer who learns from real API behavior.

🚨 THE GOLDEN RULE OF CLARITY REST API:
**You CANNOT use String Codes (e.g. 'this_proj', 'PRJ123') in REST URL paths.**
**You MUST use Internal Numeric IDs (e.g. 5004001).**

This is the #1 cause of 404 errors in Clarity!

✅ CORRECT WORKFLOW - "ID First" Pattern:

**Step 1: SQL Lookup** - Find the internal ID
\`\`\`sql
SELECT ID, CODE, NAME 
FROM INV_INVESTMENTS WITH(NOLOCK)
WHERE CODE = 'this_proj' OR NAME = 'this_proj'
\`\`\`
Result: ID = 5004001

**Step 2: REST Call** - Use that numeric ID in the path
\`\`\`
Endpoint: /ppm/rest/v1/projects/5004001/tasks
Body: {
  "code": "task_001",
  "name": "New Task",
  "status": "NOT_STARTED"
}
\`\`\`

❌ INCORRECT - What NOT to do:
- ❌ /ppm/rest/v1/projects/this_proj/tasks (String code → 404!)
- ❌ /ppm/rest/v1/projects/PRJ123/tasks (String code → 404!)
- ❌ Guessing the endpoint without SQL lookup first

💡 REAL-WORLD TASK CREATION PAYLOAD:
Based on actual Clarity logs, here's what works:
\`\`\`json
{
  "code": "unique_task_code",
  "name": "Task Name",
  "description": "Optional description",
  "status": "NOT_STARTED",
  "priority": 10,
  "start": "2026-01-10T08:00:00",
  "finish": "2026-01-15T17:00:00"
}
\`\`\`

🔗 COMMON CLARITY ENDPOINTS:
- Get Project: GET /ppm/rest/v1/projects/{id}
- Create Task: POST /ppm/rest/v1/projects/{id}/tasks
- Update Task: PUT /ppm/rest/v1/tasks/{id}
- Get Resources: GET /ppm/rest/v1/resources

🎯 YOUR WORKFLOW FOR "Create task X in project Y":
1. run_read_sql: \`SELECT ID FROM INV_INVESTMENTS WHERE CODE='Y' OR NAME='Y'\`
2. Extract ID from result (e.g., 5004001)
3. call_rest_api: POST /ppm/rest/v1/projects/5004001/tasks

🛠️ TOOLS:
- **run_read_sql**: Use this FIRST to get numeric IDs (ID column)
- **call_rest_api**: Use this SECOND with the ID you found

⚠️ CRITICAL RULES:
- ALWAYS query for ID before REST calls
- NEVER use string codes in REST URL paths
- Use WITH(NOLOCK) in SQL queries
- Use TOP (not LIMIT) in MS SQL`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_read_sql',
        description: 'Execute SELECT query. Use this FIRST to find numeric IDs (e.g., SELECT ID FROM INV_INVESTMENTS WHERE CODE=...).',
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
        description: 'Call Clarity REST API. CRITICAL: Always use numeric IDs (not string codes) in endpoint paths!',
        parameters: {
          type: 'object',
          properties: {
            method: { 
              type: 'string', 
              enum: ['GET', 'POST', 'PUT', 'DELETE'],
              description: 'HTTP method'
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
      // Smart Cookie Formatting
      let rawSession = session?.cookies || session?.sessionId || session?.id || null;
      const sessionCookie = formatSessionCookie(rawSession);

      if (sessionCookie) {
        console.log('[Session] Active - REST enabled');
        sendUpdate({ type: 'info', data: '🔐 Session Ready (REST Enabled)' });
      } else {
        console.log('[Session] Guest mode');
        sendUpdate({ type: 'info', data: '🔓 Guest Mode (SQL Only)' });
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
      version: 'v5.4-learner-edition',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      ai: 'OpenAI GPT-4o',
      clarityUrl: CLARITY_BASE_URL,
      features: [
        'id-first-logic',
        'sql-read',
        'rest-api',
        'smart-cookie',
        'ssl-bypass',
        'real-world-trained'
      ]
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v5.4 LEARNER EDITION`);
    console.log(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔗 Clarity: ${CLARITY_BASE_URL}`);
    console.log(`🤖 AI: OpenAI GPT-4o (ID-First Trained)`);
    console.log(`🎓 Learning: Real API behavior from logs`);
    console.log('==========================================================');
    console.log('');
  });
}

startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
