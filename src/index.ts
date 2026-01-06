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
const MAX_ITERATIONS = 15; // More iterations for complex workflows

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
// SESSION & PERMISSIONS
// ============================================================================
interface UserSession {
  userId: string;
  userName: string;
  cookies: string;
  permissions: Map<string, ObjectPermissions>; // objectCode -> permissions
  isAdmin: boolean;
}

interface ObjectPermissions {
  objectCode: string;
  objectName: string;
  canRead: boolean;
  canWrite: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canExecute: boolean;
}

// ============================================================================
// DYNAMIC OBJECT DISCOVERY
// ============================================================================
interface ClarityObject {
  objectCode: string;
  objectName: string;
  tableName: string;
  objectType: string; // 'OBJECT', 'MENU', 'ACTION', etc.
  description: string;
}

interface ClarityAction {
  actionCode: string;
  actionName: string;
  objectCode: string;
  actionType: string; // 'CREATE', 'UPDATE', 'DELETE', 'CUSTOM'
  nsql: string | null;
}

// Cache for objects and actions
let clarityObjects: Map<string, ClarityObject> = new Map();
let clarityActions: Map<string, ClarityAction[]> = new Map();
let objectsLoaded = false;

// Load all Clarity objects from metadata tables
async function loadClarityObjects() {
  if (objectsLoaded) return;
  
  try {
    const db = await getPool();
    
    // Get all objects from CMN_SEC_OBJECTS
    const objectsResult = await db.request().query(`
      SELECT 
        o.OBJECT_CODE,
        o.OBJECT_NAME,
        o.OBJECT_TYPE,
        o.TABLE_NAME,
        o.DESCRIPTION
      FROM CMN_SEC_OBJECTS o
      WHERE o.IS_ACTIVE = 1
      ORDER BY o.OBJECT_NAME
    `);

    console.log(`[Objects] Loaded ${objectsResult.recordset.length} Clarity objects`);

    objectsResult.recordset.forEach((obj: any) => {
      clarityObjects.set(obj.OBJECT_CODE, {
        objectCode: obj.OBJECT_CODE,
        objectName: obj.OBJECT_NAME,
        tableName: obj.TABLE_NAME,
        objectType: obj.OBJECT_TYPE,
        description: obj.DESCRIPTION || ''
      });
    });

    // Get all actions from CMN_SEC_ACTIONS (if exists)
    try {
      const actionsResult = await db.request().query(`
        SELECT 
          a.ACTION_CODE,
          a.ACTION_NAME,
          a.OBJECT_CODE,
          a.ACTION_TYPE,
          a.NSQL
        FROM CMN_SEC_ACTIONS a
        WHERE a.IS_ACTIVE = 1
      `);

      console.log(`[Actions] Loaded ${actionsResult.recordset.length} actions`);

      actionsResult.recordset.forEach((action: any) => {
        if (!clarityActions.has(action.OBJECT_CODE)) {
          clarityActions.set(action.OBJECT_CODE, []);
        }
        clarityActions.get(action.OBJECT_CODE)!.push({
          actionCode: action.ACTION_CODE,
          actionName: action.ACTION_NAME,
          objectCode: action.OBJECT_CODE,
          actionType: action.ACTION_TYPE,
          nsql: action.NSQL
        });
      });
    } catch (error: any) {
      console.log('[Actions] CMN_SEC_ACTIONS not available, using basic CRUD');
    }

    objectsLoaded = true;
  } catch (error: any) {
    console.error('[Objects] Error loading:', error.message);
  }
}

// Get user permissions for all objects
async function getUserPermissions(userId: string): Promise<UserSession['permissions']> {
  try {
    const db = await getPool();

    // Check if admin
    const adminCheck = await db.request()
      .input('userId', userId)
      .query(`
        SELECT COUNT(*) as is_admin
        FROM CMN_SEC_USER_GROUPS ug
        INNER JOIN CMN_SEC_GROUPS g ON g.ID = ug.GROUP_ID
        WHERE ug.USER_ID = @userId
        AND (g.GROUP_NAME LIKE '%Admin%' OR g.GROUP_NAME LIKE '%System%')
      `);

    const isAdmin = adminCheck.recordset[0].is_admin > 0;

    const permissions = new Map<string, ObjectPermissions>();

    if (isAdmin) {
      // Admin has all permissions on all objects
      clarityObjects.forEach((obj) => {
        permissions.set(obj.objectCode, {
          objectCode: obj.objectCode,
          objectName: obj.objectName,
          canRead: true,
          canWrite: true,
          canUpdate: true,
          canDelete: true,
          canExecute: true
        });
      });
      console.log('[Permissions] User is admin - full access to all objects');
      return permissions;
    }

    // Get specific permissions
    const permsResult = await db.request()
      .input('userId', userId)
      .query(`
        SELECT DISTINCT
          ar.OBJECT_CODE,
          o.OBJECT_NAME,
          MAX(CAST(ar.CAN_READ as INT)) as CAN_READ,
          MAX(CAST(ar.CAN_WRITE as INT)) as CAN_WRITE,
          MAX(CAST(ar.CAN_UPDATE as INT)) as CAN_UPDATE,
          MAX(CAST(ar.CAN_DELETE as INT)) as CAN_DELETE,
          MAX(CAST(ar.CAN_EXECUTE as INT)) as CAN_EXECUTE
        FROM CMN_SEC_ACCESS_RIGHTS ar
        INNER JOIN CMN_SEC_OBJECTS o ON o.OBJECT_CODE = ar.OBJECT_CODE
        WHERE ar.PRINCIPAL_ID IN (
          SELECT GROUP_ID FROM CMN_SEC_USER_GROUPS WHERE USER_ID = @userId
          UNION
          SELECT @userId
        )
        AND ar.IS_ACTIVE = 1
        GROUP BY ar.OBJECT_CODE, o.OBJECT_NAME
      `);

    permsResult.recordset.forEach((perm: any) => {
      permissions.set(perm.OBJECT_CODE, {
        objectCode: perm.OBJECT_CODE,
        objectName: perm.OBJECT_NAME,
        canRead: perm.CAN_READ === 1,
        canWrite: perm.CAN_WRITE === 1,
        canUpdate: perm.CAN_UPDATE === 1,
        canDelete: perm.CAN_DELETE === 1,
        canExecute: perm.CAN_EXECUTE === 1
      });
    });

    console.log(`[Permissions] Loaded permissions for ${permissions.size} objects`);
    return permissions;

  } catch (error: any) {
    console.error('[Permissions] Error:', error.message);
    return new Map();
  }
}

// Extract user from session or credentials
async function getUserFromSession(session: any): Promise<string | null> {
  try {
    // Method 1: Try username/password authentication
    if (session?.username && session?.password) {
      console.log('[Auth] Authenticating with username/password:', session.username);
      
      const db = await getPool();
      const result = await db.request()
        .input('username', session.username)
        .query(`
          SELECT TOP 1 USER_ID, USER_NAME
          FROM CMN_SEC_USERS
          WHERE USER_NAME = @username
          AND IS_ACTIVE = 1
        `);

      if (result.recordset.length > 0) {
        console.log('[Auth] ✅ User found:', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID;
      } else {
        console.warn('[Auth] ❌ User not found:', session.username);
        return null;
      }
    }

    // Method 2: Try session cookies
    if (session?.cookies) {
      const sessionMatch = session.cookies.match(/JSESSIONID=([^;]+)/);
      if (!sessionMatch) return null;

      const sessionId = sessionMatch[1];
      const db = await getPool();
      
      const result = await db.request()
        .input('sessionId', sessionId)
        .query(`
          SELECT TOP 1 u.USER_ID, u.USER_NAME
          FROM CMN_SEC_USERS u
          INNER JOIN CMN_SEC_USER_SESSIONS s ON s.USER_ID = u.USER_ID
          WHERE s.SESSION_ID = @sessionId
          AND s.LAST_UPDATED_DATE > DATEADD(hour, -24, GETDATE())
        `);

      if (result.recordset.length > 0) {
        console.log('[Auth] ✅ User:', result.recordset[0].USER_NAME);
        return result.recordset[0].USER_ID;
      }
    }

    return null;
  } catch (error: any) {
    console.error('[Auth] Error:', error.message);
    return null;
  }
}

// ============================================================================
// CURRENT PAGE CONTEXT
// ============================================================================
interface PageContext {
  pageType: string; // 'project', 'task', 'resource', 'timesheet', etc.
  objectCode: string;
  objectId: string | null;
  objectName: string | null;
  url: string;
}

async function getPageObjectDetails(context: PageContext, session: UserSession): Promise<string> {
  if (!context.objectId) {
    return 'No object ID found on current page';
  }

  // Check permission
  const perm = session.permissions.get(context.objectCode);
  if (!perm?.canRead) {
    return `❌ You don't have READ permission for ${context.objectCode}`;
  }

  const obj = clarityObjects.get(context.objectCode);
  if (!obj || !obj.tableName) {
    return `Object ${context.objectCode} not found or has no table`;
  }

  try {
    const db = await getPool();
    
    // Get all columns for this table
    const columnsResult = await db.request()
      .input('tableName', obj.tableName)
      .query(`
        SELECT COLUMN_NAME, DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION
      `);

    const columns = columnsResult.recordset.map((c: any) => c.COLUMN_NAME).join(', ');

    // Get the actual record
    const dataResult = await db.request()
      .input('id', context.objectId)
      .query(`
        SELECT TOP 1 ${columns}
        FROM ${obj.tableName} WITH(NOLOCK)
        WHERE ID = @id OR PRID = @id
      `);

    if (dataResult.recordset.length === 0) {
      return `No data found for ${context.objectCode} with ID ${context.objectId}`;
    }

    return JSON.stringify(dataResult.recordset[0], null, 2);

  } catch (error: any) {
    return `Error getting object details: ${error.message}`;
  }
}

// ============================================================================
// DYNAMIC TOOL GENERATION
// ============================================================================
function generateDynamicTools(session: UserSession | null): Tool[] {
  const tools: Tool[] = [];

  // Base tools (always available)
  tools.push(
    {
      name: 'get_current_page_details',
      description: 'Get full details of the object on the current page (project, task, resource, etc.)',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'list_available_objects',
      description: 'List all Clarity objects the user has access to',
      inputSchema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'get_object_actions',
      description: 'Get all available actions for a specific object type',
      inputSchema: {
        type: 'object',
        properties: {
          objectCode: { type: 'string', description: 'Object code like odf_ca_project, odf_ca_task' }
        },
        required: ['objectCode']
      }
    }
  );

  // If no session, return basic tools only
  if (!session) {
    tools.push(
      {
        name: 'query_data',
        description: 'Query data from any table',
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
      }
    );
    return tools;
  }

  // Generate tools based on user permissions
  session.permissions.forEach((perm, objectCode) => {
    const obj = clarityObjects.get(objectCode);
    if (!obj || !obj.tableName) return;

    // READ tool
    if (perm.canRead) {
      tools.push({
        name: `read_${objectCode.toLowerCase()}`,
        description: `Read ${obj.objectName} data (you have READ permission)`,
        inputSchema: {
          type: 'object',
          properties: {
            columns: { type: 'array', items: { type: 'string' } },
            where: { type: 'object' },
            limit: { type: 'number' }
          },
          required: []
        }
      });
    }

    // CREATE tool
    if (perm.canWrite) {
      tools.push({
        name: `create_${objectCode.toLowerCase()}`,
        description: `Create new ${obj.objectName} (you have WRITE permission)`,
        inputSchema: {
          type: 'object',
          properties: {
            data: { type: 'object', description: 'Fields and values for new record' }
          },
          required: ['data']
        }
      });
    }

    // UPDATE tool
    if (perm.canUpdate) {
      tools.push({
        name: `update_${objectCode.toLowerCase()}`,
        description: `Update ${obj.objectName} (you have UPDATE permission)`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Record ID to update' },
            data: { type: 'object', description: 'Fields to update' }
          },
          required: ['id', 'data']
        }
      });
    }

    // DELETE tool
    if (perm.canDelete) {
      tools.push({
        name: `delete_${objectCode.toLowerCase()}`,
        description: `Delete ${obj.objectName} (you have DELETE permission)`,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Record ID to delete' }
          },
          required: ['id']
        }
      });
    }

    // CUSTOM ACTIONS
    const actions = clarityActions.get(objectCode);
    if (actions && perm.canExecute) {
      actions.forEach(action => {
        tools.push({
          name: `action_${action.actionCode.toLowerCase()}`,
          description: `Execute: ${action.actionName} on ${obj.objectName}`,
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Record ID' },
              parameters: { type: 'object', description: 'Action parameters' }
          },
            required: ['id']
          }
        });
      });
    }
  });

  console.log(`[Tools] Generated ${tools.length} dynamic tools`);
  return tools;
}

// ============================================================================
// DYNAMIC TOOL EXECUTION
// ============================================================================
async function executeDynamicTool(
  toolName: string,
  args: any,
  session: UserSession | null,
  pageContext?: PageContext
): Promise<string> {
  
  // Special tools
  if (toolName === 'get_current_page_details') {
    if (!pageContext?.objectId || !session) {
      return 'No object on current page or not authenticated';
    }
    return await getPageObjectDetails(pageContext, session);
  }

  if (toolName === 'list_available_objects') {
    if (!session) {
      return 'Please authenticate first';
    }
    const available: string[] = [];
    session.permissions.forEach((perm, code) => {
      const obj = clarityObjects.get(code);
      if (obj) {
        const perms = [];
        if (perm.canRead) perms.push('READ');
        if (perm.canWrite) perms.push('CREATE');
        if (perm.canUpdate) perms.push('UPDATE');
        if (perm.canDelete) perms.push('DELETE');
        available.push(`${obj.objectName} (${code}): ${perms.join(', ')}`);
      }
    });
    return available.join('\n');
  }

  if (toolName === 'get_object_actions') {
    const actions = clarityActions.get(args.objectCode);
    if (!actions || actions.length === 0) {
      return `No custom actions found for ${args.objectCode}`;
    }
    return actions.map(a => `${a.actionName} (${a.actionCode}): ${a.actionType}`).join('\n');
  }

  // Parse tool name
  const parts = toolName.split('_');
  const action = parts[0]; // 'read', 'create', 'update', 'delete', 'action'
  const objectCode = parts.slice(1).join('_').toUpperCase();

  const obj = clarityObjects.get(objectCode);
  if (!obj || !obj.tableName) {
    return `Object ${objectCode} not found`;
  }

  // Check permission
  if (session) {
    const perm = session.permissions.get(objectCode);
    if (!perm) {
      return `❌ You don't have any permissions for ${obj.objectName}`;
    }

    switch (action) {
      case 'read':
        if (!perm.canRead) return `❌ No READ permission for ${obj.objectName}`;
        break;
      case 'create':
        if (!perm.canWrite) return `❌ No WRITE permission for ${obj.objectName}`;
        break;
      case 'update':
        if (!perm.canUpdate) return `❌ No UPDATE permission for ${obj.objectName}`;
        break;
      case 'delete':
        if (!perm.canDelete) return `❌ No DELETE permission for ${obj.objectName}`;
        break;
      case 'action':
        if (!perm.canExecute) return `❌ No EXECUTE permission for ${obj.objectName}`;
        break;
    }
  }

  // Execute action
  const db = await getPool();

  try {
    switch (action) {
      case 'read': {
        const cols = args.columns?.length ? args.columns.join(',') : '*';
        const limit = args.limit || 50;
        const req = db.request();
        
        const whereParts: string[] = [];
        if (args.where) {
          Object.entries(args.where).forEach(([key, val], idx) => {
            whereParts.push(`${key} = @p${idx}`);
            req.input(`p${idx}`, val);
          });
        }
        
        const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
        const query = `SELECT TOP ${limit} ${cols} FROM ${obj.tableName} WITH(NOLOCK) ${whereClause}`;
        
        console.log(`[SQL] ${query}`);
        const result = await req.query(query);
        
        return result.recordset.length === 0
          ? `No records found`
          : JSON.stringify(result.recordset, null, 2);
      }

      case 'create': {
        const req = db.request();
        const cols: string[] = [];
        const vals: string[] = [];
        
        Object.entries(args.data).forEach(([key, val], idx) => {
          cols.push(key);
          vals.push(`@v${idx}`);
          req.input(`v${idx}`, val);
        });
        
        const query = `INSERT INTO ${obj.tableName} (${cols.join(',')}) VALUES (${vals.join(',')})`;
        console.log(`[SQL] ${query}`);
        
        await req.query(query);
        return `✅ Created new ${obj.objectName}`;
      }

      case 'update': {
        const req = db.request();
        const updates: string[] = [];
        
        Object.entries(args.data).forEach(([key, val], idx) => {
          updates.push(`${key} = @u${idx}`);
          req.input(`u${idx}`, val);
        });
        
        req.input('id', args.id);
        const query = `UPDATE ${obj.tableName} SET ${updates.join(', ')} WHERE ID = @id OR PRID = @id`;
        
        console.log(`[SQL] ${query}`);
        const result = await req.query(query);
        
        return `✅ Updated ${result.rowsAffected[0]} record(s)`;
      }

      case 'delete': {
        const req = db.request();
        req.input('id', args.id);
        
        const query = `DELETE FROM ${obj.tableName} WHERE ID = @id OR PRID = @id`;
        console.log(`[SQL] ${query}`);
        
        const result = await req.query(query);
        return `✅ Deleted ${result.rowsAffected[0]} record(s)`;
      }

      case 'action': {
        const actionCode = parts.slice(1).join('_').toUpperCase();
        const action = clarityActions.get(objectCode)?.find(a => a.actionCode === actionCode);
        
        if (!action) {
          return `Action ${actionCode} not found`;
        }

        if (action.nsql) {
          // Execute NSQL/SQL
          const req = db.request();
          req.input('id', args.id);
          
          // Replace parameters in NSQL
          let nsql = action.nsql.replace(/@ID/g, '@id');
          
          console.log(`[SQL] ${nsql}`);
          const result = await req.query(nsql);
          
          return `✅ Executed ${action.actionName}: affected ${result.rowsAffected[0]} record(s)`;
        }

        return `Action ${action.actionName} has no NSQL defined`;
      }

      default:
        return `Unknown action: ${action}`;
    }

  } catch (error: any) {
    console.error(`[Tool Error]`, error);
    return `❌ Error: ${error.message}`;
  }
}

// ============================================================================
// AI AGENT WITH DYNAMIC TOOLS
// ============================================================================
async function runAIAgentLoop(
  userMessage: string,
  context: PageContext,
  session: UserSession | null,
  sendUpdate: (data: any) => void
) {
  if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
    return 'AI not configured';
  }

  // Load objects if not loaded
  await loadClarityObjects();

  // Generate tools based on user permissions
  const tools = generateDynamicTools(session);

  let permissionInfo = '';
  if (session) {
    const permsCount = session.permissions.size;
    permissionInfo = `\n\nAuthenticated as: ${session.userName}
You have access to ${permsCount} objects with various permissions.
Use 'list_available_objects' to see all available objects and permissions.

Current Page: ${context.pageType} (${context.objectCode || 'unknown'})
${context.objectId ? `Object ID: ${context.objectId}` : ''}

You can:
- Use 'get_current_page_details' to see full details of current object
- Use read_[object], create_[object], update_[object], delete_[object] tools
- All actions are permission-checked automatically`;
  }

  const systemPrompt = `You are a Clarity PPM Expert with access to ALL Clarity objects and actions.

${permissionInfo}

CRITICAL RULES:
1. ALWAYS check what user can do with 'list_available_objects'
2. Use 'get_current_page_details' when user asks about "this" or "current" object
3. Tool names are dynamic: read_[objectcode], create_[objectcode], etc.
4. Permissions are checked automatically - you'll get error if not allowed
5. Be helpful - suggest alternatives if user lacks permission

Available Tools: ${tools.length} tools dynamically generated based on permissions

Page context: ${JSON.stringify(context)}`;

  let messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ];

  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    sendUpdate({ type: 'thinking', data: `Processing... (${iteration}/${MAX_ITERATIONS})` });

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
          tools: tools.map(t => ({
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

      const data: any = await response.json();
      
      if (!data.choices?.[0]) {
        throw new Error('Invalid AI response');
      }
      
      const message: any = data.choices[0].message;

      if (message.tool_calls?.length > 0) {
        messages.push(message);

        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);

          sendUpdate({ type: 'tool', data: `🔧 ${functionName}` });

          try {
            const result = await executeDynamicTool(functionName, functionArgs, session, context);
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

  // Load objects on startup
  await loadClarityObjects();

  app.post('/api/chat', async (req, res) => {
    const { message, context, session } = req.body;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sendUpdate = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      let userSession: UserSession | null = null;

      if (session) {
        const userId = await getUserFromSession(session);
        
        if (userId) {
          const permissions = await getUserPermissions(userId);
          const isAdmin = Array.from(permissions.values()).every(p => 
            p.canRead && p.canWrite && p.canUpdate && p.canDelete
          );
          
          userSession = {
            userId,
            userName: context.userName || session.username || 'User',
            cookies: session.cookies || '',
            permissions,
            isAdmin
          };

          sendUpdate({ type: 'info', data: `🔐 ${userSession.userName} (${permissions.size} objects)` });
        } else {
          sendUpdate({ type: 'warning', data: '⚠️ Authentication failed - limited access' });
        }
      }

      await runAIAgentLoop(message, context, userSession, sendUpdate);
      
    } catch (error: any) {
      sendUpdate({ type: 'error', data: error.message });
    }

    res.end();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ready',
      database: pool?.connected ? 'connected' : 'disconnected',
      ai: OPENAI_API_KEY || ANTHROPIC_API_KEY ? 'enabled' : 'disabled',
      objects: clarityObjects.size,
      sessionAuth: 'enabled',
      dynamicTools: 'enabled'
    });
  });

  app.listen(PORT, async () => {
    console.error(`🚀 Clarity MCP with Dynamic Tools & Permissions`);
    console.error(`📡 Chat: http://localhost:${PORT}/api/chat`);
    console.error(`🎯 Objects: ${clarityObjects.size} loaded`);
    console.error(`✅ Ready!`);
  });
}

async function main() {
  await getPool();
  await startHTTPServer();
}

main().catch(console.error);
