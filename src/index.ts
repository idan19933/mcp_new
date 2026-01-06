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
  
  // Check for common MySQL syntax errors
  if (upperSQL.includes('LIMIT ')) {
    return `❌ SYNTAX ERROR: You used 'LIMIT' which is MySQL syntax!

MS SQL Server uses 'TOP' instead.

Your query: ${sqlQuery}

Fix: Replace 'LIMIT 10' with 'SELECT TOP 10'
Example: SELECT TOP 10 * FROM table ORDER BY column DESC`;
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
    
    // Provide helpful error messages
    let helpText = '';
    
    if (error.message.includes('Invalid column name')) {
      helpText = '\n\n💡 Tip: Use get_schema to check correct column names';
    }
    else if (error.message.includes('Invalid object name')) {
      helpText = '\n\n💡 Tip: Use list_tables to see available tables';
    }
    else if (error.message.includes('Incorrect syntax')) {
      helpText = '\n\n💡 Remember: Use TOP (not LIMIT), WITH(NOLOCK), and table aliases';
    }
    
    return `❌ SQL Error: ${error.message}${helpText}

**Common fixes:**
- Use SELECT TOP 10 (not LIMIT 10)
- Add WITH(NOLOCK) after table names
- Use table aliases: FROM INV_INVESTMENTS p
- Check schema first with get_schema`;
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
  if (!ANTHROPIC_API_KEY && !OPENAI_API_KEY) {
    return 'AI API not configured';
  }
  
  // Ensure objects loaded
  if (clarityObjects.size === 0) {
    await loadClarityObjects();
  }

  // --------------------------------------------------------------------------
  // ENHANCED SYSTEM PROMPT - MS SQL SERVER EXPERT
  // --------------------------------------------------------------------------
  const systemPrompt = `You are a Senior Clarity PPM Developer & MS SQL Server Expert.
  
  🎯 GOAL: Write accurate MS SQL Server queries to answer user questions about Clarity PPM data.

  🚨 CRITICAL SQL SYNTAX RULES (MS SQL SERVER - NOT MySQL!):
  
  1. **NEVER USE 'LIMIT'** - This is MySQL syntax and will crash MS SQL Server!
     ❌ BAD:  SELECT * FROM table LIMIT 5
     ✅ GOOD: SELECT TOP 5 * FROM table
  
  2. **Always use TOP for row limiting**:
     - SELECT TOP 10 * FROM table
     - SELECT TOP 5 NAME, CODE FROM table ORDER BY DATE DESC
  
  3. **Always add WITH(NOLOCK)** to prevent blocking:
     - SELECT * FROM INV_INVESTMENTS WITH(NOLOCK)
     - JOIN PRTASK t WITH(NOLOCK) ON ...
  
  4. **Always use table aliases**:
     - SELECT p.NAME FROM INV_INVESTMENTS p
     - JOIN PRTASK t ON p.ID = t.PRPROJECTID

  🔗 CLARITY PPM JOIN PATTERNS (MEMORIZE THESE!):
  
  **Projects to Tasks:**
  \`\`\`sql
  SELECT p.NAME, COUNT(t.PRID) as TaskCount
  FROM INV_INVESTMENTS p WITH(NOLOCK)
  LEFT JOIN PRTASK t WITH(NOLOCK) ON p.ID = t.PRPROJECTID
  GROUP BY p.NAME
  \`\`\`
  
  **Projects to Manager (Resource):**
  \`\`\`sql
  SELECT p.NAME, r.FULL_NAME as Manager
  FROM INV_INVESTMENTS p WITH(NOLOCK)
  LEFT JOIN SRM_RESOURCES r WITH(NOLOCK) ON p.MANAGER_ID = r.ID
  \`\`\`
  
  **Projects to Team Members:**
  \`\`\`sql
  SELECT p.NAME, r.FULL_NAME
  FROM INV_INVESTMENTS p WITH(NOLOCK)
  LEFT JOIN PRTEAM pt WITH(NOLOCK) ON p.ID = pt.PRPROJECTID
  LEFT JOIN SRM_RESOURCES r WITH(NOLOCK) ON pt.PRRESOURCEID = r.ID
  \`\`\`
  
  **Tasks to Timesheets:**
  \`\`\`sql
  SELECT t.PRNAME, SUM(ts.PRTOTALACTUAL) as Hours
  FROM PRTASK t WITH(NOLOCK)
  LEFT JOIN PRTIMESHEET ts WITH(NOLOCK) ON t.PRID = ts.PRTASKID
  GROUP BY t.PRNAME
  \`\`\`

  🔎 SEARCH STRATEGY:
  When user provides an identifier (like "123456" or "ProjectName"):
  1. Check both CODE and NAME columns
  2. Use OR condition: WHERE (p.CODE = '123456' OR p.NAME LIKE '%123456%')
  3. For partial matches, use LIKE with wildcards

  📊 COMMON CLARITY TABLES:
  - Projects: INV_INVESTMENTS (ID, CODE, NAME, MANAGER_ID, PLANNED_COST, STATUS)
  - Tasks: PRTASK (PRID, PRNAME, PRPROJECTID, PRSTATUS)
  - Resources: SRM_RESOURCES (ID, USER_NAME, FULL_NAME, EMAIL_ADDRESS)
  - Timesheets: PRTIMESHEET (PRID, PRTASKID, PRRESOURCEID, PRTOTALACTUAL)
  - Departments: CMN_DEPARTMENTS (ID, NAME, CODE)

  💡 CORRECT QUERY EXAMPLES:

  Q: "How many projects?"
  A: SELECT COUNT(*) as TotalProjects FROM INV_INVESTMENTS WITH(NOLOCK)

  Q: "Top 5 projects by budget"
  A: SELECT TOP 5 NAME, CODE, PLANNED_COST FROM INV_INVESTMENTS WITH(NOLOCK) ORDER BY PLANNED_COST DESC

  Q: "Tasks in project ABC123"
  A: 
  SELECT t.PRNAME, t.PRSTATUS
  FROM PRTASK t WITH(NOLOCK)
  JOIN INV_INVESTMENTS p WITH(NOLOCK) ON p.ID = t.PRPROJECTID
  WHERE (p.CODE = 'ABC123' OR p.NAME LIKE '%ABC123%')

  Q: "Total hours by resource"
  A:
  SELECT r.FULL_NAME, SUM(ts.PRTOTALACTUAL) as TotalHours
  FROM PRTIMESHEET ts WITH(NOLOCK)
  JOIN SRM_RESOURCES r WITH(NOLOCK) ON r.ID = ts.PRRESOURCEID
  GROUP BY r.FULL_NAME
  ORDER BY TotalHours DESC

  ⚠️ COMMON MISTAKES TO AVOID:
  1. Using LIMIT instead of TOP ← THIS WILL CRASH!
  2. Forgetting WITH(NOLOCK) ← Causes blocking
  3. Not using aliases ← Hard to read
  4. Wrong join columns ← Returns wrong data
  5. Forgetting to check both CODE and NAME ← Misses data

  🎯 WORKFLOW:
  1. If you're not sure about columns → use 'get_schema' first
  2. Write the SQL query using MS SQL Server syntax
  3. Use 'run_sql' to execute
  4. If error occurs, check syntax and try again`;

  const tools: any[] = [
    {
      name: 'run_sql',
      description: 'Execute a SELECT query to analyze Clarity data. Returns JSON results.',
      input_schema: {
        type: 'object',
        properties: {
          sqlQuery: {
            type: 'string',
            description: 'Complete MS SQL Server SELECT query'
          }
        },
        required: ['sqlQuery']
      }
    },
    {
      name: 'get_schema',
      description: 'Get columns and data types for a Clarity object. Use this before writing SQL!',
      input_schema: {
        type: 'object',
        properties: {
          objectCode: {
            type: 'string',
            description: 'Object code like project, task, resource, etc.'
          }
        },
        required: ['objectCode']
      }
    },
    {
      name: 'list_tables',
      description: 'List all available Clarity objects and their database tables',
      input_schema: {
        type: 'object',
        properties: {}
      }
    }
  ];

  let messages: any[] = [
    { role: 'user', content: userMessage }
  ];

  const MAX_ITERATIONS = 10;
  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Processing... (${iteration}/${MAX_ITERATIONS})` });

    // Use Anthropic API (Claude)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || OPENAI_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages,
        tools: tools
      })
    });

    const data: any = await response.json();
    
    if (!data.content) {
      throw new Error('Invalid AI response');
    }

    // Check if AI wants to use tools
    const toolUseBlocks = data.content.filter((block: any) => block.type === 'tool_use');
    
    if (toolUseBlocks.length > 0) {
      // AI is using tools
      messages.push({
        role: 'assistant',
        content: data.content
      });

      const toolResults: any[] = [];

      for (const toolBlock of toolUseBlocks) {
        const toolName = toolBlock.name;
        const toolInput = toolBlock.input;

        sendUpdate({ type: 'tool', data: `🔧 ${toolName}` });

        let result = '';

        try {
          if (toolName === 'run_sql') {
            result = await executeDynamicQuery(toolInput.sqlQuery);
          }
          else if (toolName === 'get_schema') {
            result = await getObjectSchema(toolInput.objectCode);
          }
          else if (toolName === 'list_tables') {
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
            result = `Unknown tool: ${toolName}`;
          }

          sendUpdate({ type: 'step', data: '✅ Completed' });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: result
          });

        } catch (error: any) {
          sendUpdate({ type: 'step', data: `❌ ${error.message}` });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: `Error: ${error.message}`,
            is_error: true
          });
        }
      }

      // Add tool results to messages
      messages.push({
        role: 'user',
        content: toolResults
      });
      
      continue; // Continue loop to get AI's response
    }

    // No more tool calls - we have final answer
    const textBlocks = data.content.filter((block: any) => block.type === 'text');
    if (textBlocks.length > 0) {
      const finalAnswer = textBlocks.map((block: any) => block.text).join('\n');
      sendUpdate({ type: 'complete', data: finalAnswer });
      return finalAnswer;
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
      // Check if user logged in via extension
      let loggedInUser = null;
      
      if (session?.username && session?.password) {
        // User logged in via extension form
        loggedInUser = session.username;
        sendUpdate({ type: 'info', data: `✅ Logged in as ${loggedInUser}` });
      } else if (session?.cookies) {
        // User might be logged in via Clarity session
        sendUpdate({ type: 'info', data: '🔐 Using Clarity session' });
      } else {
        // Guest mode
        sendUpdate({ type: 'info', data: '🔓 Guest Mode' });
      }

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
