#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js';
// @ts-ignore
import sql from 'mssql';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// AI Configuration
// ============================================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_PROVIDER = process.env.AI_PROVIDER || 'openai';
const MAX_ITERATIONS = 10;

// ============================================================================
// Database Config
// ============================================================================
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
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000
  }
};

let pool: sql.ConnectionPool | null = null;

async function getPool() {
  if (pool?.connected) return pool;
  try {
    pool = await new sql.ConnectionPool(DB_CONFIG).connect();
    console.error('✅ Database Connected (Pool Ready)');
    pool.on('error', (err: any) => console.error('Pool Error:', err));
    return pool;
  } catch (err) {
    console.error('❌ DB Connection Failed:', err);
    throw err;
  }
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================
const TOOLS: Tool[] = [
  {
    name: 'read_records',
    description: 'Read data from tables with WHERE filter',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } },
        where: { type: 'object' },
        limit: { type: 'number' }
      },
      required: ['tableName']
    }
  },
  {
    name: 'aggregate_query',
    description: 'Perform counts/sums/averages with grouping, sorting, and limits',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: { type: 'string' },
        aggregations: { type: 'array', items: { type: 'string' } },
        where: { type: 'object' },
        groupBy: { type: 'string' },
        orderBy: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['tableName', 'aggregations']
    }
  },
  {
    name: 'update_records',
    description: 'Update a single record by ID',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: { type: 'string' },
        data: { type: 'object' },
        idColumn: { type: 'string' },
        idValue: { type: 'string' }
      },
      required: ['tableName', 'data', 'idColumn', 'idValue']
    }
  },
  {
    name: 'find_project',
    description: 'Smart project finder - automatically tries PREXTERNALID and PRNAME',
    inputSchema: {
      type: 'object',
      properties: {
        searchValue: { type: 'string' }
      },
      required: ['searchValue']
    }
  },
  {
    name: 'get_table_info',
    description: 'Get column names for a table',
    inputSchema: {
      type: 'object',
      properties: {
        tableName: { type: 'string' }
      },
      required: ['tableName']
    }
  }
];

// ============================================================================
// TOOL HANDLERS
// ============================================================================
async function handleReadRecords(args: any) {
  const db = await getPool();
  const req = db.request();

  const cols = args.columns?.length ? args.columns.join(',') : '*';
  const limit = args.limit || 20;
  
  const whereParts: string[] = [];
  if (args.where) {
    Object.entries(args.where).forEach(([key, val], idx) => {
      whereParts.push(`${key} = @p${idx}`);
      req.input(`p${idx}`, val);
    });
  }
  
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const query = `SELECT TOP ${limit} ${cols} FROM ${args.tableName} WITH(NOLOCK) ${whereClause}`;
  
  console.error(`[MCP] ⚡ SQL: ${query}`);
  const result = await req.query(query);
  
  return result.recordset.length === 0 
    ? `No records found in ${args.tableName}` 
    : JSON.stringify(result.recordset, null, 2);
}

async function handleAggregateQuery(args: any) {
  const db = await getPool();
  const req = db.request();

  const aggs = args.aggregations.join(',');
  const whereParts: string[] = [];
  
  if (args.where) {
    Object.entries(args.where).forEach(([key, val], idx) => {
      whereParts.push(`${key} = @p${idx}`);
      req.input(`p${idx}`, val);
    });
  }
  
  const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const groupClause = args.groupBy ? `GROUP BY ${args.groupBy}` : '';
  const orderClause = args.orderBy ? `ORDER BY ${args.orderBy}` : '';
  const limitClause = args.limit ? `TOP ${args.limit}` : '';
  
  const query = `SELECT ${limitClause} ${aggs} FROM ${args.tableName} WITH(NOLOCK) ${whereClause} ${groupClause} ${orderClause}`.replace(/\s+/g, ' ').trim();
  
  console.error(`[MCP] ⚡ SQL: ${query}`);
  const result = await req.query(query);
  
  return JSON.stringify(result.recordset, null, 2);
}

async function handleUpdateRecords(args: any) {
  const db = await getPool();
  const req = db.request();

  const updates: string[] = [];
  Object.entries(args.data).forEach(([key, val], idx) => {
    updates.push(`${key} = @u${idx}`);
    req.input(`u${idx}`, val);
  });

  req.input('idVal', args.idValue);
  const query = `UPDATE ${args.tableName} SET ${updates.join(', ')} WHERE ${args.idColumn} = @idVal`;
  
  console.error(`[MCP] ⚡ SQL: ${query}`);
  const result = await req.query(query);
  
  return `Updated ${result.rowsAffected[0]} record(s)`;
}

async function handleFindProject(args: any) {
  const db = await getPool();
  const searchValue = args.searchValue;
  
  for (const field of ['PREXTERNALID', 'PRNAME']) {
    try {
      const req = db.request();
      req.input('value', searchValue);
      
      const query = `SELECT TOP 1 PRID, PRNAME, PREXTERNALID FROM PRPROJECT WITH(NOLOCK) WHERE ${field} = @value`;
      
      console.error(`[MCP] ⚡ Trying ${field}: ${query}`);
      const result = await req.query(query);
      
      if (result.recordset.length > 0) {
        const project = result.recordset[0];
        console.error(`[MCP] ✅ Found via ${field}`);
        return `Found project: ${project.PRNAME} (External ID: ${project.PREXTERNALID}, Internal ID: ${project.PRID})`;
      }
    } catch (error: any) {
      continue;
    }
  }
  
  return `No project found: "${searchValue}"`;
}

async function handleGetTableInfo(args: any) {
  const db = await getPool();
  const req = db.request();

  req.input('tableName', args.tableName);
  const query = `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName`;
  
  const result = await req.query(query);
  const columns = result.recordset.map((row: any) => row.COLUMN_NAME);
  
  return columns.length ? `Columns: ${columns.join(', ')}` : 'Table not found';
}

// ============================================================================
// AI AGENT WITH LOOP
// ============================================================================
async function runAIAgentLoop(userMessage: string, context: any, sendUpdate: (data: any) => void) {
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return handleBasicQuery(userMessage);
  }

  const systemPrompt = `You are a Clarity PPM SQL Expert.

🔥 **CRITICAL RULES (DO NOT VIOLATE):**

1. **The "Look up Name" Rule:**
   - When you have an ID from a previous step (like an aggregation), you **MUST** use that ID in the 'where' clause to get the name.
   - ❌ WRONG: read_records(tableName="inv_investments", limit=1)
   - ✅ RIGHT: read_records(tableName="inv_investments", where={"ID": 5001003})

2. **Update Syntax:** 
   - You **MUST** provide the 'data' parameter.
   - WRONG: update_records(..., idValue="501") 
   - RIGHT: update_records(..., idValue="501", data={"PRPCTCOMPLETE": 1}) (For 1%)

3. **Project IDs:**
   - 'PRPROJECTID' in 'prtask' is a **NUMBER**.
   - First find the project ID using 'find_project', THEN use that number to query 'prtask'.

4. **Safety Block:**
   - NEVER call 'read_records' without a 'where' clause.
   - NEVER call 'update_records' unless the user explicitly asks to modify data.

5. **Status Filtering:**
   - PRSTATUS is a numeric lookup ID (like 5020009, 5020012, etc.)
   - To filter by status name (like "completed"), you need to find common status patterns
   - Try filtering by completion: PRPCTCOMPLETE = 100 for completed tasks
   - Or use read_records to sample and understand which PRSTATUS values exist

TABLE CHEAT SHEET:
- **Tasks**: prtask (PRID, PRPROJECTID, PRNAME, PRSTATUS, PRPCTCOMPLETE)
   * PRPCTCOMPLETE: Number (0 to 100). 1% = 1, 100% = 100.
   * PRSTATUS: Numeric lookup ID
- **Projects**: inv_investments (ID, CODE, NAME, IS_ACTIVE)

Page context: ${JSON.stringify(context)}`;

  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    
    // Better thinking message
    let thinkingMsg = iteration === 1 
      ? '💭 Analyzing your question...' 
      : `💭 Processing results... (step ${iteration}/${MAX_ITERATIONS})`;
    
    sendUpdate({ type: 'thinking', data: thinkingMsg });

    if (AI_PROVIDER === 'openai' && OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: messages,
          tools: TOOLS.map(t => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema
            }
          })),
          tool_choice: 'auto'
        })
      });

      const data = await response.json();
      
      if (!data.choices || !data.choices[0]) {
        console.error('[OpenAI Error]:', data);
        throw new Error('Invalid OpenAI response');
      }
      
      const choice = data.choices[0];
      const message = choice.message;

      if (message.tool_calls && message.tool_calls.length > 0) {
        console.log(`[Agent calling ${message.tool_calls.length} tool(s)]`);
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);

          // Map tool names to readable descriptions
          const toolDescriptions: { [key: string]: string } = {
            'find_project': '🔍 Searching for project',
            'read_records': '📖 Reading data from database',
            'aggregate_query': '📊 Running aggregate query',
            'update_records': '✏️ Updating records',
            'get_table_info': 'ℹ️ Getting table structure'
          };

          const readableToolName = toolDescriptions[functionName] || `🔧 ${functionName}`;
          
          // Format arguments for display
          let argsDisplay = '';
          if (functionName === 'find_project' && functionArgs.searchValue) {
            argsDisplay = `: "${functionArgs.searchValue}"`;
          } else if (functionName === 'aggregate_query' && functionArgs.tableName) {
            argsDisplay = ` from ${functionArgs.tableName}`;
          } else if (functionName === 'read_records' && functionArgs.tableName) {
            argsDisplay = ` from ${functionArgs.tableName}`;
          }

          sendUpdate({ type: 'tool', data: `${readableToolName}${argsDisplay}` });
          console.log(`[Tool] ${functionName}:`, functionArgs);

          try {
            const result = await callToolDirectly(functionName, functionArgs);
            
            // Better success message
            const resultPreview = result.substring(0, 100);
            const hasData = result.includes('{') || result.includes('[');
            const successMsg = hasData ? '✅ Data retrieved' : '✅ Completed';
            
            sendUpdate({ type: 'step', data: successMsg });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result
            });
          } catch (error: any) {
            console.error(`[Tool Error]`, error);
            sendUpdate({ type: 'step', data: `❌ Error: ${error.message}` });
            
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${error.message}`
            });
          }
        }
        continue;
      }

      if (message.content) {
        sendUpdate({ type: 'complete', data: message.content });
        return message.content;
      }
      
      break;
    }
  }
  
  return 'Reached maximum iterations';
}

async function callToolDirectly(name: string, args: any): Promise<string> {
  switch (name) {
    case 'read_records':
      return await handleReadRecords(args);
    case 'aggregate_query':
      return await handleAggregateQuery(args);
    case 'update_records':
      return await handleUpdateRecords(args);
    case 'find_project':
      return await handleFindProject(args);
    case 'get_table_info':
      return await handleGetTableInfo(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function handleBasicQuery(message: string): string {
  if (message.toLowerCase().includes('project')) {
    return 'To use AI, add OPENAI_API_KEY or ANTHROPIC_API_KEY to .env';
  }
  return 'Basic mode only. Add API key for AI features.';
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

  // Chat endpoint with streaming
  app.post('/api/chat', async (req, res) => {
    const { message, context } = req.body;

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await runAIAgentLoop(message, context, sendUpdate);
    } catch (error: any) {
      sendUpdate({ type: 'error', data: error.message });
    }

    res.end();
  });

  // MCP endpoint
  app.post('/mcp', async (req, res) => {
    try {
      const request = req.body;
      
      if (request.method === 'tools/list') {
        return res.json({
          jsonrpc: '2.0',
          id: request.id,
          result: { tools: TOOLS }
        });
      }
      
      if (request.method === 'tools/call') {
        const result = await callToolDirectly(
          request.params.name,
          request.params.arguments
        );
        
        return res.json({
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: result }] }
        });
      }
      
      res.status(400).json({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' }
      });
    } catch (error: any) {
      res.status(500).json({
        jsonrpc: '2.0',
        id: req.body.id,
        error: { code: -32603, message: error.message }
      });
    }
  });

  // Health
  app.get('/health', (req, res) => {
    res.json({
      status: 'ready',
      database: pool?.connected ? 'connected' : 'disconnected',
      ai: OPENAI_API_KEY || ANTHROPIC_API_KEY ? 'enabled' : 'disabled'
    });
  });

  app.listen(PORT, async () => {
    console.error(`🚀 Clarity MCP + AI Server`);
    console.error(`📡 Chat API: http://localhost:${PORT}/api/chat`);
    console.error(`📡 MCP: http://localhost:${PORT}/mcp`);
    console.error(`❤️  Health: http://localhost:${PORT}/health`);
    console.error(`🤖 AI: ${AI_PROVIDER} ${OPENAI_API_KEY || ANTHROPIC_API_KEY ? '✅' : '❌'}`);
    
    await getPool();
    console.error('✅ Ready!');
  });
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  await startHTTPServer();
}

main().catch(console.error);
