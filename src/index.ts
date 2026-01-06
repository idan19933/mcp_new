#!/usr/bin/env node
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

console.log("==========================================================");
console.log("🚀 CLARITY MCP v4.0 - BULLETPROOF BULLDOZER EDITION");
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

// ============================================================================
// HARDCODED TABLE MAP (No schema queries needed!)
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
  
  // Risk/Issue
  'RISK': 'RIM_RISKS',
  'ISSUE': 'RIM_ISSUES',
  'CHANGE': 'RIM_RISKS',
  
  // Financial
  'FINANCIAL_PLAN': 'FIN_PLANS',
  'COST_PLAN': 'FIN_COST_PLAN_DETAILS',
  'BENEFIT_PLAN': 'FIN_BENEFIT_PLANS',
  'TRANSACTION': 'FIN_TRANSACTIONS',
  
  // Organization
  'DEPARTMENT': 'CMN_DEPARTMENTS',
  'LOCATION': 'CMN_LOCATIONS',
  'OBS_UNIT': 'OBS_UNITS',
  
  // Lookups & Security
  'LOOKUP': 'CMN_LOOKUPS_V',
  'USER': 'CMN_SEC_USERS',
  'GROUP': 'CMN_SEC_GROUPS',
  
  // Common Custom Objects (add yours here!)
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
// SIMPLE OBJECT MAP
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
    
    // Super safe query - just get code and name
    const query = `
      SELECT code, name 
      FROM ODF_OBJECTS 
      WHERE is_active = 1
    `;

    const result = await db.request().query(query);
    console.log(`[Objects] Found ${result.recordset.length} objects in ODF_OBJECTS`);

    result.recordset.forEach((obj: any) => {
      const code = (obj.code || '').toUpperCase();
      const name = obj.name || code;
      
      if (!code) return;
      
      // Use hardcoded map first (most reliable)
      let tableName = TABLE_MAP[code];
      
      // If not in map, assume custom object convention
      if (!tableName) {
        tableName = `ODF_CA_${code}`;
      }

      clarityObjects.set(code, {
        objectCode: code,
        objectName: name,
        tableName: tableName
      });
    });

    console.log(`✅ [Objects] Mapped ${clarityObjects.size} objects successfully`);
    
  } catch (error: any) {
    console.warn('⚠️ [Objects] ODF_OBJECTS query failed, using hardcoded map only');
    console.warn('Error:', error.message);
    
    // Fallback: Use hardcoded map only
    Object.entries(TABLE_MAP).forEach(([code, table]) => {
      clarityObjects.set(code, {
        objectCode: code,
        objectName: code,
        tableName: table
      });
    });
    
    console.log(`✅ [Objects] Fallback: Using ${clarityObjects.size} hardcoded objects`);
  }
}

// ============================================================================
// DYNAMIC SQL RUNNER
// ============================================================================
async function executeDynamicQuery(sqlQuery: string): Promise<string> {
  // Security: Block destructive operations
  const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE'];
  const upperSQL = sqlQuery.toUpperCase().trim();
  
  // Must be SELECT or WITH
  if (!upperSQL.startsWith('SELECT') && !upperSQL.startsWith('WITH')) {
    return '❌ Security: Only SELECT queries allowed';
  }
  
  // Check for forbidden keywords
  for (const word of forbidden) {
    if (upperSQL.includes(` ${word} `) || upperSQL.includes(`\n${word} `)) {
      return `❌ Security: '${word}' not allowed`;
    }
  }

  try {
    const db = await getPool();
    console.log(`[SQL] Executing:\n${sqlQuery}`);
    
    const result = await db.request().query(sqlQuery);
    
    if (result.recordset.length === 0) {
      return 'Query executed successfully but returned no results.';
    }
    
    // Limit output
    if (result.recordset.length > 100) {
      return JSON.stringify(result.recordset.slice(0, 100), null, 2) + 
             `\n\n... (${result.recordset.length} total rows, showing first 100)`;
    }
    
    return JSON.stringify(result.recordset, null, 2);

  } catch (error: any) {
    console.error('[SQL] Error:', error.message);
    return `❌ SQL Error: ${error.message}

**Debugging Tips:**
- Use 'list_tables' to see available tables
- Use 'get_schema' to check column names
- Use table aliases: SELECT p.NAME FROM INV_INVESTMENTS p
- Add WITH(NOLOCK) for performance`;
  }
}

// ============================================================================
// SCHEMA DISCOVERY
// ============================================================================
async function getObjectSchema(objectCode: string): Promise<string> {
  const obj = clarityObjects.get(objectCode.toUpperCase());
  
  if (!obj) {
    return `Object '${objectCode}' not found. Use 'list_tables' to see available objects.`;
  }

  try {
    const db = await getPool();
    
    // Check if table exists
    const checkQuery = `SELECT OBJECT_ID('${obj.tableName}') as TableExists`;
    const check = await db.request().query(checkQuery);
    
    if (!check.recordset[0]?.TableExists) {
      return `Table '${obj.tableName}' (for object ${objectCode}) does not exist in database.`;
    }
    
    // Get schema
    const schemaQuery = `
      SELECT 
        COLUMN_NAME,
        DATA_TYPE,
        CHARACTER_MAXIMUM_LENGTH,
        IS_NULLABLE,
        COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = '${obj.tableName}'
      ORDER BY ORDINAL_POSITION
    `;
    
    const result = await db.request().query(schemaQuery);
    
    if (result.recordset.length === 0) {
      return `No schema information found for table '${obj.tableName}'`;
    }
    
    return JSON.stringify({
      objectCode: obj.objectCode,
      objectName: obj.objectName,
      tableName: obj.tableName,
      columns: result.recordset.map((col: any) => ({
        name: col.COLUMN_NAME,
        type: col.DATA_TYPE,
        maxLength: col.CHARACTER_MAXIMUM_LENGTH,
        nullable: col.IS_NULLABLE === 'YES',
        default: col.COLUMN_DEFAULT
      }))
    }, null, 2);

  } catch (error: any) {
    return `Error getting schema: ${error.message}`;
  }
}

// ============================================================================
// AI AGENT
// ============================================================================
async function runAIAgentLoop(
  userMessage: string,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return 'AI API not configured';
  }
  
  // Ensure objects loaded
  if (clarityObjects.size === 0) {
    await loadClarityObjects();
  }

  const systemPrompt = `You are a Clarity PPM SQL Expert (Bulletproof Mode).

🎯 YOUR CAPABILITIES:
- Direct SQL access for data analysis
- Schema discovery for any object
- Table mapping for all Clarity objects

🔑 RULES:
1. Check 'list_tables' to see available objects
2. Use 'get_schema' before writing SQL
3. Always use table aliases: SELECT p.NAME FROM INV_INVESTMENTS p
4. Add WITH(NOLOCK) for performance
5. Common tables:
   - Projects: INV_INVESTMENTS
   - Resources: SRM_RESOURCES
   - Tasks: PRTASK
   - Timesheets: PRTIMESHEET

💡 EXAMPLES:
Q: "How many projects?"
A: run_sql("SELECT COUNT(*) as total FROM INV_INVESTMENTS WITH(NOLOCK)")

Q: "Projects by manager"
A: 
1. get_schema(project)
2. run_sql("SELECT MANAGER_ID, COUNT(*) FROM INV_INVESTMENTS GROUP BY MANAGER_ID")`;

  const tools: any[] = [
    {
      type: 'function',
      function: {
        name: 'run_sql',
        description: 'Execute a SELECT query to analyze data',
        parameters: {
          type: 'object',
          properties: {
            sqlQuery: { type: 'string', description: 'Complete SELECT query' }
          },
          required: ['sqlQuery']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_schema',
        description: 'Get columns for an object. Check this before writing SQL!',
        parameters: {
          type: 'object',
          properties: {
            objectCode: { type: 'string', description: 'Object code like project, task, resource' }
          },
          required: ['objectCode']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_tables',
        description: 'List all available objects and their database tables',
        parameters: { type: 'object', properties: {} }
      }
    }
  ];

  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  const MAX_ITERATIONS = 10;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Processing... (${iteration}/${MAX_ITERATIONS})` });

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
    const message = data.choices[0]?.message;

    if (!message) {
      throw new Error('Invalid AI response');
    }

    if (message.tool_calls?.length > 0) {
      messages.push(message);

      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        sendUpdate({ type: 'tool', data: `🔧 ${functionName}` });

        let result = '';

        try {
          if (functionName === 'run_sql') {
            result = await executeDynamicQuery(functionArgs.sqlQuery);
          }
          else if (functionName === 'get_schema') {
            result = await getObjectSchema(functionArgs.objectCode);
          }
          else if (functionName === 'list_tables') {
            const tables: string[] = [];
            clarityObjects.forEach((obj) => {
              tables.push(`${obj.objectCode}: ${obj.objectName} → ${obj.tableName}`);
            });
            result = tables.slice(0, 100).join('\n');
            if (tables.length > 100) {
              result += `\n... (${tables.length} total objects, showing first 100)`;
            }
          }
          else {
            result = `Unknown tool: ${functionName}`;
          }

          sendUpdate({ type: 'step', data: '✅ Completed' });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });

        } catch (error: any) {
          sendUpdate({ type: 'step', data: `❌ ${error.message}` });
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Error: ${error.message}`
          });
        }
      }
      
      continue; // Continue loop to get AI's response
    }

    // No more tool calls - we have final answer
    if (message.content) {
      sendUpdate({ type: 'complete', data: message.content });
      return message.content;
    }
    
    break;
  }

  return 'Reached maximum iterations';
}

// ============================================================================
// HTTP SERVER
// ============================================================================
async function startHTTPServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3001');
  
  app.use(express.json());
  
  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
  });

  // Initialize
  await getPool();
  await loadClarityObjects();

  // Chat endpoint
  app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // BYPASS AUTH - Guest mode always works
      sendUpdate({ type: 'info', data: '🔓 Guest Mode (Auth Bypassed)' });

      await runAIAgentLoop(message, sendUpdate);
      
    } catch (error: any) {
      sendUpdate({ type: 'error', data: error.message });
    }

    res.end();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ready',
      version: 'v4.0-bulldozer',
      database: pool?.connected ? 'connected' : 'disconnected',
      objects: clarityObjects.size,
      features: ['hardcoded-tables', 'no-auth', 'dynamic-sql', 'bulletproof']
    });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('==========================================================');
    console.log(`🚀 Clarity MCP v4.0 RUNNING`);
    console.log(`📡 Endpoint: http://localhost:${PORT}/api/chat`);
    console.log(`🏥 Health: http://localhost:${PORT}/health`);
    console.log(`📊 Objects: ${clarityObjects.size} loaded`);
    console.log(`🔓 Auth: BYPASSED (Guest Mode)`);
    console.log(`🛡️ Mode: BULLETPROOF`);
    console.log('==========================================================');
    console.log('');
  });
}

// Start server
startHTTPServer().catch((error) => {
  console.error('❌ Fatal Error:', error);
  process.exit(1);
});
